# Speaker recognition (design)

Status: written 2026-11-05 and revised the same day with the owner's decisions below. **Built so far:** the audio archive; **M1** (model comparison, [speaker-model-eval.md](speaker-model-eval.md): 3D-Speaker CAM++ chosen); **M2** core (owner voice training, every phrase tagged, voiceprints stored); **M3** core (unknown voices grouped as "Speaker A/B", naming, corrections, combining, forgetting, backfill; the AI-tool functions exist as REST routes). **M4** part 1 (phrases split where the speaker changes, for turns without a pause). Not built yet: M4 part 2 (people talking at the same time) and M5 (the agent: voice commands, permission check, grants).

## Decisions

| Topic | Decision |
| --- | --- |
| What's recorded | **Everyone.** Every phrase, whoever said it, is transcribed, tagged and saved. |
| Audio | **All audio is kept, compressed, forever (for now)**, as a conversation archive and potential training data. A clean-up of old audio comes later, run by a script or by the AI, and it must leave recordings marked "keep forever" alone. |
| Who Jarvis acts for | **Only the owner**, recognised by voice. Others are recorded but can't give commands. |
| Exceptions | The owner can tell Jarvis to **answer one question** from someone, or to **allow someone** to use it. |
| Naming people | Learned as we go: the owner says things like "the person speaking now is Maria", and the AI tags them. **We build the mechanisms (tools); the AI decides when to use them.** |
| Devices | **Computer** at home, **phone** outside, and a **Bluetooth speaker** (always on, or with a button). |

## Goals

1. **Record and transcribe everyone.** In a conversation, both your words and the other person's are captured, with their audio.
2. **Know the owner.** Every phrase you say is tagged as you. This is what lets Jarvis take commands only from you.
3. **Learn who everyone else is, over time.** Unknown voices are grouped automatically ("Speaker A", "Speaker B"). You name them by talking to Jarvis, and from then on it recognises them, matching against saved clips of each person's voice.
4. **Let the owner grant access**, by voice, to a specific person, for one question or longer.

Same rules as the rest of Jarvis: everything runs locally, nothing leaves the machine.

### Not in the first version

