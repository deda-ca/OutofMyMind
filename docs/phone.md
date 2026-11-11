# Phone: calls and texts through Jarvis (design)

Status: design written 2026-11-11 from the owner's answers the same day. **Phase 0 done** (registration accepted through `toronto2.voip.ms`; the router changes ports but the provider's keep-alives get through; the API refused the IP until it's allowed). **Phase 1 built** and tested end to end against VoIP.ms's echo test (4443): two-way audio, recording, transcript; not yet tried on a call to a real phone or from the Android app. **Phase 3 (texts) built**, tested against a fake API only (waiting for the API's IP allow-list). Phases 2 and 4 are next.

## The idea

Jarvis gets a phone number. The owner can **call through Jarvis** (talking from the web client or the Android app, with the call recorded and transcribed), and **Jarvis answers the phone**: it screens callers, takes messages, and when someone should get through, it **rings the owner's cell and joins the two calls**, staying on the line to record and transcribe. Later it **texts**, waits on hold for the owner, and makes calls on its own.

Everything runs inside the server: no PBX, no extra service to run. That keeps the [single-binary release](../release/README.md) one binary.

The hard part isn't SIP. It's that a phone line **lets strangers talk to Jarvis** (callers and texts are untrusted, and caller ID can be faked), **speaks for the owner** (anything sent or said in their name), **costs money per minute**, and **records other people**. Most of the decisions below are about those.

## Decisions

| Topic | Decision |
| --- | --- |
| Provider | **VoIP.ms**: SIP for calls and a REST API for texts, on one number. (Freephoneline was considered: it has no texting and allows one registered device.) |
| Jarvis's SIP login | **Its own VoIP.ms sub-account**, so it registers alongside the owner's other phones instead of replacing them. Device type "ATA device, IP Phone or Softphone"; user/password authentication; G.711u only; international calls off; dial mode **E.164** (Jarvis always dials country code first: `1` + 10 digits); caller ID "system capable of passing its own". |
| Caller ID out | **Chosen per call by Jarvis** (sub-account: "system capable of passing its own CallerID"). Calls Jarvis places for the owner show **`VOIPMS_CALLER_ID`, the owner's own cell, verified at VoIP.ms**, so callbacks reach the owner. Calls Marvin makes **to** the owner's cell show **`VOIPMS_DID`** (a call claiming to come from the number it rings gets blocked by some carriers). Never a number the owner hasn't verified or doesn't own: carriers rate those low (STIR/SHAKEN) and show them as spam. A verified number not owned by VoIP.ms may still be rated lower than the DID; phase 1 checks how both arrive. The caller's own number is never passed on. The name shown (CNAM) comes from the carrier's database, not from the call; for Canadian numbers it's often just the city.
| SIP stack | **Our own**, in `apps/server/src/phone/`, on Node's UDP sockets: only the part of SIP that VoIP.ms uses. Not Asterisk (a second program to run, and it would break the single binary), not JsSIP or SIP.js (SIP over WebSocket with WebRTC media, which VoIP.ms sub-accounts don't speak), not the `sip` npm package (unmaintained). Asterisk stays the fallback if the home network defeats direct SIP. |
| Codec | **G.711u (PCMU)**, 20 ms packets, 8 kHz. Converted to and from the 16 kHz the rest of Jarvis uses. |
| Where audio goes | **Through the server, always.** Calls are never handed off with SIP transfers (REFER): Jarvis would stop hearing them. The price: a server restart drops calls in progress. |
| Recording | **Every call is recorded and transcribed** into the audio archive, one channel per party. A "this call may be recorded" notice plays when the other side answers or Marvin answers (a setting; on by default, and always for US numbers, where some states need everyone's consent; Ontario needs one party's). |
| Marvin speaking | Whenever Marvin is the one talking to someone, it says it's an AI assistant. |
| Calls and texts out | **Only after the owner's clear yes**, every time, with the number and (for texts) the exact text read back. Tools tagged `create`, so the Tools tab can switch them off. |
| Callers and texts in | **Untrusted**, like web pages and service events: marked as such for the LLM, handled by an agent with limited tools. A caller can never make Jarvis call, text, or change anything. |
| Caller ID | **Never a reason to trust someone.** It decides screening (who gets put through), not access. The owner calling in is recognised by voiceprint (and optionally a PIN). |
| 911 | **Never dialled by Jarvis**, refused in code. 911 is set up on the VoIP.ms number for the owner's own phones. |
| Costs | A daily cap on outgoing minutes and texts (settings), like `SERVICES_DAILY_TURNS`. No auto-recharge on the account is the provider-side backstop. |
| Wake word on a call | Ignored by default while the owner is on a call (the other side would hear "Marvin, …" anyway). |

## Concepts

