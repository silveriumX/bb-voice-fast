# bb voice: fast and loss-proof voice input

Two parts that make voice input in [bb](https://getbb.app) fast and reliable, especially from a phone:

1. **`plugin/`** — a bb plugin (`voice-fast`) that transcribes voice input with
   [ElevenLabs Scribe](https://elevenlabs.io/speech-to-text). Typical speed:
   ~1 s for a short phrase, ~3–6 s for a minute of speech. Long recordings are fine.
2. **`patches/bb-voice-reliability.patch`** — a patch for the bb app source that
   makes sure a recording is never lost:
   - audio is saved on the device every 2 s while you speak (and immediately when
     the screen turns off or the app goes to background); after a reload or crash
     the recording is restored and transcribed automatically;
   - transcription retries by itself when the connection drops (4 attempts,
     waits for the network, gives up on a hung request after a timeout);
   - cancelling during transcription keeps the recording instead of deleting it;
   - restored recordings only insert text into the composer, they never send by themselves.

## Install the plugin

```bash
git clone https://github.com/silveriumX/bb-voice-fast.git
cd bb-voice-fast/plugin
bb plugin install .
mkdir -p ~/.config/bb-voice-fast
echo 'ELEVENLABS_API_KEY=your-key-here' > ~/.config/bb-voice-fast/elevenlabs.env
chmod 600 ~/.config/bb-voice-fast/elevenlabs.env
bb settings ai-services set voice elevenlabs --plugin voice-fast
```

Settings (environment variables of the bb server, all optional):

| Variable | Meaning |
|---|---|
| `ELEVENLABS_API_KEY` | API key (takes priority over the file) |
| `ELEVENLABS_KEY_FILE` | key file path, default `~/.config/bb-voice-fast/elevenlabs.env` |
| `VOICE_LANGUAGE` | language code such as `rus` or `eng`; empty = auto-detect |

Vocabulary: if the voice hint starts with `Vocabulary:` (or `Словарь:`) followed by
comma-separated words, they are passed to ElevenLabs as `keyterms` to spell names correctly.

Back to the default bb voice service: `bb settings ai-services set voice automatic`.
Logs (model, size and time of every transcription): `bb plugin logs voice-fast`.

## Apply the reliability patch

The patch is made against bb `desktop-v0.49.0` sources (files under `apps/app/src`):

```bash
cd path/to/bb-source
git apply path/to/bb-voice-fast/patches/bb-voice-reliability.patch
```

Then rebuild the app as usual. Tests for the new behaviour are included in the patch
(`useVoiceInput.test.tsx`, `voice-recording-store.test.tsx`).

## Why

When bb is used from a phone, the connection to the computer goes through a tunnel that
can drop for a moment. Before this patch a drop during upload could hang the request,
"cancel" deleted the recording, and audio still in memory was lost if the screen turned off.

---

## По-русски

Голосовой ввод для bb: быстрая расшифровка через ElevenLabs (плагин в `plugin/`) и
правка bb, после которой запись не теряется (`patches/`): звук сохраняется на телефоне
по ходу речи и восстанавливается после перезагрузки, при обрыве связи расшифровка
повторяется сама, «отмена» не удаляет запись. Установка — см. выше.

## License

MIT. The patch modifies bb source code, which is MIT-licensed by its authors.
