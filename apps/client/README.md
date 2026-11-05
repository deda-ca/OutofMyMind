# Jarvis Web Client
This is a web client for talking naturally to an AI agent using openai compatible endpoints.  

# Important Notes

- **Totally private and totally local.** No audio, text, or any other data may ever leave this machine. No cloud services, no third-party APIs, no CDNs, no analytics or telemetry.
- **Do not use the browser's Web Speech API** (`SpeechRecognition`). In Chrome it sends audio to Google's servers. All speech-to-text must go through our local audio.cpp server.
- All dependencies (Bootstrap, fonts, icons, etc.) must be installed locally through npm and bundled by Vite, never loaded from a CDN.

# Specification

- Use TypeScript only. No JavaScript source files.
- Use Bootstrap 6.0 Alpha for all front end. Try not to use any custom CSS only if absolutely necessary.
- Use Vite and Vue3 for all the front end.  

# Local Services

## audio.cpp server (speech-to-text)

- The client never talks to audio.cpp itself: it calls **apps/server** (`/api/*`), which talks to audio.cpp at `http://127.0.0.1:5552`. See [../server/README.md](../server/README.md).
  - In development the Vite dev server forwards `/api/*` to apps/server, set in `.env` as `JARVIS_SERVER_URL=http://127.0.0.1:5180`.
- Speech-to-text model: `Qwen3-ASR`. Language forced to `English` (otherwise it guesses at noise and writes things like `就。` / `嗯。`).
- Text-to-speech model: `Qwen3-TTS` (not used in the first version)
- Endpoint apps/server uses: `POST /v1/tasks/run` with `request.audio_base64` (WAV) and `request.options.audio_chunk_seconds = "30"`.
  - This is the only transcription route that takes per-request options with uploaded audio. The override is needed because the server config sets `audio_chunk_seconds = 2`, which would otherwise split every phrase into 2 s pieces.
  - Speed: ~0.3 s for 14 s of audio.

### Why not the live route

`/v1/audio/transcriptions/live` works, but for Qwen3-ASR it isn't true streaming: each 2 s window is transcribed as a separate recording, with no context and no overlap, and the results are joined with spaces. Every window gets its own full stop and capital letter, and words on the boundaries get cut or repeated. A browser also can't call the route directly (it needs full-duplex HTTP).

### How live transcription works