| Term | Meaning |
| --- | --- |
| **Line** | Jarvis's registration with VoIP.ms: signed in, kept alive, ready to place and take calls. |
| **Leg** | One participant's audio in a call: a SIP call (a phone somewhere), the owner's device (web client or Android app), or Marvin's voice (text-to-speech in, transcription out). |
| **Bridge** | Joins legs: each leg hears every other leg, never itself. Records each leg on its own channel and feeds each to transcription. A two-person call is a bridge with two legs; the three-way call is a bridge with three. |
| **Screening** | Marvin's short conversation with a caller: who they are, what it's about, then the owner's rules decide (put through, take a message, voicemail). |
| **Rules** | The owner's routing rules for incoming calls: who always gets through, who's screened, quiet hours, known spam. |

## How it fits together

```
                    VoIP.ms (SIP + RTP over UDP; REST API for texts)
                         ▲                       ▲
           SIP / RTP     │                       │ HTTPS (sendSMS, getSMS polling)
┌────────────────────────┼───────────────────────┼─────────────────────────────┐
│ server                 │                       │                             │
│   phone/line ─── calls (legs) ──┐         phone/texts ── events ─▶ triggers  │
│                                 ▼                                            │
│                      phone/bridge (mix, record, transcribe)                  │
│                        ▲            ▲                ▲                       │
│      owner's device leg │   Marvin's voice leg   other SIP legs              │
│   (/api/stream, 2-way)  │   (TTS / ASR / LLM)                               │
│                        ▼                                                     │
│   archive (one channel per leg) · transcript · session · notifications      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Nothing listens on the internet. The line registers out to VoIP.ms, and NAT keep-alives hold the path open for incoming calls; texts are polled.

## The pieces

### 1. SIP (`phone/sip.ts`, `phone/line.ts`)

- Messages: parse and build SIP requests and responses (headers, `Via` branches, tags, `CSeq`, `Contact`), over UDP.
- `REGISTER` with digest authentication, renewed before `Expires`; again at once if the network changes.
- Calls out: `INVITE` (answering the 407 challenge), `ACK`, `CANCEL` while ringing, `BYE`.
- Calls in: answer `INVITE` with `180 Ringing` then `200 OK`, or `486 Busy` / `480` when Jarvis won't take it.
- `OPTIONS` (keep-alive pings from the provider) and re-`INVITE` (hold, media changes): answered.
- SDP offer and answer: one audio stream, PCMU (payload type 0) and `telephone-event` (keypad tones), `ptime:20`.

### 2. RTP and audio (`phone/rtp.ts`, `phone/g711.ts`)

- One UDP port per call; 20 ms packets of 160 bytes (μ-law), with sequence numbers and timestamps.
- μ-law ⇄ 16-bit PCM, and 8 kHz ⇄ 16 kHz resampling.
- A small jitter buffer (40–60 ms) on what comes in.
- Keypad tones (RFC 4733 `telephone-event`): sent (phone menus) and received ("press 1").

### 3. The home network (NAT)

The classic failures are one-way audio and incoming calls that never arrive. Handled by:

- **Symmetric RTP:** send from the port we advertise, and send first, so the router opens the way back.
- **The address VoIP.ms sees** (`received` / `rport` on the response to `REGISTER`) goes in `Contact` and SDP.
- **Keep-alives** every ~25 s (a CRLF or `OPTIONS`) so the router doesn't forget the mapping between registrations.

Phase 0 measures how the owner's router behaves before any of this is built.

### 4. The bridge (`phone/bridge.ts`)

- Every 20 ms: each leg's next frame (silence if none), and for each leg the sum of all the others, clipped. 16 kHz inside the bridge; SIP legs convert at their edge.
- Each leg is recorded on its own channel (Ogg Opus, with the archive's encoder) and transcribed separately, so who-said-what needs no guessing. The owner's leg is also checked against their voiceprint.
- Legs join and leave while the call goes on (screening → ringing the owner → three-way).

### 5. The owner's device as a leg

`/api/stream` today carries the microphone up (gated by voice detection) and Marvin's speech down. On a call it carries **continuous audio both ways**: no voice-detection gating, the browser's echo cancellation on, and the other side's audio played as it arrives. Headphones recommended, as for Marvin's voice today. The Android app becomes a handset (Bluetooth headset included).

### 6. Marvin's voice as a leg

Text-to-speech into the bridge, transcription out of it, the LLM deciding what to say: what Marvin uses for screening, taking messages and (later) calls of its own. Voice detection runs on the server for phone legs (Silero, which the Android app already uses, on the server's onnxruntime-node).

### 7. Texts (`phone/texts.ts`)

- Send: VoIP.ms `sendSMS` (160 characters per part; longer texts split, or MMS).
- Receive: `getSMS` polled (every 30 s; a setting), de-duplicated by message id. Each new text is an untrusted event through the same trigger path as [services](services.md): a notification, and a turn with a limited agent if a rule asks for one.
- The API needs the server's public IP on VoIP.ms's allow-list.

### 8. Tools for Jarvis

| Tool | CRUD | |
| --- | --- | --- |
| `jarvis__call` | create | Place a call and bridge it to the owner's device (after their yes). |
| `jarvis__hang_up` | update | End the current call. |
| `jarvis__send_text` | create | Send a text (after their yes, with the text read back). |
| `jarvis__list_texts` | read | Recent texts, both ways. |
| `jarvis__call_log` | read | Recent calls: who, when, how long, with a link to the recording and transcript. |

### 9. Settings

On when `VOIPMS_SIP_SERVER`, `VOIPMS_SIP_USER` and `VOIPMS_SIP_PASSWORD` are set (`PHONE=off` turns it off); texts when `VOIPMS_API_USER` and `VOIPMS_API_PASSWORD` are too. Limits: `PHONE_MAX_CALL_MINUTES` (120), `PHONE_DAILY_MINUTES` of outgoing calls (180), `PHONE_DAILY_TEXTS` (50), `PHONE_RING_SECONDS` before an unanswered incoming call is turned away (30), `PHONE_TEXT_POLL_SECONDS` (30).

A password with a `#` in it must be quoted (`VOIPMS_SIP_PASSWORD='…'`): unquoted, everything from the `#` on is a comment.

