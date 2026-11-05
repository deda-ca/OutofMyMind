# Jarvis Server

The API that Jarvis clients (the web client now, an Android app later) talk to. Clients stay thin; this server talks to audio.cpp and will hold the speech logic, the LLM and the agent.

Same rules as the client: **totally private and local**. TypeScript only.

# Stack

- Node.js 24, running TypeScript directly (type stripping). No build step, no `tsx`. `erasableSyntaxOnly` in `tsconfig.json` keeps the code to syntax Node can strip (no enums, no constructor parameter properties).
- [Fastify](https://fastify.dev/) 5.

# Running

```bash
npm install
npm run dev        # watch mode, http://127.0.0.1:5180
npm start          # no watch
npm run typecheck
npm test           # node:test; set SPEECH_PCM=<16 kHz s16le file> to include a real-speech round trip
```

Configuration comes from `.env`, overridden by the git-ignored `.env.local`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Localhost only unless deliberately opened up. |
| `PORT` | `5180` | |
| `AUDIOCPP_URL` | `http://127.0.0.1:5552` | The audio.cpp server |
| `ASR_MODEL` | `Qwen3-ASR` | audio.cpp model id for speech-to-text |
| `ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | Browser origins allowed to call the API |
| `DATA_DIR` | `data` | Database and audio archive. **Private conversations: git-ignored, never commit it.** |
| `LOG_LEVEL` | `info` | |

# API

| Route | Purpose |
| --- | --- |
| `GET /api/stream` (WebSocket) | **Live transcription.** Protocol below. |
| `GET /api/health` | `{"status":"ok"\|"degraded","audiocpp":{"ok":…,"detail":…}}` |
| `GET /api/conversations?limit=50&before=<id>` | Archived conversations, newest first, with phrase count, speech time, audio size, keep flag, preview. |
| `GET /api/conversations/:id/phrases` | A conversation's phrases: time, duration, text, status (`ok` / `dropped` / `error`), keep flag. |
| `GET /api/phrases/:id/audio` | The phrase's audio, `audio/ogg; codecs=opus`. |
| `PUT /api/conversations/:id/keep`, `PUT /api/phrases/:id/keep` | Body `{"keep": true\|false, "note"?: "…"}`: "keep forever", so a future clean-up skips it. |
| `POST /api/transcribe?sampleRate=16000&language=English` | One-off: body is one phrase of raw s16le mono PCM (`Content-Type: application/octet-stream`, max 8 MB). Returns `{"text": "…"}`. Handy for testing with curl. |

## Live transcription: `/api/stream`

The client stays thin. It runs a voice detector (Silero VAD) on the device and sends audio **only while someone is talking**, each frame **once**. The server does everything else: splitting phrases at pauses, live re-transcription, final transcription, settings.

**Client → server**

| Message | When |
| --- | --- |
| `{"type":"start","sampleRate":16000,"language":"English","settings":{…}}` | First message. `sampleRate` must be 16000. `settings` optional. |
| Binary: `[float32 LE speech probability 0–1][s16le mono PCM]` | One VAD frame (512 samples = 32 ms). |
| `{"type":"settings","settings":{…}}` | Any time; applies immediately. |
| `{"type":"stop"}` | Finish: the server ends the open phrase, sends its final text, `stopped`, then closes. |

**Server → client**

| Message | Meaning |
| --- | --- |
| `{"type":"ready","settings":{…},"sendHangoverMs":1500}` | Effective (clamped) settings. |
| `{"type":"settings","settings":{…},"sendHangoverMs":1500}` | After a settings change. |
| `{"type":"phrase","id":3,"text":"…","final":false}` | Live text for phrase 3; replaces earlier text for that id. `final: true` = won't change again. |
| `{"type":"phrase.dropped","id":3}` | Phrase 3 was noise or empty: remove it. |
| `{"type":"state","inPhrase":true,"phraseMs":…,"speechMs":…,"silenceMs":…}` | Phrase detection state, ~10×/s while a phrase is open (for monitoring). |
| `{"type":"request","seq":…,"phraseId":…,"kind":"partial"\|"final","audioMs":…,"latencyMs":…,"status":…,"text":…}` | One transcription by audio.cpp (for monitoring). |
| `{"type":"error","message":"…"}` | Protocol errors close the connection (1008). |
| `{"type":"stopped"}` | After `stop`, once the last final text has been sent. |

**The client's send rule** (all a client has to implement):

1. Run Silero VAD v5 on 16 kHz mono audio, 512-sample frames.
2. While not sending, keep the last `preSpeechPadMs` of frames.
3. On a frame with probability ≥ `speechThreshold`: send the kept frames, then this one, and start sending.
4. Keep sending every frame until `sendHangoverMs` has passed with no speech frame. That's always longer than the pause setting, so the server sees enough silence to end the phrase itself.

Settings (all clamped by the server, defaults in `src/stream/settings.ts`): `speechThreshold` 0.5, `pauseMs` 1200, `preSpeechPadMs` 300, `minSpeechMs` 250, `maxPhraseMs` 25000, `partialIntervalMs` 1000.

**How the server transcribes:** while a phrase is open, the whole phrase so far is re-transcribed every `partialIntervalMs`, skipped if nothing new was said. When the phrase ends (a pause of `pauseMs`), it is transcribed once more for the final text. Each request covers the full phrase, so punctuation flows. Server ↔ audio.cpp traffic stays on this machine.

**Measured** (web client, 2026-11-05): a mostly quiet 47 s session with one 6 s sentence uploaded 240 KB (16% of the audio); a 52 s near-continuous speech test uploaded 1.4 MB. The previous design (client re-uploading the whole phrase every second) would have sent ~12 MB for the latter.

Transcription goes to audio.cpp's `/v1/tasks/run` with `audio_chunk_seconds=30`, the only route that takes per-request options with uploaded audio (see `src/audiocpp.ts`).

## Archive

Everything said is kept: every phrase's transcript in SQLite (`DATA_DIR/jarvis.db`, Node's built-in `node:sqlite`) and its audio as a compressed file (`DATA_DIR/audio/YYYY/MM/DD/c<conversation>-p<phrase>.opus`).

- **One conversation** = one live session that contained speech (silent sessions leave nothing).
- **Every phrase is archived**, including ones dropped as noise (`dropped`) and ones whose transcription failed (`error`, audio kept so it can be redone). A phrase still in progress when the connection drops is finished and archived too.
- **Audio format:** Ogg Opus, 32 kbps, 16 kHz mono (~4 KB per second of speech, ~14 MB per hour), written by `src/archive/oggOpus.ts` around raw packets from `libopus-wasm`. Checked against an independent decoder (`npm test`) and Chrome; transcribing the decoded audio gives the same text as the original.
- **Nothing is deleted.** `keep` flags (conversation or phrase) mark recordings a future clean-up must leave alone.
- Schema migrations: numbered, in `src/archive/db.ts` (`PRAGMA user_version`).

# Not in the MVP

Single user, one stream per connection, no authentication, localhost only. Before the server is reachable from a network (e.g. for the Android app): authentication, TLS, and reconnect handling. Opus compression (~10× less upload) when cellular matters.

# Security

- A request carrying an `Origin` header not in `ALLOWED_ORIGINS` gets 403, so other websites open in a browser can't use the API.
- Requests without `Origin` (native apps, curl) are allowed. That's safe only while the server listens on localhost. **Before exposing it to the network (e.g. for the Android app), add authentication.**

# Layout

| Path | Purpose |
| --- | --- |
| `src/main.ts` | Entry point |
| `src/app.ts` | Fastify app and routes |
| `src/config.ts` | Environment configuration |
| `src/audiocpp.ts` | audio.cpp client (WAV wrapping, `/v1/tasks/run`, health) |
| `src/stream/protocol.ts` | `/api/stream` message types and frame parsing |
| `src/stream/route.ts` | The WebSocket route |
| `src/stream/session.ts` | One live session: phrases, live and final transcription |
| `src/stream/phraseSegmenter.ts` | Pure logic: VAD-scored frames → phrases |
| `src/stream/settings.ts` | Settings, defaults and allowed ranges |
| `src/archive/db.ts` | SQLite database and migrations |
| `src/archive/archive.ts` | Saving and reading conversations and phrases |
| `src/archive/oggOpus.ts` | PCM → Ogg Opus file |
| `src/archive/routes.ts` | Archive REST API |
| `test/` | `node:test` tests |
