// bb-plugin-voice-fast: voice input service for bb backed by ElevenLabs Scribe.
//
// Attempts: scribe_v2 with vocabulary (if the hint carries one), scribe_v2
// without it, then scribe_v1. A vocabulary hint looks like
// "Vocabulary: word, word" (or the Russian "Словарь: ..."); the words are sent
// to ElevenLabs as `keyterms`.
//
// API key: ELEVENLABS_API_KEY from the environment, or a line
// ELEVENLABS_API_KEY=... in the file from ELEVENLABS_KEY_FILE
// (default ~/.config/bb-voice-fast/elevenlabs.env). The key is read on every
// call and never copied anywhere.
// Language: VOICE_LANGUAGE (ISO 639 code such as "rus" or "eng"); empty means
// automatic detection.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi, PluginAiServiceStatus } from "@get-bb/plugin-sdk";

const KEY_NAME = "ELEVENLABS_API_KEY";
const KEY_FILE =
  process.env.ELEVENLABS_KEY_FILE?.trim() ||
  join(homedir(), ".config/bb-voice-fast/elevenlabs.env");
const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const MODELS = ["scribe_v2", "scribe_v1"] as const;
const LANGUAGE = process.env.VOICE_LANGUAGE?.trim() ?? "";
const MAX_BYTES = 1024 * 1024 * 1024;
const VOCABULARY_PREFIXES = ["Vocabulary:", "Словарь:"];
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_LENGTH = 50;
const MAX_KEYTERM_SPACES = 4;
const FORBIDDEN_KEYTERM = /[<>{}[\]\\]/u;

function keytermsFromHint(hint: string | null | undefined): string[] {
  const text = (hint ?? "").trim();
  const prefix = VOCABULARY_PREFIXES.find((candidate) =>
    text.startsWith(candidate),
  );
  if (!prefix) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.slice(prefix.length).split(",")) {
    const term = raw.replace(/\s+/g, " ").trim();
    if (!term || term.length > MAX_KEYTERM_LENGTH || FORBIDDEN_KEYTERM.test(term)) continue;
    if ((term.match(/ /g)?.length ?? 0) > MAX_KEYTERM_SPACES) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_KEYTERMS) break;
  }
  return terms;
}

const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};
const KNOWN_EXT = new Set(["webm", "ogg", "opus", "m4a", "mp4", "mp3", "wav", "flac"]);

async function readKeyFile(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith(`${KEY_NAME}=`)) continue;
      const value = line
        .slice(KEY_NAME.length + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (value) return value;
    }
  } catch {
    // missing file: the service reports "not ready"
  }
  return null;
}

async function readKey(): Promise<string | null> {
  const fromEnv = process.env[KEY_NAME]?.trim();
  if (fromEnv) return fromEnv;
  return readKeyFile(KEY_FILE);
}

function uploadName(audio: File): string {
  const fromName = (audio.name || "").split(".").pop()?.toLowerCase() ?? "";
  if (KNOWN_EXT.has(fromName)) return `voice.${fromName}`;
  const mime = (audio.type || "").split(";")[0]!.trim().toLowerCase();
  return `voice.${EXT_BY_MIME[mime] ?? "webm"}`;
}

async function scribe(
  key: string,
  model: string,
  audio: File,
  keyterms: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append("file", audio, uploadName(audio));
  form.append("model_id", model);
  if (LANGUAGE) form.append("language_code", LANGUAGE);
  form.append("tag_audio_events", "false");
  form.append("timestamps_granularity", "none");
  for (const term of keyterms) form.append("keyterms", term);
  const response = await fetch(STT_URL, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
    signal,
  });
  const body = await response.text();
  if (!response.ok) {
    throw Object.assign(
      new Error(`${model}: HTTP ${response.status} ${body.slice(0, 200)}`),
      { status: response.status },
    );
  }
  const text = (JSON.parse(body) as { text?: unknown }).text;
  if (typeof text !== "string") throw new Error(`${model}: empty response`);
  return text.trim();
}

export default function plugin(bb: BbPluginApi) {
  bb.experimental_aiServices.register({
    id: "elevenlabs",
    displayName: "ElevenLabs",
    async transcribe(audio, { signal, hint }) {
      const started = Date.now();
      const key = await readKey();
      if (!key) throw new Error(`Set ${KEY_NAME} (environment variable or ${KEY_FILE})`);
      if (audio.size > MAX_BYTES) throw new Error("Recording is too large");
      const errors: string[] = [];
      const keyterms = keytermsFromHint(hint);
      const attempts: { model: string; keyterms: readonly string[] }[] = [
        ...(keyterms.length > 0 ? [{ model: MODELS[0], keyterms }] : []),
        ...MODELS.map((model) => ({ model, keyterms: [] as string[] })),
      ];
      for (const { model, keyterms: terms } of attempts) {
        if (signal.aborted) break;
        try {
          const text = await scribe(key, model, audio, terms, signal);
          bb.log.info(
            `voice ok: ${model}${terms.length ? ` +${terms.length} keyterms` : ""}, ${audio.size} B ${audio.type || "?"}, ${Date.now() - started} ms${errors.length ? ` after ${errors.length} failed` : ""}`,
          );
          return text;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(message);
          bb.log.warn(`voice attempt failed: ${message}`);
          const status = (error as { status?: unknown }).status;
          if (status === 401 || status === 402 || status === 403 || status === 429) break;
        }
      }
      throw new Error(`ElevenLabs transcription failed: ${errors.join(" | ")}`);
    },
    async status(): Promise<PluginAiServiceStatus> {
      return (await readKey())
        ? { ready: true }
        : { ready: false, message: `Set ${KEY_NAME} (environment variable or ${KEY_FILE})` };
    },
  });
}