`apps/server/.env.local` (git ignores it):

```bash
VOIPMS_SIP_SERVER=toronto.voip.ms   # the nearest VoIP.ms server
VOIPMS_SIP_USER=123456_jarvis       # Jarvis's sub-account
VOIPMS_SIP_PASSWORD=…
VOIPMS_API_USER=…                   # the VoIP.ms login email
VOIPMS_API_PASSWORD=…               # the API password (not the login password)
VOIPMS_API_TOKEN=…                  # the bearer token from the API page (newer API; phase 0 checks which works)
VOIPMS_DID=6135550123               # Jarvis's number
VOIPMS_CALLER_ID=6135550199        # caller ID on calls placed for the owner: their cell, verified at VoIP.ms (empty: VOIPMS_DID)
OWNER_CELL=6135550199               # where Marvin rings the owner
```

The passwords move to the vault (`DATA_DIR/secrets.json`) once there's UI to type them in, like services' secrets.

## Incoming calls: the three-way call

```
1. Caller ──▶ Jarvis's number ──▶ Marvin answers (bridge: caller, Marvin)
   "Hi, you've reached <owner>'s assistant, Marvin. This call is recorded. Who's calling, and what's it about?"
2. Rules: put through? ── no ──▶ take a message (transcribed, notification) ──▶ hang up
          │ yes
3. Caller hears "One moment, I'll see if they're available."
   Marvin calls OWNER_CELL (new leg): "Dr. Smith's office is calling about Thursday's appointment.
   Say 'connect' or press 1 to talk, 2 and I'll take a message."
4. "connect" / 1 ──▶ the bridge joins caller and owner; Marvin stays, silent: recording and transcribing
   no answer in ~20 s, voicemail, or 2 ──▶ back to the caller: take a message
5. Hang up ──▶ recording, transcript and a short summary in Jarvis's history
```

- **Voicemail must never be connected to the caller:** the owner's leg joins only on "connect" or the 1 key (and, when it's sure, a voiceprint match).
- The owner's cell shows Jarvis's number (`VOIPMS_DID`), never the caller's own (it would be flagged as spam; see Decisions). The announcement says who's calling.
- Two calls are billed while it lasts (the incoming one and the one to the cell).

## Outgoing calls through Jarvis

"Marvin, call the dentist" → Marvin finds the number, reads it back, waits for yes → `INVITE` → the bridge joins the call and the owner's device → recorded and transcribed both ways. Afterwards: "what time did they say?" is answered from the transcript.

## Phases

| Phase | What | Done when |
| --- | --- | --- |
| **0. Test** | A script (not in the repo) that registers the sub-account once and reports the address VoIP.ms sees, then calls `getBalance` and `getDIDsInfo` (read-only). No calls, no texts, no charges. | Registration accepted; NAT behaviour known; API reachable; SMS enabled on the number. |
| **1. Line and bridge** | SIP, RTP, NAT handling, the bridge, recording; calls through Jarvis from the web client and the Android app, out and in. Audio sent for the whole call, silence included (VoIP.ms hangs up after 60 s without any). `jarvis__call`, `jarvis__hang_up`, `jarvis__call_log`. | The owner calls their own cell through Jarvis, talks both ways for 5 minutes without one-way audio, and finds the two-channel recording and transcript in History. A call to another phone shows the owner's cell as caller ID; one to the owner's cell shows the DID. |
| **2. Marvin answers** | Marvin's voice leg, screening, rules, messages, ringing the owner's cell, the three-way call. | A call from an unknown number is screened, put through to the cell on "connect", recorded on all legs; a call the owner doesn't take ends as a transcribed message. |
| **3. Texts** | Send and receive through the API; untrusted events; `jarvis__send_text`, `jarvis__list_texts`. | A text sent after a yes arrives; a reply shows up as a notification within a minute. |
| **4. Marvin calls for you** | Phone menus (keypad tones), waiting on hold and ringing the owner when a person answers; later, short calls Marvin handles itself. | Marvin gets through a phone menu, waits on hold, and connects the owner when a human picks up. |