The client is deliberately thin; the server does the work. Protocol: [../server/README.md](../server/README.md#live-transcription-apistream).

1. **Silero VAD** (v5, running in the browser through ONNX Runtime WebAssembly) scores every 32 ms of microphone audio for speech.
2. **Send rule**: audio is sent over one WebSocket only while there is speech, plus 300 ms from just before it and a hangover after it (the pause length + 0.3 s). Each frame is sent once. Silence is never sent.
3. **apps/server** splits phrases at pauses (1.2 s by default), re-transcribes the phrase in progress about once a second (shown in grey), and transcribes it once more when it ends (black).

### History tab

Every conversation is archived by apps/server. The History tab lists them newest first (date, device, speech time, size). Expand one to read each phrase and play its audio. "Keep forever" (whole conversation, or ★ per phrase) protects recordings from any future clean-up. Listening continues while you browse.

### Your voice tab and speaker tags

Train Jarvis on your voice: read the sentences shown aloud (8 by default), once on each device you use. Each clip is checked and saved; you can play or remove clips, or reset the profile. Once trained, the Live transcript shows each phrase on its own line tagged **You** or **Someone else** (lighter with "?" while it's an early guess or close to the threshold), and History shows the same tags. The Monitor's "Voice match" bar shows how similar the last phrase was to your voice, against the "Voice match threshold" setting.

### People tab

Everyone Jarvis has heard. A new voice gets a label ("Speaker A"); name it and Jarvis recognises that person from then on (their tags turn green with the name). Expand a person to listen to their voice clips, rename them, combine two entries that are the same person (suggested automatically when voices are close), or forget them (optionally deleting their audio). "Heard in the last 10 minutes" shows who spoke recently. "Tag older recordings" gives phrases recorded before speaker recognition a speaker. In History, click any phrase's tag to change who said it.

When people take turns without pausing, the phrase is shown under one tag while it's being spoken, then split into one line per speaker when it ends (setting: "Split when the speaker changes", 0 = off).

### Settings and Monitor panels

- **Settings**: pause length, speech threshold, minimum speech, pre-speech audio, live update interval, maximum phrase length. Saved in the browser's localStorage and sent to the server, which applies them immediately, even mid-recording.
- **Monitor**: live microphone level, speech probability against the threshold, the server's pause timer, current phrase length, how much audio was uploaded (and what share of what the mic heard), transcription counts and average latency, and a table of recent transcriptions (live/final, audio length, time taken, result).
- Each phrase is transcribed on its own, so a pause longer than the "pause that ends a phrase" setting starts a new sentence. A pause of 0.3 s gave "move quickly. The markets change quickly."; 1.2 s gave "move quickly, the markets change quickly".

### Noise test results (2026-11-05)

Speech clips with pauses, played as Chrome's microphone, mixed with synthetic noise:

| Background | Result |
| --- | --- |
| None | Perfect |
| Car rumble, 10 dB below the voice | Perfect (number formatting varies: "4.5" vs "four point five") |
| Coffee machine bursts, 3 dB below the voice, over speech and pauses | Perfect, nothing invented |
| TV (other voices), 12 dB below | **Fails**: TV words are mixed in, and can replace the user's words |
| TV, 20 dB below | **Partly fails**: TV sentences right next to the user's speech are still transcribed |

Qwen3-ASR transcribes any intelligible speech it hears. A level gate (ignoring speech quieter than the user) was tried and didn't help. For a TV or other people talking, use a headset or close-talking mic.

## ai.deda.ca proxy (future)

- Our own proxy in front of audio.cpp; requires an API key (`VITE_AI_API_KEY` in the git-ignored `.env.local`). Not used in version 1.
- Tested 2026-11-05: `/health`, `/v1/models` and `/v1/audio/transcriptions` work; `/v1/audio/transcriptions/live` returns **404** (not forwarded yet); browser CORS preflight returns 401.

# First Version

For the first version, there will be a button on the page, when I press it, it will listen to my voice and transcribe it onto the screen while I talk.

# Running

Start audio.cpp, then apps/server, then the client:

```bash
cd apps/server && npm install && npm run dev    # API on http://127.0.0.1:5180
cd apps/client && npm install && npm run dev    # http://127.0.0.1:5173
npm run typecheck
```

Use Chrome, Edge or Firefox on the same machine. The microphone only works on `localhost`/`127.0.0.1` or HTTPS.

## Layout

| Path | Purpose |
| --- | --- |
| `vite/vadAssets.ts` | Serves the Silero model, VAD worklet and ONNX Runtime files from `node_modules` under `/vad/` (copied into the build too). |
| `src/audio/streamTranscriber.ts` | Mic + VAD + send rule + `/api/stream` WebSocket client |
| `src/settings.ts` | Settings state, saved to localStorage |
| `src/components/SettingsPanel.vue` | Sliders for the settings |
| `src/components/MonitorPanel.vue` | Live VAD/level meters, pause timer, request log |
| `src/components/HistoryPanel.vue` | Archive browser: conversations, phrases, speakers, playback, keep |
| `src/components/VoicePanel.vue` | Voice training and the owner's voice clips |
| `src/components/PeoplePanel.vue` | People: names, clips, combine, forget, recent speakers |
| `src/components/SpeakerBadge.vue` | Speaker tag: You / name / Speaker A |
| `src/App.vue` | UI: Live and History tabs, start/stop button, flowing transcript (grey = still changing), errors |

A production build (`npm run build`) is static files; serve them from the same origin as apps/server's `/api`, or behind a proxy that forwards `/api` to it.
