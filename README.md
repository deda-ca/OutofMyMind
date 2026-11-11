# OutOfMyMind with Marvin

**Don't Panic.**

![OutOfMyMind with Marvin: Don't Panic](docs/Marvin%E2%80%99s%20Cosmic%20Don%E2%80%99t%20Panic%20Poster.png)

A private, fully local voice assistant. Talk naturally; speech is transcribed live on your own hardware.

Its AI is **Marvin**: knowledgeable, dependable, slightly sarcastic, and perhaps a little depressed about having to answer everyone's questions.

**The wake word** is "Jarvis" for now. It will become "Marvin" in this project's release. It's your assistant, though: call it whatever you like.

| App | What it is |
| --- | --- |
| [apps/server](apps/server/README.md) | The API: live transcription over a WebSocket, talking to the local audio.cpp server |
| [apps/client](apps/client/README.md) | Web client: microphone, on-device voice detection, transcript, settings and monitor |
| [apps/android](apps/android/README.md) | Android app (Kotlin): Jarvis from the phone, audio only. Start listening, screen off, until Stop listening |
| [plugins](plugins/README.md) | Plug-in tools for Jarvis (MCP servers): files, notes, weather, web, browser, scripts, Telegram, email, contacts, calendar, read aloud. The harness that runs them is in `apps/server/src/harness` |

## Running

Requires Node.js 24, audio.cpp on `127.0.0.1:5552` with the `Qwen3-ASR` model, and llama.cpp's `llama-server` on `127.0.0.1:5550` with `Qwen3.6-35B-A3B` (for Jarvis's replies).

```bash
npm run setup      # first time: installs the root tools and both apps
npm --prefix apps/server run fetch-models   # first time: the 28 MB voiceprint model
npm run dev        # starts apps/server (:5180) and apps/client (:5173) together
```

Open https://127.0.0.1:5173 (accept the self-signed certificate once). Ctrl+C stops both.

**From your phone (same network):** open `https://<this machine's LAN IP>:5173` (e.g. https://192.168.1.50:5173) and accept the certificate warning. The address must be listed in `ALLOWED_ORIGINS` in `apps/server/.env.local`. HTTPS is needed because browsers only allow the microphone on secure pages. Each device signs in once with the **access key**: it's printed in the server's log at startup (and kept in `apps/server/data/access-key`), or set your own as `ACCESS_KEY` in `apps/server/.env.local`.

| Script | |
| --- | --- |
| `npm run dev` | Both apps, labelled `[server]` / `[client]` in one terminal |
| `npm run dev:server` / `npm run dev:client` | Just one of them |
| `npm run typecheck` | Typecheck both apps |
| `npm run setup` | Install everything |
| `npm run build` | The release: one executable with the server, web client and plugins (needs Bun; see below) |

## Releases

`npm run build` (with [Bun](https://bun.sh) installed, after `npm run setup`) builds the web client and compiles one executable, `dist/jarvis-<version>-linux-<arch>/jarvis`, plus a `.tar.gz` of that folder and its `.sha256`. The version is `version` in `apps/server/package.json`.

The executable contains the server, the built web client (it serves it itself, over HTTPS), every MCP plugin in `mcp.json` (`jarvis plugin <name>`), the services kit and ONNX Runtime. To deploy, unpack the tarball anywhere, copy `.env.example` to `.env`, run `./jarvis fetch-models` once, then `./jarvis`. [release/README.md](release/README.md) (also in the tarball) has the details.

How it's put together: [release/build.ts](release/build.ts) (the build, and small fixes for packages that don't bundle as they are), [release/main.ts](release/main.ts) (the binary's commands), [release/plugins.ts](release/plugins.ts) (the built-in plugins: a new plugin in `mcp.json` must be added there, or the build stops and says so). Development stays on Node: the release only adds `SITE_DIR` (src/site.ts) and `TLS` (src/tls.ts) to the server, both off by default.

## Roadmap

| Feature | Status |
| --- | --- |
| Live speech transcription, on-device voice detection, streaming to the server | ✅ Built |
| Audio archive: every phrase kept with compressed audio; History tab | ✅ Built |
| Speaker recognition: know the owner's voice, tag every phrase "you" / "someone else" ([model comparison](docs/speaker-model-eval.md)) | ✅ Built (M1–M2) |
| Speaker recognition: group unknown voices, name people, corrections (People tab) | ✅ Built (M3) |
| Speaker recognition: split phrases where the speaker changes (back-to-back turns) | ✅ Built (M4 part 1) |
| Jarvis answers: wake word "Jarvis", flowing follow-ups, "thanks, Jarvis" to end; only the owner (local Qwen3.6 via llama.cpp) | ✅ Built (M5 step 1) |
| Jarvis speaks its replies (Qwen3-TTS, sentence by sentence; headphones for now) | ✅ Built |
| Interrupt Jarvis by talking; "stop", "continue", "repeat" by voice | ✅ Built |
| Access key sign-in (phone access over the LAN) | ✅ Built |
| Data history: the data folder is a git repository, every change committed (out of the LLM's reach; `DATA_HISTORY=off` to turn off) | ✅ Built |
| Harness: Jarvis's own tool loop with plug-and-play MCP plugins; plugins: markdown notes, weather (Open-Meteo; needs the internet) | ✅ Built (start) |
| More plugins: calendar, files, … | Planned |
| Jarvis: tools (name people, grants, keep), echo handling for speakers, overlapping speech | 📝 [Design](docs/speaker-recognition.md) |
| Services: background programs Jarvis writes itself (email first), sandboxed, owner-approved, waking Jarvis with events | 📝 [Design](docs/services.md) |
| Android app: audio only, through a Bluetooth headset, in the background | 📝 [Spec](docs/android-client.md) |
| Phone (VoIP.ms): calls through Jarvis from the web client, recorded and transcribed; texts | ✅ Built ([design](docs/phone.md)) |
| Phone: Marvin answers and screens, rings your cell, three-way calls, messages; rules (always, blocked, quiet hours) | ✅ Built ([design](docs/phone.md)) |
| Phone: hold-waiting and phone menus for you; the Android app as a handset | 📝 [Design](docs/phone.md) |
| Telegram: chat with Jarvis from anywhere (text, voice notes, photos and files), replies as text and voice notes; Jarvis messages you there | ✅ Built ([docs](docs/telegram.md)) |
| Plugins: self-contained, with events, triggers, their own tab, and the owner's yes enforced for sending | ✅ Built ([design](docs/plugins.md)) |
| Email (IMAP/SMTP): watched, kept locally with tags and addresses, an Email tab, triage, sending on your yes | ✅ Built ([docs](docs/email.md)) |
| Contacts: people with emails and numbers, suggestions learned from email (you decide), vCard import/export, a Contacts tab | ✅ Built ([docs](docs/contacts.md)) |
| Calendar (CalDAV): agenda, free time, adding and moving events, reminders before them, a Calendar tab | ✅ Built ([docs](docs/calendar.md)) |
| Read aloud: its own tab (a plugin): paste, a document or text Jarvis hands over, read in a chosen voice with the words highlighted | ✅ Built ([docs](docs/reader.md)) |
| Tools loaded on demand: heavy plugins (the browser first) listed in one line, their full schemas loaded only when needed | 📝 [Design](docs/tool-loading.md) |