## Where the code goes

| Path | |
| --- | --- |
| `apps/server/src/phone/sip.ts` | SIP messages: parse, build, digest authentication; SDP |
| `apps/server/src/phone/line.ts` | Registration, keep-alives, call state (out and in) |
| `apps/server/src/phone/rtp.ts`, `g711.ts` | RTP packets, jitter buffer, keypad tones; μ-law and resampling |
| `apps/server/src/phone/bridge.ts` | Mixing, per-leg recording and transcription |
| `apps/server/src/phone/phone.ts` | The call in progress, the owner's device as a leg, limits, the call log; recordings and the transcript after each call |
| `apps/server/src/phone/numbers.ts`, `transcript.ts` | North American numbers (911, N11, premium refused); cutting a leg into utterances, the transcript |
| `apps/server/src/phone/index.ts` | Starting and stopping it with the server; the tools for live replies |
| `apps/server/src/phone/screening.ts`, `rules.ts` | Marvin answering; who gets put through (phase 2, not built) |
| `apps/server/src/phone/texts.ts` | VoIP.ms API: send, poll |
| `apps/server/src/phone/tools.ts`, `routes.ts` | The `jarvis__*` tools; the HTTP API for the Phone tab |
| `apps/client/src/phone.ts` | The phone's state; this device's call audio (an AudioWorklet: microphone up, the other side down, 16 kHz) |
| `apps/client/src/components/PhonePanel.vue` | Calls, texts, the line's status (rules in phase 2) |
| `apps/server/test/phone.test.ts` | SIP parsing, digest auth (RFC 2617's example), SDP, G.711 and resampling, numbers, the bridge's mix, utterances, the two-step confirmation, texts against a fake API |

## What phase 1 does now

- **The line** registers at start-up and stays registered (renewed at 80 % of what the provider grants; retried with backoff on failure). Only packets from the provider's server are accepted.
- **Calls out**: the Phone tab (pressing Call is the owner's yes) or `jarvis__call` (two steps: a code, then the owner must have spoken or typed to Jarvis since; checked in the server). The device that placed the call carries the audio; when Jarvis places one, a screen that's listening joins. Jarvis's own microphone is muted while a device is on a call.
- **Calls in**: ring every open screen (Answer / Decline in the header and the Phone tab) for `PHONE_RING_SECONDS`, then are turned away; a missed call is a notification and a note. For calls to come to Jarvis, the number's routing at VoIP.ms must point at the sub-account (not changed yet).
- **After each call**: one Ogg Opus file per leg in `DATA_DIR/audio/calls/<id>/`, the transcript in `WORKSPACE_DIR/calls/<date time> to|from <number>.md`, a note in the active session, the call log in `DATA_DIR/phone/calls.json`.
- **Texts**: the Phone tab and `jarvis__send_text` (same two steps, the exact message read back) send; new texts are polled, shown as a notification and noted in the session as information from outside.
- **Not yet**: the Android app as a handset, live transcription during the call, Marvin answering (phase 2), texts waking Jarvis with an untrusted turn.

## Risks

| Risk | Mitigation |
| --- | --- |
| The router defeats direct SIP (one-way audio, missed incoming calls) | Phase 0 measures it; symmetric RTP, the address VoIP.ms reports, keep-alives. Asterisk is the fallback. |
| A caller talks Marvin into something | Callers are untrusted with a limited agent; no tool that sends, calls or changes anything is offered on their behalf. |
| Caller ID spoofing | It only decides screening; the worst case is a spammer being put through. |
| Charges run up (a loop, a long call) | Daily caps, a maximum call length, international off on the sub-account, no auto-recharge. |
| A restart drops calls | Accepted for now. The call log shows it; a restart could wait for calls to end later. |
| Recording without consent | The notice, on by default and always for US numbers. |
| Credentials leak | `.env.local` (ignored by git), then the vault; never in the repo, logs or the LLM's context. |

## Open questions

- Which VoIP.ms server is nearest and best for the owner (latency test in phase 0)?
- Should the owner's own calls from their cell to Jarvis's number get straight to Marvin (voiceprint), or always go through screening?
- Quiet hours and the first set of rules: who always gets through?
- Keep a recording when the other side asks not to be recorded? (Proposed: Marvin says it will stop, and stops.)