- Splitting a single phrase where two people talk over each other (see [Limitations](#limitations)).
- Recognition on the phone itself. The server does it; the Android app can do it on-device later with the same library.

## Concepts

| Term | Meaning |
| --- | --- |
| **Voiceprint** (speaker embedding) | A list of ~192–512 numbers a neural network computes from a few seconds of speech. Two clips of the same person give similar lists; different people give different ones. It doesn't depend on *what* is said. |
| **Similarity** | Cosine similarity between two voiceprints: ~1.0 = same voice, ~0 = unrelated. A threshold (typically 0.5–0.7, to be measured) decides "same person". |
| **Identification** | "Which known person is this?": compare against everyone's clips, take the best match above the threshold. |
| **Enrollment** | Recording someone's voice on purpose to build their profile. Only the owner does this; others are learned from conversations. |
| **Diarization** | Splitting a recording into "who spoke when" with anonymous labels. Needed when people talk over each other. |

## Technology

### What we checked

- **audio.cpp** (already running) has *diarization* models (Sortformer, Nemotron 3 diarization: anonymous labels, up to ~4 speakers) and a `speaker` task name, but **no model that produces voiceprints**. Its CAM++/ECAPA speaker encoders exist only inside voice-cloning TTS models. So it can't identify people today. Its diarization models are useful later for overlapping speech.
- **Silero VAD** (already in the client) only answers "speech or not".

### Choice: ONNX Runtime + CAM++ on apps/server (decided in M1)

- **Model: 3D-Speaker CAM++** (VoxCeleb, English, Apache-2.0 project), 28 MB, 512-number voiceprints. Of six models compared on LibriSpeech, it tied for most accurate (0.1% EER) and was among the fastest (~130 ms per phrase on one CPU thread). Full results: [speaker-model-eval.md](speaker-model-eval.md).
- **Runtime: ONNX Runtime** (`onnxruntime-node`, Microsoft, MIT) with Kaldi-style features computed in our own TypeScript. ONNX Runtime also has an official Android library, so the phone can run the same model later.
- **Not sherpa-onnx**, as originally planned: its Node package produced wrong voiceprints on this machine (27% EER instead of 0.1% for the same model files). Its diarization may still be worth testing for M4, with the same suspicion.
- audio.cpp's diarization models (Sortformer, Nemotron 3) remain the first candidates for overlapping speech (M4).

Storage: **SQLite built into Node 24** (`node:sqlite`) for people, voiceprints, permissions and transcripts; compressed audio files next to it.

### Why on the server

The client stays thin, as agreed: the server already holds each phrase's audio, so computing voiceprints and archiving audio there costs no extra upload, battery or code on the phone.

## How it fits the current pipeline

```
client: mic → Silero VAD → send speech frames once ──► apps/server
server: frames → phrases (existing)
            ├─► voiceprint on the first ~1.5 s  → early guess: who is it?
            ├─► live re-transcription (existing), tagged with the early guess
            └─► phrase ends → voiceprint on the whole phrase → final speaker
                              → final transcription (existing), tagged
                              → audio compressed into the archive
                              → good clip? added to that person's voice library
```

- **Early guess (~1.5 s in):** shows a name tag while the person is still talking.
- **Final decision (whole phrase):** more audio = more reliable. This is what's saved, and what decides whether a command is accepted.
- Phrases shorter than ~1 s are too short to judge reliably: tagged "uncertain", or given the same speaker as the phrases around them if that's clear.

Every phrase gets one of:

| Tag | Meaning |
| --- | --- |
| **Owner** (you) | Matches your profile above the threshold. |
| **A known person** (e.g. Maria) | Matches that person's clips above the threshold. |
| **Speaker A / B / …** | A voice heard before but not named yet. |
| **Uncertain** | Too short, a mix of voices, or too close to call. Shown with its best guess so it can be corrected. |

## Audio archive

All phrase audio is kept, compressed, linked to its transcript and speaker tag.

- **Format: Opus at ~32 kbps mono, 16 kHz** (~14 MB per hour of speech; silence is never recorded, so an hour of conversation is usually much less). Measured: transcription of decoded Opus is word-for-word identical to the original, and voiceprint accuracy barely changes (CAM++ EER 0.1% → 0.2%), so lossless FLAC (~55 MB/hour) isn't needed.
- One file per phrase (or per conversation, with phrase offsets); exact layout decided at build time.
- **Speaker tags can change later** (a correction, a merge, a new name), so the archive stores the audio and the *current* tag, plus a history of changes. That keeps the training data's labels accurate.
- Encoding happens on the server. The Opus encoder library for Node is chosen at build time (several WebAssembly ones exist; nothing is installed yet).

### Retention

- **For now, nothing is deleted.** Opus at 32 kbps is ~14 MB per hour of speech, so even heavy use stays in the tens of GB per year.
- Every recording carries a **`keep` flag** (with an optional note) from the start, so marking things as "keep forever" works before any clean-up exists. You can set it in the UI or by voice through the AI ("keep this conversation").
- **Later: a clean-up job** deletes old *audio* (transcripts and tags stay) by rules such as age, skipping anything marked `keep`. It can be a scheduled script, or a tool the AI calls (`cleanup_audio(older_than, dry_run)`), which first reports what it would delete.

## People's voice libraries

Separate from the archive: each person (including you) has a small, curated library of **clips** of their voice, plus the voiceprint of each. Matching a new phrase compares it against these.

**Which clips are kept** (so libraries stay small and clean):

- Only phrases matched with **high confidence**, or that were named or corrected explicitly.
- Clean single-speaker audio: 2–10 s, mostly speech, not too noisy.
- Varied: different days, **devices** and moods, so the library covers how the person really sounds.
- Capped per person (e.g. 30–50 clips, ~5 min of audio). When full, the most redundant clip is dropped (it stays in the archive).

Because all audio is archived, libraries can always be rebuilt, and voiceprints recomputed with a better model later, without re-enrolling anyone.

## Enrollment (owner only)

1. A "Train my voice" screen: read ~6–10 short prompts aloud (about 30–60 s of speech). These become your first clips.
2. Each recording is checked: long enough, not too noisy, consistent with the others.
3. **On each device:** computer, phone, and the Bluetooth speaker. The same voice through each sounds noticeably different to the model (see [Devices](#devices)). After that, adapting (below) keeps each up to date.

Other people don't enroll: they're learned from conversations.

## Learning over time

- **Grouping unknown voices:** phrases that don't match anyone are compared with each other and grouped into "Speaker A", "Speaker B".
- **Naming by voice:** you say "the person speaking now is Maria"; the AI calls the naming tool (see [Mechanisms for the AI](#mechanisms-for-the-ai)). The group becomes Maria, and its clips become her library.
- **Naming in the UI:** click a tag, listen to clips, type a name. Same effect.
- **Corrections teach it:** retagging a phrase moves its clip to the right person.
- **Merging and splitting:** "A and C are both Maria", or "this group is actually two people".
- **Adapting:** confident matches add new clips (within the cap), so each library keeps up with new devices and situations. Only confident matches, so a library can't slowly drift towards someone else.
- **Forgetting:** delete a person and their library, voiceprints and permissions go with them. Their archived audio is relabelled "unknown", or deleted too if you choose.

## Commands and permissions

When Jarvis acts on speech (the agent, later), **whether a phrase may give a command is decided by server code, never by the AI.** The AI only sees requests that already passed this check. Otherwise anyone in the room could talk the AI into it ("Charbel said I'm allowed").

A phrase may be acted on only if its **final** speaker tag (not the early guess) is:

1. **The owner**, with high confidence; or
2. **A person with an active grant** from the owner, with high confidence.

Uncertain phrases are never acted on. Jarvis can ask "was that you?" instead.

**Grants** (given only by the owner, by voice or in the UI):

| Owner says | Grant |
| --- | --- |
| "Answer Maria's question." / "Go ahead, answer her." | **Once:** Maria's next request is accepted, then the grant ends. |
| "Let Maria use you for the next hour." | **Timed:** until it expires. |
| "Maria can always use you." | **Standing:** until revoked. |
| "Stop listening to Maria." | Revokes any of the above. |

Grants are stored with who, scope, when given and when they expire, and shown in the UI. Unnamed speakers can be granted too ("answer this person"), via their group.

## Mechanisms for the AI

The AI (the agent, later) decides *when* to name someone or grant access, from what you say. These tools are how it does it. The server checks every call, so tools that change names or permissions **only work when the request came from the owner's own voice**.

| Tool | What it does | Owner-only |
| --- | --- | --- |
| `recent_speakers(minutes)` | Who has spoken recently, in order, with their latest phrases and tags. How the AI resolves "the person speaking now" / "her" / "the last person". | No (read-only) |
| `list_people()` | Named people and unnamed groups, with clip counts and last heard. | No (read-only) |
| `name_speaker(speaker, name)` | Name an unnamed group, or create a person from it. `speaker` is a group id or "the most recent speaker other than the owner". | Yes |
| `retag_phrase(phrase, person)` | Correct one phrase's speaker; its clip moves accordingly. | Yes |
| `merge_people(a, b)` | "A and C are the same person." | Yes |
| `grant(person, scope, expires?)` | `scope`: once, timed or standing. | Yes |
| `revoke(person)` | End a person's grants. | Yes |
| `forget_person(person, delete_audio?)` | Remove a person entirely. | Yes |
| `keep_recording(conversation \| phrase, note?)` | Mark audio "keep forever", so a future clean-up skips it. | Yes |

"The person speaking now" is resolved from conversation context: when you say it, the most recent speaker other than you in the last minute or so. If that's ambiguous (several people), the AI asks.

## Devices

| Device | Where | What it means for recognition |
| --- | --- | --- |
| **Computer** (web client) | Home | Best audio. The baseline. |
| **Phone** (Android app, later) | Outside | Good mic, but noisier places; cellular upload (already minimised). |
| **Bluetooth speaker** (always on, or with a button) | Either | **Lowest quality:** Bluetooth microphones use the headset/hands-free profile, at best 16 kHz "wideband" (fine for our 16 kHz pipeline), at worst 8 kHz "narrowband", which noticeably hurts both transcription and voice matching. Echo from the speaker's own playback has to be cancelled. |

- **Enroll the owner on each device** (or at least computer + Bluetooth), and let the libraries adapt.
- **Speaker with a button:** the button can be push-to-talk or "Jarvis, listen" through the phone or computer it's paired with (Android receives Bluetooth media-button presses). An always-on speaker relies on voice detection instead, like today.
- **M1 measures all three**, including whether the Bluetooth link runs at 16 kHz or 8 kHz.

### Choosing the Bluetooth device

The category that fits best is the **conference speakerphone** (e.g. Jabra Speak2, Anker PowerConf, EPOS Expand), not a music speaker. They are built for exactly this: always on, several microphones that pick up a whole room, echo cancellation, physical buttons, and long battery life. Music speakers that list LC3 or a microphone usually aren't tested for call-quality pickup.

Look for:

1. **Wideband or super-wideband voice** (often called "HD voice"). On Bluetooth that means mSBC (16 kHz), or LC3-SWB / LE Audio (32 kHz). Avoid anything that only does 8 kHz narrowband.
2. **USB as well as Bluetooth.** Plugged into the computer over USB, the microphone isn't limited by Bluetooth's call profile, so you get its full quality at home; Bluetooth is then for the phone.
3. **A microphone array with echo cancellation**, so its own speaker doesn't end up in the recording.
4. **No cloud features required** to use the microphone (it should work as a plain USB/Bluetooth device).
5. If it's LE Audio, **check that your phone supports LE Audio calls** too; both ends need it.

Whether its buttons can serve as Jarvis's button (push-to-talk) depends on what events it sends; test that before relying on it.

## Data and privacy

- Clips and voiceprints are **biometric data**, and the archive holds private conversations. All stored only in local files on the server, never sent anywhere.
- One place to see, play, export and delete everything Jarvis keeps about each person.
- **Recording other people:** let people know Jarvis is recording, and check the rules where you live. (In Canada, recording a conversation you're part of is generally allowed; other places require everyone's consent.) Using recordings of other people as training data may need their agreement.

## Changes to the protocol and UI (sketch)

- `phrase` messages gain `speaker: { id, name, isOwner, similarity, confidence: "high"|"low"|"uncertain" }`.
- New REST routes: people (list, rename, merge, delete), clips and archive (list, play, delete, export), owner enrollment, grants, transcript history.
- Transcript: a coloured name tag per phrase; click it to correct.
- People page: each person or unnamed group, their clips with playback, grants, name/merge/delete.
- Monitor: the best match and its similarity per phrase, against the threshold, to tune it.
- Settings: identification threshold.

## Limitations

- **Overlapping speech.** In real conversations people interrupt and talk over each other. A phrase containing two voices matches nobody well: tagged "uncertain" (and never acted on) in the first version. Later, diarization (sherpa-onnx or audio.cpp's Sortformer) splits it first.
- **Phrase boundaries in a conversation.** Today a phrase ends at a pause. If the other person answers right away with no pause, both voices land in one phrase. M4 fixes this by also splitting phrases when the voice changes.
- **Distance.** The other person is usually farther from the mic than you, so their audio is quieter and more reverberant. Their clips cover that naturally.
- **The TV and other background voices** are recorded too, as unknown speakers. You can name them ("TV") or delete them.
- **Voice is not strong security.** A recording or a good imitation of your voice could give a command. Fine for an assistant at home; anything sensitive (payments, unlocking, sending messages) should need an extra confirmation later.
- **Similar voices** (e.g. family members) are harder; the threshold may need to be stricter.
- **Short phrases** ("yes", "mm-hm") carry little voice information.

## Milestones

| # | What | Done when |
| --- | --- | --- |
| **M1. Spike** ✅ | Compare CAM++, WeSpeaker and TitaNet (accuracy, best threshold, speed, noise) and the effect of Opus. Done on LibriSpeech; real-device numbers come from M2 in use. | CAM++, threshold ~0.43, Opus 32 kbps is fine ([results](speaker-model-eval.md)). |
| **M2. Know the owner + archive** ✅ core | Enrollment screen; every phrase tagged "you" or "someone else"; similarity in the Monitor; compressed audio archive with transcripts and tags. | In a two-person test conversation, your phrases are tagged correctly and everything is archived. |
| **M3. Who's who** ✅ core | Grouping unknown voices, naming in the UI, merging, corrections, adapting, delete; the people page. | Over a few sessions, named people are tagged correctly. |
| **M4. Conversations** ✅ part 1 | Split phrases when the voice changes; diarization for overlapping speech. | Quick back-and-forth and interruptions are tagged correctly. |
| **M5. With the agent** | The permission check; grants; the AI tools above, so naming and granting work by voice. | "The person speaking now is Maria" and "answer her question" work, and nobody else can give commands. |

## Open questions

1. **Bluetooth device:** not chosen yet. See [Choosing the Bluetooth device](#choosing-the-bluetooth-device).
