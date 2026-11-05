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
| **Speaker recognition**: record and archive everyone in a conversation, know the owner's voice, tag who said what, learn other people over time; only the owner (or people they allow) can give commands | 📝 [Design](docs/speaker-recognition.md) |
| Android app | Planned |
