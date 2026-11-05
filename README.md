# Jarvis

A private, fully local voice assistant. Talk naturally; speech is transcribed live on your own hardware.

| App | What it is |
| --- | --- |
| [apps/server](apps/server/README.md) | The API: live transcription over a WebSocket, talking to the local audio.cpp server |
| [apps/client](apps/client/README.md) | Web client: microphone, on-device voice detection, transcript, settings and monitor |

## Running

Requires Node.js 24 and audio.cpp running on `127.0.0.1:5552` with the `Qwen3-ASR` model.

```bash
npm run setup      # first time: installs the root tools and both apps
npm --prefix apps/server run fetch-models   # first time: the 28 MB voiceprint model
npm run dev        # starts apps/server (:5180) and apps/client (:5173) together
```

Open http://127.0.0.1:5173. Ctrl+C stops both.

| Script | |
| --- | --- |
| `npm run dev` | Both apps, labelled `[server]` / `[client]` in one terminal |
| `npm run dev:server` / `npm run dev:client` | Just one of them |
| `npm run typecheck` | Typecheck both apps |
| `npm run setup` | Install everything |

## Roadmap

| Feature | Status |
| --- | --- |
| Live speech transcription, on-device voice detection, streaming to the server | ✅ Built |
| Audio archive: every phrase kept with compressed audio; History tab | ✅ Built |
| Speaker recognition: know the owner's voice, tag every phrase "you" / "someone else" ([model comparison](docs/speaker-model-eval.md)) | ✅ Built (M1–M2) |
| Speaker recognition: group unknown voices, name people, corrections (People tab) | ✅ Built (M3) |
| Speaker recognition: conversations (overlapping speech), voice commands and permissions | 📝 [Design](docs/speaker-recognition.md) (M4–M5) |
| Android app | Planned |
