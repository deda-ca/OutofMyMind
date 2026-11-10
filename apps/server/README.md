# Jarvis Server

The API that Jarvis clients (the web client now, an Android app later) talk to. Clients stay thin; this server talks to audio.cpp and will hold the speech logic, the LLM and the agent.

Same rules as the client: **totally private and local**. TypeScript only.

# Stack

- Node.js 24, running TypeScript directly (type stripping). No build step, no `tsx`. `erasableSyntaxOnly` in `tsconfig.json` keeps the code to syntax Node can strip (no enums, no constructor parameter properties).
- [Fastify](https://fastify.dev/) 5.

# Running

```bash
npm install
npm run fetch-models   # once: the voiceprint model (28 MB) for speaker recognition
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
| `ACCESS_KEY` | (generated) | Pass-key for the API. Unset: one is generated on first start, saved in `DATA_DIR/access-key` and printed in the log. Set your own in `.env.local`. |
| `ALLOWED_ORIGINS` | `https://127.0.0.1:5173,https://localhost:5173` | Browser origins allowed to call the API. For phone access add the client's LAN address in `.env.local`, e.g. `https://192.168.1.50:5173`. |
| `DATA_DIR` | `data` | Database and audio archive. **Private conversations: git-ignored, never commit it.** |
| `LLM_URL` | `http://127.0.0.1:5550` | OpenAI-compatible chat server (llama.cpp's `llama-server`) for Jarvis's replies |
| `LLM_MODEL` | `Qwen3.6-35B-A3B` | Model id on that server |
| `LLM_API_KEY` | (none) | Sent as `Authorization: Bearer …` to `LLM_URL` (chat, `/tokenize`, `/props`): for a hosted OpenAI-compatible service, or llama-server started with `--api-key`. Put it in `.env.local`. |
| `TTS_MODEL` | `Qwen3-TTS` | audio.cpp text-to-speech model for Jarvis's spoken replies |
| `TTS_VOICE` | `jarvis` | Its voice (audio.cpp voice library) |
| `MCP_CONFIG` | `mcp.json` | The harness's plugin list (MCP servers). See [Harness](#harness). |
| `WORKSPACE_DIR` | `$DATA_DIR/workspace` | The folder the `files` plugin may read and write (to-dos, lists, …). Created at start-up; usable as `${WORKSPACE_DIR}` in `mcp.json`. |
| `WEATHER_HOME`, `WEATHER_UNITS` | (none), `celsius` | For the weather plugin: your town (e.g. `Ottawa, Ontario, Canada`), used when no place is named; `fahrenheit` for °F/mph. |
| `SCRIPTS_TIMEOUT_SECONDS`, `SCRIPTS_MEMORY_MB` | `30`, `256` | For the scripts plugin: how long a script may run, and its memory. |
| `BRAVE_API_KEY` or `SEARXNG_URL`; `WEB_SEARCH_ENGINE` | (none); `duckduckgo` | For the web plugin's search: a [Brave Search API](https://brave.com/search/api/) key, or the address of your own SearXNG (JSON format enabled), in `.env.local`. Without either, Jarvis searches in a background tab of its Chrome, on DuckDuckGo or `google`. |
| `BROWSER_HEADLESS`, `BROWSER_PORT`, `BROWSER_EXECUTABLE` | (off), `9333`, `google-chrome` | For the browser plugin (Jarvis's Chrome): `1` runs it without a window; its remote-control port on 127.0.0.1; which Chrome to run. With a window, the server must be started from a desktop session (`DISPLAY`/`WAYLAND_DISPLAY`/`XAUTHORITY` are passed on). |
| `OWNER_NAME` | (empty) | Your name, so Jarvis knows who it works for. Put it in `.env.local`. |
| `VOICEPRINT_MODEL` | `models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx` | Speaker recognition model (`npm run fetch-models`). If missing, the server runs with speaker recognition off. |
| `LOG_LEVEL` | `info` | |

# API

Everything under `/api` needs the pass-key (see [Security](#security)), except `/api/login` and `/api/auth`.

| Route | Purpose |
| --- | --- |
| `POST /api/login` | Body `{"key": "…"}`. Sets an HttpOnly, Secure, SameSite=Strict session cookie (valid a year). Case, spaces and dashes in the key don't matter. Throttled after 5 wrong keys per address. |
| `GET /api/auth` | `{"signedIn": true\|false}` |
| `POST /api/logout` | Clears the cookie. |
| `GET /api/stream` (WebSocket) | **Live transcription.** Protocol below. |
| `GET /api/health` | `{"status":"ok"\|"degraded","audiocpp":{"ok":…,"detail":…}}` |
| `GET /api/conversations?limit=50&before=<id>` | Archived conversations, newest first, with phrase count, speech time, audio size, keep flag, preview. |
| `GET /api/conversations/:id/phrases` | A conversation's phrases: time, duration, text, status (`ok` / `dropped` / `error`), keep flag. |
| `GET /api/phrases/:id/audio` | The phrase's audio, `audio/ogg; codecs=opus`. |
| `GET /api/owner` | Speaker recognition on/off, model, and the owner's voice-library clips (phrase id, device, text, date). |
| `DELETE /api/owner/clips/:phraseId` | Remove one clip from the owner's voice library (the recording stays in the archive). |
| `DELETE /api/owner/clips` | Empty the owner's voice library. |
| `GET /api/people` | **list_people**: everyone known (owner, named people, unnamed "Speaker A" groups) with clip/phrase counts, last heard, and `maybeSameAs` (possible duplicates). |
| `GET /api/people/:id/clips` | A person's voice-library clips. |
| `GET /api/speakers/recent?minutes=5` | **recent_speakers**: who spoke recently, most recent first, with their latest phrases. |
| `PUT /api/people/:id/name` | **name_speaker**: body `{"name": "Maria"}`. `:id` may be `recent-other` (the most recent speaker other than the owner: "the person speaking now"). A name already in use merges the two. |
| `PUT /api/phrases/:id/speaker` | **retag_phrase**: body `{"personId": 12}` or `{"personId": "new"}`. The phrase's clip moves to that voice library. |
| `POST /api/people/:id/merge` | **merge_people**: body `{"into": 12}`. Everything moves to `into`. |
| `DELETE /api/people/:id?deleteAudio=true` | **forget_person**: removes the person and their voice library; their phrases become unknown (and their audio is deleted with `deleteAudio=true`). |
| `POST /api/speakers/backfill` | Tags archived phrases recorded before speaker recognition, oldest first. Refuses until the owner's voice is trained. |
| `PUT /api/conversations/:id/keep`, `PUT /api/phrases/:id/keep` | Body `{"keep": true\|false, "note"?: "…"}`: "keep forever", so a future clean-up skips it. |
| `POST /api/transcribe?sampleRate=16000&language=English` | One-off: body is one phrase of raw s16le mono PCM (`Content-Type: application/octet-stream`, max 8 MB). Returns `{"text": "…"}`. Handy for testing with curl. |

## Live transcription: `/api/stream`

The client stays thin. It runs a voice detector (Silero VAD) on the device and sends audio **only while someone is talking**, each frame **once**. The server does everything else: splitting phrases at pauses, live re-transcription, final transcription, settings.

**Client → server**

| Message | When |
| --- | --- |
| `{"type":"start","sampleRate":16000,"language":"English","device":"web","mode":"conversation","settings":{…}}` | First message. `sampleRate` must be 16000. `device`: a short label stored with recordings and voice clips. `mode`: `conversation` (default) or `enroll` (voice training, below). `settings` optional. |
| Binary: `[float32 LE speech probability 0–1][s16le mono PCM]` | One VAD frame (512 samples = 32 ms). |
| `{"type":"settings","settings":{…}}` | Any time; applies immediately. |
| `{"type":"stop"}` | Finish: the server ends the open phrase, sends its final text, `stopped`, then closes. |
| `{"type":"playback","state":"playing"\|"paused"\|"stopped"\|"idle"}` | What the client's speech player is doing (Jarvis talking). The follow-up countdown waits while it's playing or paused, and short phrases are kept while Jarvis is talking. |
| `{"type":"text","text":"…"}` | Typed, pasted or corrected text from the owner's screen (conversation mode, up to 8000 characters). Echoed back as a final `phrase` with `"typed":true` and an owner speaker tag, archived without audio, and always handled as addressed to Jarvis: no wake word or voiceprint needed. |

**Server → client**

| Message | Meaning |
| --- | --- |
| `{"type":"ready","settings":{…},"sendHangoverMs":1500}` | Effective (clamped) settings. |
| `{"type":"settings","settings":{…},"sendHangoverMs":1500}` | After a settings change. |
| `{"type":"phrase","id":3,"text":"…","final":false}` | Live text for phrase 3; replaces earlier text for that id. `final: true` = won't change again. `typed: true` = the echo of a `text` message. |
| `{"type":"phrase.dropped","id":3}` | Phrase 3 was noise or empty: remove it. |
| `{"type":"phrase.split","id":3,"into":[7,8,9]}` | Phrase 3 held several speakers taking turns: replace it with phrases 7, 8, 9 (in that order), whose text and speakers follow. |
| `{"type":"phrase.speaker","id":3,"final":false,"speaker":{"speakerId":4,"name":"Maria","named":true,"isOwner":false,"similarity":0.21,"match":0.68,"confidence":"high"}}` | Who said phrase 3: an early guess (`final: false`, after ~1.5 s of speech; only matches known people, `name: "New voice"` otherwise) or the decision (`final: true`; may create a new "Speaker X"). `name`: "You", a given name, or "Speaker A". `isOwner`: `true` / `false` / `null` (voice not trained). `similarity`: to the owner; `match`: to the matched person. `confidence`: `high`, `low` (close to a threshold) or `uncertain` (under 1 s of speech). |
| `{"type":"enroll.clip","id":3,"accepted":true,"reason":null,"text":"…","clips":8}` | Enroll mode: a training clip was accepted or rejected (`reason`), and how many clips the owner's library now has. |
| `{"type":"state","inPhrase":true,"phraseMs":…,"speechMs":…,"silenceMs":…}` | Phrase detection state, ~10×/s while a phrase is open (for monitoring). |
| `{"type":"request","seq":…,"phraseId":…,"kind":"partial"\|"final","audioMs":…,"latencyMs":…,"status":…,"text":…}` | One transcription by audio.cpp (for monitoring). |
| `{"type":"error","message":"…"}` | Protocol errors close the connection (1008). |
| `{"type":"stopped"}` | After `stop`, once the last final text has been sent. |
| `{"type":"assistant.state","state":"idle"\|"conversation","followUpEndsAt":…,"ownerTrained":true}` | Jarvis is idle (waiting for "Jarvis") or in a conversation, listening for follow-ups until `followUpEndsAt` (epoch ms). `ownerTrained: false` = anyone can talk to it. |
| `{"type":"assistant.start","replyId":1,"toPhraseId":3}` | Jarvis starts answering phrase 3. |
| `{"type":"assistant.delta","replyId":1,"delta":"…"}` | Reply text as it streams. |
| `{"type":"assistant.done","replyId":1,"text":"…","kind":"reply"\|"wake"\|"dismiss"}` | Final reply text. `wake` = "Yes?" (just "Jarvis"), `dismiss` = "Okay." |
| `{"type":"assistant.error","replyId":1,"message":"…"}` | The LLM couldn't answer. |
| `{"type":"assistant.control","action":"stop"\|"continue"\|"repeat"\|"resume","replyId":1}` | Playback control: stop (resumable), continue (from the interrupted sentence), repeat (reply `replyId` from the start), resume (after a barge-in pause that wasn't for Jarvis). |
| `{"type":"assistant.tool","replyId":1,"kind":"tool"\|"notice","label":"…","emoji":"🔎"}` | A tool the agent is using while it answers (with the call: name, arguments, result), or a note (e.g. tools unavailable). Shown, not spoken. |
| `{"type":"assistant.audio","replyId":1,"seq":0,"text":"…","wav":"<base64>","synthMs":370}` | One spoken sentence of a reply (24 kHz WAV), in order. Play them back to back; a newer `replyId` replaces an older one. Only sent when `speakReplies` is 1. |

**The client's send rule** (all a client has to implement):

1. Run Silero VAD v5 on 16 kHz mono audio, 512-sample frames.
2. While not sending, keep the last `preSpeechPadMs` of frames.
3. On a frame with probability ≥ `speechThreshold`: send the kept frames, then this one, and start sending.
4. Keep sending every frame until `sendHangoverMs` has passed with no speech frame. That's always longer than the pause setting, so the server sees enough silence to end the phrase itself.

Settings (all clamped by the server, defaults in `src/stream/settings.ts`): `speechThreshold` 0.5, `pauseMs` 1200, `preSpeechPadMs` 300, `minSpeechMs` 250, `maxPhraseMs` 25000, `partialIntervalMs` 1000, `speakerThreshold` 0.43, `speakerChangeThreshold` 0.3 (0 = never split by speaker), `followUpMs` 30000 (5–180 s), `speakReplies` 1 (0 = text only), `speakProgress` 1 (0 = no "Searching the web…" while it works).

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

## Speaker recognition

Milestone M2 of [docs/speaker-recognition.md](../../docs/speaker-recognition.md): **know the owner**. Model choice: [docs/speaker-model-eval.md](../../docs/speaker-model-eval.md).

- **Voiceprints:** 3D-Speaker CAM++ (ONNX, 512 numbers per phrase), run with `onnxruntime-node` on the CPU, with Kaldi-style features computed in `src/speaker/features.ts`. ~130 ms per phrase. (Not sherpa-onnx: its voiceprints were wrong on this machine; see the eval doc.)
- **Every phrase** gets a voiceprint, computed while audio.cpp transcribes it, stored in `phrase_voiceprints`.
- **Tag:** best cosine similarity to the owner's library clips. `≥ speakerThreshold` (default 0.43) = the owner. An early guess goes out once a phrase has 1.5 s of speech; the decision when it ends. The current tag is on the phrase; every change is in `speaker_history`.
- **Voice training (`mode: "enroll"`):** each phrase is checked (≥ 1.5 s of speech, words recognised, and similar to the clips so far: at least threshold − 0.1) and, if accepted, added to the owner's `library` with its device. Training sessions are archived as conversations of kind `enrollment`.
- **Other people (M3):** a phrase that isn't the owner's joins the person (named or not) whose 3 closest library clips average ≥ 0.45, otherwise it starts a new unnamed group ("Speaker A", "Speaker B", …). Only real speech (not noise) can start a group. Clear matches (≥ 0.55, ≥ 2 s of speech) are added to that person's library (capped at 50), so recognition improves as people talk. Tuned in [docs/speaker-model-eval.md](../../docs/speaker-model-eval.md#grouping-unknown-voices-m3).
- **Naming, corrections, merges and forgetting** are the `/api/people` routes above, shaped like the AI tools in the design. The LLM will call the same `Speakers` methods; the server must check the request came from the owner's voice first (not built yet: no LLM).
- **Speaker changes (M4):** when a phrase of 3 s or more ends, it's scanned for points where the voice changes (`src/speaker/changes.ts`, tuned in [docs/speaker-model-eval.md](../../docs/speaker-model-eval.md#speaker-changes-inside-a-phrase-m4)). If there are any, the client gets `phrase.split` and each piece is transcribed, identified and archived as its own phrase. A new "Speaker X" now needs ≥ 2 s of speech, so fragments don't create people.
- Not yet: people talking at the same time (needs a diarization model).

## Jarvis (the assistant)

Milestone M5 step 1 of [docs/speaker-recognition.md](../../docs/speaker-recognition.md): Jarvis answers, as text, using the local LLM (`src/assistant/`).

- **Wake word "Jarvis".** Idle, Jarvis only reacts to the **owner's** voice saying "Jarvis" (anyone's, until the owner has trained their voice). Just "Jarvis" gets "Yes?".
- **Conversations flow.** After an answer, the owner's next phrases go to Jarvis without the wake word, for the follow-up window (`followUpMs`, default 30 s, restarted by each exchange).
- **Dismiss:** "thanks, Jarvis", "that's all, Jarvis", "goodbye, Jarvis", "Jarvis, go to sleep"; in a conversation also "that's all", "goodbye", "never mind", "stop listening" alone. Rules and tests: `src/assistant/wake.ts`, `test/wake.test.ts`.
- **Who may ask** is decided in code from the speaker tag, never by the LLM. Other people's phrases during a conversation are given to the LLM as context ("[Maria said, not to you]"), never as requests. The last couple of minutes before "Jarvis" are included as context too.
- **LLM:** streamed chat completions, thinking off (a short answer arrives in ~0.3–0.6 s), conversation history kept per conversation (last 24 messages) and cleared when it ends.
- **Archive:** every reply is stored with the phrase it answers (`assistant_replies`), shown in History.
- **Spoken replies:** each sentence is sent to audio.cpp's text-to-speech (Qwen3-TTS, voice `jarvis`) as soon as the LLM finishes writing it, so speech starts ~1 s after a request (LLM first words ~0.6 s + ~0.4 s synthesis) while the rest is still being written. Markdown and links are cleaned for speaking (`src/assistant/speech.ts`, tested in `test/speech.test.ts`). No echo handling yet: use headphones/an earpiece.
- **Voice controls (`src/assistant/controls.ts`, tested in `test/controls.test.ts`):** short phrases "stop" / "quiet" / "wait", "continue" / "go on", "repeat" / "say that again" / "what was that" are handled in code, never by the LLM. They work from the owner and from short phrases whose speaker is unclear (a one-word voiceprint is unreliable); only a clearly different voice is ignored. While Jarvis is in a conversation or talking, phrases down to 60 ms of speech are kept so a quick "stop" isn't thrown away. A new question aborts an answer still being written. Anything heard during a barge-in that isn't for Jarvis (someone else, noise) sends `resume`.
- **Saying what it's doing (`src/assistant/progress.ts`):** while an answer takes a while, Jarvis says what it's doing ("Searching the web for …", "Opening nhl.com.", or "One moment." before any tool runs) after 4 s of silence, then every 8 s of silence ("Still on it."), at most four lines, picked at random. The `speakProgress` setting turns it off.
- Not yet: tools for naming people / grants / keep, echo handling for speakers.

# Harness

Jarvis's own agent loop (`src/harness/`), which gives the LLM tools from plug-and-play [MCP](https://modelcontextprotocol.io) servers ("plugins").

- **Loop (`loop.ts`):** ask the LLM with the tools offered; if it calls any, run them, add the results, ask again; stop when it answers in words (at most 6 calls to the LLM; the last one is sent without tools, so it always ends with an answer). Text streams as it comes, so "Let me check." is spoken while a tool runs. Each tool call is shown in the client (`assistant.tool`), not spoken, and logged in the server log (`harness: notes.write_note {…} → …`). Tool calls and their results stay in the conversation history (results cut to 2,000 characters there), so on the next turn the model sees what it really did; without them it saw only its own "I've saved it" and started claiming saves it never made. Plain chat (no tools) gets the history without them.
- **MCP client (`mcp.ts`):** one connection per plugin, over stdio (child process) or streamable HTTP. Tools are offered as `<plugin>__<tool>`. A plugin that fails to start or crashes is left out and retried in the background (every 30 s at most); tool errors go back to the model as error results, never crash a reply. Results are cut at 8,000 characters.
- **Plugins (`mcp.json`, or `MCP_CONFIG`):** the standard `mcpServers` format, so third-party MCP servers drop in as they are. `"enabled": false` turns one off; `${NAME}` is filled from the environment (keep tokens in `.env.local`), plus `${DATA_DIR}`. stdio plugins run from this folder and get only a minimal environment plus their own `env`, never this server's secrets. Restart the server after editing. An optional `"instructions"` string per plugin is added to the plugin's own MCP instructions in the prompt (Jarvis-only; e.g. how the workspace folder is laid out). `"exclude": ["<tool>"]` hides tools for good (never offered, refused if called; e.g. the browser's `browser_run_code_unsafe`), unlike the Tools tab switches. `"maxResultChars"` (default 8,000) is the longest tool result the LLM gets from that plugin.
- **CRUD tags (`crud.ts`):** every tool is tagged with what it does: create, read, update, delete (`write_file` is create + update). From, first match wins: a `"crud": { "<tool>": ["read"] }` entry on the plugin in `mcp.json`, the tool's `readOnlyHint` annotation, the verbs in its name; anything else counts as create + update + delete. The Tools tab switches whole kinds off (`disabledKinds` in `tools.json`): a tool is offered only if every kind it does is on, including tools of plugins added later, and the prompt names the tools that are blocked. Measured with Qwen3.6 and Update off: nothing was ever changed (enforced in code), but in about 2 of 7 change requests the model still said "I've added it" without calling any tool; offering the blocked tools as refusing stubs didn't help, so they're hidden. A check on such claims is still to do.
- **File access (`files`):** the official [`@modelcontextprotocol/server-filesystem`](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) (pinned in `/mcp-plugins`), confined to `WORKSPACE_DIR`. Its instructions in `mcp.json` set the layout: `todo.md` (`- [ ]` / `- [x]`) and `lists/<name>.md`, and `notes/` (the `notes` plugin's folder, so everything lives in the workspace). Measured with Qwen3.6-35B-A3B: add to a list, add a to-do, read a list, tick a to-do off, and "what's left" each took one or two tool calls, about 1 s; a list in a folder that doesn't exist yet takes a failed append first (about 3 s).
- **Running code (`scripts`):** Jarvis writes small JavaScript/TypeScript programs and runs them (`scripts__run_script`) when exactness matters: arithmetic, dates, totals, going through data files. Each one runs in a sandbox, [bubblewrap](https://github.com/containers/bubblewrap) (no network, a filesystem with only `/usr`, Node and the workspace) around Node's permission model (reads only in the workspace, writes only in `scripts/out/`, no child processes or workers), for at most 30 s and 256 MB. What it prints comes back (cut to 5,000 characters; the end of any error, without Node's internal frames). One-offs are kept in `scripts/tmp/` (the last 20); a named one is saved as `scripts/<name>.ts` to run again. Tagged create + read + update + delete, so switching off any kind switches it off. Needs `bwrap` (`sudo apt install bubblewrap`); without it the plugin starts but refuses to run anything. Measured with Qwen3.6: "how many days between March 3rd and Christmas, and what weekday is Christmas?" → one script, right answer (297, Friday); averages from a CSV, one script plus a write.
- **On/off switches (the client's Tools tab):** lists every plugin and its tools (description and parameters) with a checkbox for each. Switched-off plugins keep running; their tools just aren't offered, and a call to one is refused. Kept in `DATA_DIR/tools.json` (`disabledPlugins`, `disabledTools`), apart from `mcp.json`, and applied from the next request. API: `GET /api/tools`, `PUT /api/tools/:plugin` and `PUT /api/tools/:plugin/:tool` with `{ "enabled": true|false }`.
- **Prompt:** the system message gets rules to call a tool rather than guess what it can tell (without it, Qwen invented a temperature instead of asking the weather plugin) and to only say it did something if a tool call did it, plus each plugin's own MCP `instructions` (e.g. the owner's home town).
- **Off when empty:** with no plugins up, replies are plain chat exactly as before. If llama-server refuses a request with tools (it needs `--jinja`), the reply is retried without tools; the client shows a notice and the model is told it has no tools this time, so it doesn't claim to have done anything.
- Plugins themselves live in [`/mcp-plugins`](../../mcp-plugins/README.md). Measured with Qwen3.6-35B-A3B: "add milk and eggs to my shopping list" → one `append_to_note` call, answer done in ~0.9 s.

# Sessions

A session is one conversation thread with Jarvis: what the LLM sees as its history, kept across follow-up windows, reconnects, page refreshes and server restarts (`src/sessions/`). The archive still records everything heard; a session holds only the owner's requests, Jarvis's answers (with the tools it used), and other people's lines as context.

- **Files:** one Markdown file per session in `WORKSPACE_DIR/sessions/`, named by id (`2026-11-09-1430-a1b2.md`), so renaming never moves it. Frontmatter holds `title`, `pinned`, `created`, `updated`; each message is a `## Owner · 2026-11-09 14:30:12 · #123` section (`#123` = the archive phrase, for its audio), `## Jarvis · …` with ` ```tool <name>` blocks for tool calls, `## Maria (not to Jarvis) · …`, or `## Earlier (context) · …`. Text lines starting with `#`, ` ``` ` or `\` are escaped with a `\`. Files are re-read when they change, so hand edits count. Format and parser: `format.ts`.
- **Active session:** shared by all devices, kept in `DATA_DIR/sessions.json`. Every turn is added to it; the LLM gets its last 24 messages (whole turns, so a tool result never loses its call). "New session" (button, or "Jarvis, new session" / "start over") switches to a fresh one, written with its first message, so no empty files.
- **The files plugin** can read sessions ("what did we talk about yesterday?"); its instructions forbid writing to `sessions/` (an instruction, not enforced: the filesystem server can't make a subfolder read-only).
- **API:** `GET /api/sessions` (list + `activeId`), `GET /api/sessions/:id`, `PATCH /api/sessions/:id` `{ title?, pinned? }`, `DELETE /api/sessions/:id`, `POST /api/sessions/:id/activate`, `POST /api/sessions/new`. Connected clients get `{ type: "sessions.changed", activeId }` on `/api/stream` after any change.

# System prompt and agents

Files in the workspace, edited by hand (or by Jarvis when asked); changes apply from the next request (`src/agents/`). Written with defaults on first start.

- **`WORKSPACE_DIR/SYSTEM.md`:** in every system prompt, for every agent and session: who Jarvis is, how to talk. `{{owner}}` becomes `OWNER_NAME`; `<!-- comments -->` are never sent. Missing file: the default text; empty file: nothing.
- **`WORKSPACE_DIR/agents/<id>.md`:** one agent each, with frontmatter: `name`, `description`, `tools` (`all` (default), `none`, or a list of function names with `*` wildcards, e.g. `[files__read_*, weather__get_weather]`), optional `temperature`. The body is the agent's instructions. `jarvis.md` is the default agent.
- **Agents tab:** create, edit and delete agents and pick the default, from the client. The editor writes the same files (name, description, tools picked from the catalog or `*` patterns, temperature, instructions with comments kept). The default agent is kept in `DATA_DIR/agents.json`; sessions without their own agent (`agent:` empty) use it, and a session whose agent was deleted falls back to it. `jarvis.md` is the fallback: editable, not deletable. API: `POST /api/agents`, `PUT|DELETE /api/agents/:id`, `PUT /api/default-agent` `{ id }`.
- **Sessions** record their agent (`agent:` in the frontmatter); the client's session panel picks it, for the session on screen or the next new one. Switching agent in a session with messages adds a `## Note` to it: without it the model copied its own earlier answers ("I'm read-only") and ignored the new agent.
- **Tools** an agent isn't allowed are never offered and calls to them are refused, in code. A limited agent is also told exactly which tools it has: without that, a read-only agent asked to add something said "I've added it" with no tool to do it (Qwen3.6; with it, 6 of 6 trials refused correctly).
- **The system prompt, in order** (most stable first, so llama-server reuses its cached prefix): `SYSTEM.md` · the rule about other people in the room · `## Agent: <name>` + its instructions · tool rules and plugin instructions (if the agent has tools) · the agent's tool limits · `It is <date and time>.` (last: it changes every minute).
- **API:** `GET /api/agents`; `POST /api/sessions/new` `{ agent? }`; `PUT /api/sessions/new/agent` `{ agent }`; `PATCH /api/sessions/:id` `{ agent }` (`''` = default).

# Room awareness and talking with people

So Jarvis doesn't answer everything said near it, and knows who's around (`src/assistant/room.ts`, `assistant.ts`):

- **Room note:** every phrase heard (anyone's) is kept for the *room memory* setting (default 5 minutes, up to 30, 0 = off). Each request gets a note just before the owner's latest message (not in the system prompt, so the cached prefix survives): how many voices were heard and who (`Maria (voice match sure)`, `Speaker B (voice match not sure)`), and what was said that isn't already in the conversation, with times (`[14:51:47] Maria: …`). With Qwen3.6: "answer Maria's question" → "Maria, a cup of flour is about 125 grams."; alone → "only you have been heard in the last five minutes"; it counts and names who's around.
- **Confidence:** names carry the voice match: plain = sure, `(probably)`, `(unsure)`. Jarvis addresses someone by name only on a sure match or when the owner said the name (3 of 3 trials each).
- **Timestamps:** the owner's side of the history starts with when it was said (`[14:30]` today, `[Sun 8 Nov 14:30]` before); Jarvis's answers don't, so it doesn't copy the format.
- **Stepping back:** in the follow-up window, when someone else speaks (a high-confidence match that isn't the owner), the window ends: the owner is talking with them, and Jarvis waits for its name again. Needs the owner's voice trained.
- **Wake word only** (setting, header toggle, or "Jarvis, only when I say your name" / "Jarvis, normal mode"): no follow-ups; every request needs "Jarvis". Typed messages always go to Jarvis.

# Files in the conversation

Drop files on the Live conversation (or use 📎): Markdown, images, audio, video, PDFs, anything up to 500 MB (`src/files/`).

- **Saved** in the workspace under `uploads/<yyyy-mm-dd>/<name>`: streamed to disk, never overwriting (`name-1.ext`, …), names made safe. Being in the workspace, Jarvis's file tools can reach them: "save that photo in photos/vacation" → create_directory + move_file (measured with Qwen3.6).
- **In the session** as one `## Files` message with Markdown links (`[photo.jpg](<../uploads/…>) · image/jpeg · 3112 bytes`). The LLM gets full paths, which ones are text it can read, and that it can't see inside images, audio, video or PDFs yet (asked "what does the photo show?", it says so instead of guessing).
- **Shown** as chips: image thumbnails, audio and video players, links; "No longer here" if a file was moved or deleted since.
- **API:** `POST /api/uploads` (raw body, `Content-Type: application/vnd.jarvis.upload`, `X-File-Name` URI-encoded, `X-File-Type`) → `{ file }`; `POST /api/uploads/attach` `{ files, note? }` → adds them to the active session; `GET /api/workspace-file?path=` serves a workspace file (inside the workspace only, symlinks resolved; sandboxed so a dropped .svg or .html can't run scripts).
- Later: converting PDFs to Markdown, transcribing audio and video, describing images, so Jarvis can see inside them.

# Viewing files

A document viewer beside the conversation (`DocumentViewer.vue` in the client), read-only for now: Markdown rendered (marked + DOMPurify: headings, lists, tables, to-do checkboxes, code) with its linked images loaded from the workspace relative to the file; links to other Markdown files open in the viewer, web links in a new tab; images, PDFs and other text as they are. ↗ opens it alone in a tab (`/?view=<path>`). It re-reads the file after any tool call that changes something, and when the tab regains focus.

- **Opened by Jarvis:** a built-in tool, `jarvis__show_file` (`assistant.ts`: Jarvis's own tools run in the harness next to the MCP plugins, offered first, to every agent; they only touch the screen). "Show me / pull up / open / let me see" → it's on screen, and Jarvis says so instead of reading it out; "what's on my to-do list?" is still answered aloud. Measured with Qwen3.6: 6 of 6 phrasings with the `notes` plugin off; with it on, "pull up my trip notes" went through `notes` (short names, no workspace path) and wasn't shown. The `files` plugin covers `notes/`, so `notes` is best switched off.
- **Opened by you:** click a dropped file's chip, or a file in a tool call's details.
- Sanitized: a Markdown file can't run scripts (checked with `<script>`, `onerror`, `javascript:` links).

# Skills

How Jarvis handles a kind of thing (the to-do list, a weight log, a sleep log…): Markdown files in `WORKSPACE_DIR/skills/` (`src/skills/`), each with `name`, `description`, `files` (globs of the workspace files it governs), `triggers` (words in a request that call for it) and its rules in sections (`## Layout`, `## Adding`, `## Completing`, `## Ask if missing`, …), plus an optional `## Template`: a code block with what the governed file starts as. Starter skills (written when there's no `skills/` folder yet): **To-do list** (`todo.md`: sections Today / This week / Later / Done; `added`/`due`/`done` stamps and tags; done items are ticked, stamped and moved to Done, never deleted) and **Weight log** (`logs/weight.md`: a table; never assume the unit).

The rules reach the LLM when needed, in code (a small local model skips rules it isn't reminded of at that moment):
- **Index** in the system prompt: one line per skill. Plus: work out dates from the current time (`For stamps: 2026-11-09 15:15` is in the prompt); only ask what only the owner can say.
- **Triggered:** a request with a trigger word gets the whole skill in its note (with the room note), so Jarvis can ask follow-up questions before writing.
- **Guard** (`guard.ts`) around every tool call: the rules are attached to the result when a governed file is touched; a change to one before its rules were seen is refused once, with the rules. An append to a governed file always starts on a new line.
- **Templates:** when a skill comes into play and its file doesn't exist, Jarvis's code creates it from the template, so the layout is always right.

Jarvis grows skills when asked, with built-in tools: `jarvis__update_skill` adds a dated rule under a section ("from now on add a priority to every to-do"), never removing anything; `jarvis__create_skill` makes a new one (rules + template: "create a sleep log skill… ask me if I forget one"); `jarvis__read_skill`. They respect the Tools tab's create/update switches. Removing or rewriting rules is left to the owner (edit the file).

**Skills tab** (client `SkillsPanel.vue`, `src/skills/routes.ts`): view (rules rendered, template), create and edit (name, file name, description, files, triggers, rules with comments kept, template), delete, export one (`GET /api/skills/:id/export`, the .md) or all (`GET /api/skills-export`, a `jarvis-skills` JSON bundle), import (`POST /api/skills/import` `{ files: [{ name, text }], onConflict: rename | replace | skip }`: .md skill files, plain Markdown without a header (named after the file), or a bundle). Edits keep comments and Jarvis's dated rules; file paths must stay inside the workspace.

Measured with Qwen3.6 over a 12-turn conversation, twice: the to-do layout, stamps, due dates, done-handling, "Kilos or pounds?", the missing-rating question, the priority rule and the new sleep skill all worked in both runs; section choice and the format of rows in a skill Jarvis wrote itself vary a little. The tool loop allows 8 LLM calls per request (the guard's refusal and making a folder take some), and a tool call the model writes as text is never shown or spoken.

# Context meter

How full the local model's context is, and with what (`src/assistant/context.ts`; the client's `ContextMeter.vue`, in the header: a ring and "31K / 256K"; click for the breakdown).

- Each request to the local model asks llama-server for its token counts (`stream_options.include_usage`): `prompt_tokens` (the total) and `cached_tokens` (reused from its cache, not processed again).
- The request is split into sections, each counted with llama-server's own tokenizer (`/tokenize`, cached by text): the system prompt by part (SYSTEM.md, room & people rules, agent, skills index, tool rules, show-file rule, tool limits, date & time: the assistant labels them as it builds the prompt), the tool definitions by plugin, the conversation, tool calls & results, the room & skill notes, the latest message. What they don't account for is the chat template's formatting.
- The window size comes from `/props?model=…` (llama-server in router mode); re-read every 5 minutes.
- Pushed to clients after every request (`{ type: "context", stats }` on `/api/stream`, each tool-loop step being one); `GET /api/context` for a page load.
- First measurement (Qwen3.6, 262,144-token window): a request with one tool call was 5.9K tokens, 60% of it tool definitions (the files plugin alone 2.4K), the system prompt 1K; 99% came from the cache.

# Read aloud

Paste text (or press 🔊 on a document) and hear it, with the sentence and the word being read highlighted (client: `ReaderPanel.vue`, `reader.ts`; server: `src/assistant/ttsRoutes.ts`). It opens in the side panel where documents show.

- **Voices** come from audio.cpp (`GET /api/tts/voices` → its `/v1/audio/voices`, re-read every minute), so the reader can use a voice other than Jarvis's (`TTS_VOICE`); add one in audio.cpp and it appears in the picker. `POST /api/tts { text, voice }` → WAV, a sentence at a time (at most 1,000 characters); closing or skipping cancels it.
- **Sentences:** the client renders the text (Markdown or plain), wraps every word, and groups words into sentences (not at "Mr." or "4.5"; long ones split at a comma after ~220 characters; code blocks aren't read). audio.cpp makes speech at ~8× real time, so audio is fetched 2 sentences ahead (gapless) and kept (going back is instant).
- **Highlighting:** the sentence is exact (its audio is playing); the word is estimated: the clip's length spread over its words by length, a little more at commas and full stops.
- **Start anywhere:** click a word, or select text, and reading starts there (mid-sentence: only the rest of that sentence is synthesised). Play/pause, stop, previous/next sentence, speed 0.75–1.75× (pitch kept). Jarvis talking pauses it; it carries on after. The browser remembers the text, voice, speed and sentence.

# Timers, alarms, reminders and tasks

Each schedule is *when* plus *what to tell the LLM then*; the LLM decides what to say and how to reach the owner (`src/schedule/`, client `SchedulePanel.vue`, `NotificationStack.vue`, `notifications.ts`).

- **Kept** in `WORKSPACE_DIR/schedules.json` (`{ schedules: [...] }`; hand edits are picked up within 2 s). Each has a `kind` (`timer`, `alarm`, `reminder`, `task`), a `prompt` (an instruction to the LLM; empty = just the message), a fixed `message`, its first time (`start`), an optional `repeat` (`every` minute/hour/day/week/month/year, `interval`, `days`, `until`), `enabled`, `next`, `snoozedUntil`, and `last` (what happened).
- **Set by voice:** `jarvis__set_schedule` takes what the owner said (`in: "10m"`, or `time: "06:45"` with `date`, `repeat: "weekdays"`, `days`, `every`); the code works out the time (`when.ts`, local wall-clock time, so 06:45 stays 06:45 across DST) and answers with it, and the model confirms that. Also `jarvis__list_schedules`, `jarvis__cancel_schedule` (or skip its next time), `jarvis__alarm` (stop/snooze). Measured with Qwen3.6: "set a timer for 1 minute for the tea" and "in 2 minutes, check the weather in Ottawa and tell me whether I need a coat" each took one correct call.
- **Going off:** alarms and timers ring on screen at once with their message (no LLM). If there's a prompt, the LLM then runs it unattended (`run.ts`): the same system prompt as a reply plus "this is the scheduler", its plugins, `jarvis__notify` (the screen) and `jarvis__presence` (screens open, microphones listening, when the owner last spoke). Its reply becomes the notification, unless it used `jarvis__notify` or sent a message through a plugin (a tool named send/message/email/telegram/…), so other channels need no code here: install their MCP server and ask for it ("remind me by Telegram"). Measured: the coat question went to `weather__get_weather`, then `jarvis__notify` with the answer.
- **Never lost:** if the LLM fails, takes over 45 s or reaches nobody, the fixed message is shown instead (`last.result`: `fallback` / `failed`). An alarm nobody stops for 2 minutes wakes the LLM again, to try another way (a messaging tool, if it has one); it rings out after 10 minutes.
- **Unattended:** a scheduled run gets no tool that updates or deletes (sending a message counts as create), unless the schedule has `allowChanges`. The Tools tab's switches apply as usual.
- **Missed while the server was off:** a one-off goes off late (said so); a repeat goes off once if within 30 minutes, otherwise waits for its next time. Done one-offs are removed after a day.
- **In the session:** each run is added to the active session (a note saying what went off, and Jarvis's reply with its tool calls), so "snooze it" or "what did it say?" make sense.
- **Screens:** every open tab connects to `GET /api/notifications/stream` (server-sent events), listening or not. Notifications are shown (ringing card with Stop / Snooze, or a toast), spoken in Jarvis's voice (`/api/tts`), and shown as system notifications when the tab is in the background (if allowed). Nobody connected: kept, and delivered when a screen opens ("while you were away"). Saying "stop", "I'm up", "snooze", "snooze for five minutes" while something rings is handled in code, not by the LLM, and anyone may say it.
- **Schedule tab:** create, edit, pause, run now, skip next, delete; recent notifications; whether this screen is connected; quiet mode; the browser permission. Running timers count down in the header.
- **API:** `GET/POST /api/schedules`, `PATCH/DELETE /api/schedules/:id`, `POST /api/schedules/:id/run`, `POST /api/schedules/:id/skip`, `GET /api/notifications`, `POST /api/notifications/:id/ack` `{ action: "dismiss" | "snooze", minutes }` (`ringing` for all), `GET /api/notifications/stream?device=`.

# Not in the MVP

Single user, one stream per connection, no authentication, localhost only. Before the server is reachable from a network (e.g. for the Android app): authentication, TLS, and reconnect handling. Opus compression (~10× less upload) when cellular matters.

# Security

- **Pass-key:** every `/api` route, the live WebSocket and the recordings need either the session cookie (browsers, after `POST /api/login`) or `Authorization: Bearer <key>` (native clients). The cookie value is derived from the key, so changing `ACCESS_KEY` signs every device out. Keys are compared in constant time; 5 wrong keys from one address block it for 30 s, doubling each time (up to an hour). Code: `src/auth.ts`, tests: `test/auth.test.ts`.

- A request carrying an `Origin` header not in `ALLOWED_ORIGINS` gets 403, so other websites open in a browser can't use the API.
- Requests without `Origin` (native apps, curl) pass the origin check, but still need the pass-key.

# Layout

| Path | Purpose |
| --- | --- |
| `src/main.ts` | Entry point |
| `src/app.ts` | Fastify app and routes |
| `src/config.ts` | Environment configuration |
| `src/auth.ts` | Pass-key, sign-in, session cookie |
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
| `src/speaker/features.ts` | Kaldi fbank features (shared with tools/speaker-eval) |
| `src/speaker/voiceprint.ts` | ONNX voiceprint model |
| `src/speaker/speakers.ts` | Voice libraries, tagging, grouping, enrollment checks, and the people tools |
| `src/speaker/routes.ts` | Owner voice profile and people REST API |
| `src/speaker/backfill.ts` | Tags older archived phrases |
| `src/speaker/changes.ts` | Finds speaker changes inside a phrase |
| `src/assistant/assistant.ts` | Jarvis: wake word, conversation state, follow-ups, replies |
| `src/assistant/wake.ts` | Wake word and dismissal phrases |
| `src/assistant/llm.ts` | Streaming chat client for llama-server (request + SSE parsing shared with the harness) |
| `src/harness/index.ts` | The harness: started at start-up, used by the assistant for every answer |
| `src/harness/loop.ts` | The tool loop (streamed tool calls → MCP → results → LLM) |
| `src/harness/mcp.ts` | MCP client hub: plugin connections, tool routing, reconnects |
| `src/harness/config.ts` | Reads `mcp.json` |
| `src/harness/toggles.ts` | The Tools tab's on/off switches (`DATA_DIR/tools.json`) |
| `src/agents/library.ts` | `SYSTEM.md` and `agents/*.md`: reading, defaults, tool patterns |
| `src/agents/routes.ts` | `/api/agents` |
| `src/sessions/format.ts` | Session ⇄ Markdown |
| `src/sessions/history.ts` | Session entries ⇄ the LLM's messages (tool calls paired with results) |
| `src/sessions/store.ts` | The sessions folder, the active session, change events |
| `src/sessions/routes.ts` | `/api/sessions` |
| `src/harness/routes.ts` | `/api/tools`: list plugins and tools, switch them on and off |
| `mcp.json` | Enabled plugins |
| `src/assistant/speech.ts` | Text-to-speech, sentence splitting, cleaning text for speech |
| `scripts/fetch-models.ts` | Downloads and checksum-verifies the voiceprint model |
| `test/` | `node:test` tests |
