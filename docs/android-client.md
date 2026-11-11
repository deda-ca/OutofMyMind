# Android client (specification)

Status: specification, written 2026-11-10. **Built** ([apps/android](../apps/android/README.md)): A1 (connection, replies) and the core of A3 (always listening with the screen off: foreground service, voice detection on the phone) through the phone's own microphone; the owner chose Start / Stop listening over hold to talk. The server's push-to-talk message (below) is built too, for the headset button later. Not yet: A2 (the Bluetooth headset's microphone and button), A4, A5. Open questions are at the [end](#open-questions).

## The idea

Jarvis from the phone, through a Bluetooth headset, with the phone in a pocket: **audio only**, no screen needed. You talk, Jarvis answers in your ear. It keeps working with the screen off and the phone locked, and it's careful with both the phone's battery and the headset's.

The phone is only ears and a mouth. Transcription, speaker recognition, the wake word, the LLM, tools, text to speech: all of it stays on the Jarvis server at home, exactly as for the web client. The app speaks the same WebSocket protocol as the web client ([apps/server/src/stream/protocol.ts](../apps/server/src/stream/protocol.ts)), so the server needs only small additions.

## Decisions

| Topic | Decision |
| --- | --- |
| Scope of V1 | **Audio only:** listen, send speech, play Jarvis's replies. One small settings screen. No transcript, no chat, no tabs. |
| Platform | **Native Kotlin** (Android 10+, API 29; target the current API). Background audio, Bluetooth routing and foreground services are native APIs; a web view or cross-platform layer would only get in the way. |
| Where the work happens | **The server**, as now. The phone runs voice detection (so only speech is sent) and plays audio. |
| Listening | **Two modes**, chosen in settings (see [Listening modes](#listening-modes)): *always listening* (the default you asked for) and *headset button* (much lighter on batteries). |
| Running in the background | A **foreground service** of type `microphone`, with its ongoing notification, plus an exemption from battery optimisation. |
| Reaching the server | At home: the LAN. Away: **Tailscale** (encrypted, no port opened on the router), with `tailscale serve` giving the server a real HTTPS certificate. Same address both ways. |
| Sign-in | The existing **access key**, sent as `Authorization: Bearer <key>`, kept in the Android Keystore. |
| Distribution | **Sideloaded** (no Play Store): `adb install` over USB or Wi-Fi while building; an APK link later. One signing key, kept out of git. |
| Code | `apps/android/` in this repository, built with Gradle from the command line. |

## What it does (V1)

1. You put the headset on and start the app once (or tap its notification). It connects to the server and shows an ongoing notification: "Jarvis is listening".
2. You lock the phone and put it away.
3. You say "Jarvis, what's the weather tomorrow?". The phone hears speech, sends it to the server, the server recognises you and the wake word, and Jarvis's answer plays in the headset, sentence by sentence.
4. Follow-ups work as on the computer: within the follow-up window, no "Jarvis" needed. "Thanks, Jarvis" ends the conversation.
5. "Stop", "continue", "repeat" work by voice; the headset's play/pause button stops Jarvis talking.
6. If the connection drops (tunnel, lift, Wi-Fi to mobile data), it reconnects by itself and says so with a short tone, not words.

## Listening modes

The choice is mostly about batteries, because of how Bluetooth headsets work: a headset's **microphone is only available in "call mode"** (HFP, the same link as a phone call). Music mode (A2DP) has no microphone. Holding call mode open all the time drains a headset roughly as fast as a long phone call, and it lowers audio quality to call quality while it's open.

| | Always listening | Headset button |
| --- | --- | --- |
| How you start | Say "Jarvis, …" any time | Press the headset's button, then talk |
| Headset microphone | Open all the time (call mode) | Open only while you talk to Jarvis, then closed again |
| Headset battery | Like being on a call the whole time: hours, not days | Barely affected |
| Phone battery | Voice detection runs continuously (small, but all day) | Nothing runs between presses |
| Music while listening | Interrupted (call mode takes over the headset) | Plays normally until you press |
| Wake word | Needed (the server listens for "Jarvis") | Not needed: the press means "this is for Jarvis" |

**LE Audio** headsets (Bluetooth LE with LC3, on Android 13+ phones) do this much better: the microphone link is cheaper and keeps wideband quality. If the headset supports it, always listening becomes reasonable for a full day. Which headset you use decides how good always listening can be (see [Open questions](#open-questions)).

In always-listening mode, the app also gives up the microphone while a real phone call is going on, and takes it back afterwards.

## How it works

```
 Headset mic ──(HFP / LE Audio)──▶ AudioRecord 16 kHz mono (VOICE_COMMUNICATION: echo cancellation)
                                        │ 32 ms frames
                                        ▼
                                Silero VAD v5 (ONNX Runtime, on the phone)
                                        │ speech only (+ pre-roll and hang-over)
                                        ▼
                     WebSocket wss://<server>/api/stream  (same protocol as the web client)
                                        │
 Headset speaker ◀── AudioTrack ◀── assistant.audio (WAV per sentence), assistant.control
```

### Audio in

- `AudioRecord`, 16 kHz, mono, 16-bit, source `VOICE_COMMUNICATION` (Android's echo cancellation and noise suppression; also what routes to the headset microphone).
- Route to the headset with `AudioManager.setCommunicationDevice` (Android 12+; `startBluetoothSco` on 10–11). Fall back to the phone's own microphone when no headset is connected, and say so in the notification.
- Frames of 512 samples (32 ms), as the web client.

### Voice detection (on the phone)

- **Silero VAD v5**, the same model the web client runs, in ONNX Runtime for Android (about 2 MB). The server's settings (speech threshold, pre-speech pad, send hang-over) apply unchanged.
- Only speech is sent: a frame is sent once speech starts, with the `preSpeechPadMs` before it, and until `sendHangoverMs` after it ends. Silence costs no data.
- Battery: Silero is small, but running it 31 times a second all day adds up. A cheap first stage (energy level, or the WebRTC VAD) skips Silero on quiet frames. To be measured (see [Battery](#battery)).

### The connection

- `wss://` to `/api/stream` with `Authorization: Bearer <access key>` (OkHttp WebSocket).
- First message `{"type":"start","sampleRate":16000,"device":"android","mode":"conversation","settings":{…}}`, then binary frames `[float32 speech probability][s16le PCM]`, exactly as the web client.
- Ping every 30 s; reconnect with back-off (1 s, 2 s, 5 s, then every 15 s) on loss or network change (`ConnectivityManager.NetworkCallback`). Audio during a reconnect is dropped, not queued: a request from a minute ago is worse than none.

### Audio out

- `assistant.audio` messages carry one sentence of Jarvis's reply as a base64 WAV: decode and queue them on an `AudioTrack`, in `seq` order, dropping a reply that's been superseded (same rules as the web client's `SpeechPlayer`).
- Report the player's state with `{"type":"playback","state":…}`, so barge-in and the follow-up window work as on the computer.
- `assistant.control` (stop, continue, repeat, resume) from voice commands is obeyed.
- Short tones (not words) for: connected, lost connection, back. Nothing for normal operation.

### Headset button

- A `MediaSession` receives the headset's play/pause button while the app runs.
- While Jarvis talks: stops it (as "stop").
- In headset-button mode, when idle: opens the microphone, plays a short tone, and the next phrase goes to Jarvis without the wake word. The microphone closes when the phrase ends (or after 8 s of silence).
- In always-listening mode, when idle: passes the press on (so it still pauses music).

### Running in the background

- A foreground service (`foregroundServiceType="microphone"`, Android 14+ also needs `FOREGROUND_SERVICE_MICROPHONE`) with an ongoing notification: status, and buttons **Mute** and **Stop**.
- Android 14+ only lets a microphone service start while the app is visible, or from a tap on its notification. So after a reboot it doesn't start by itself: a notification "Tap to start Jarvis" appears instead (from `BOOT_COMPLETED`, if enabled).
- A partial wake lock only while audio is flowing (speech being sent, a reply playing); none while idle-listening, since `AudioRecord` keeps the process going.
- The app asks once to be exempted from battery optimisation (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`), or Doze would cut the network while the phone is still. Some phone makers (Samsung, Xiaomi, …) add their own app-killers; the setup screen links to the right setting where it can tell.

### The settings screen

The only screen, for setup:
- Server address (`https://jarvis.<tailnet>.ts.net`) and access key (pasted once, or from a QR code the web client shows, see [server changes](#server-changes)).
- Listening mode, and "start when the phone starts".
- Status: connected or not, headset found or not (and whether it's LE Audio), what's been sent today.
- A **Test** button: says "Hello" through the headset and checks the microphone level.

### Privacy and security

- Nothing is recorded on the phone; audio goes straight to the server and isn't kept on the device.
- Only speech leaves the phone (voice detection decides), only to the configured server, only over TLS.
- The access key is in the Android Keystore; it's never logged. The app has no other permissions than microphone, Bluetooth connect, notifications, foreground service and network.
- The ongoing notification always says the microphone is in use. **Mute** stops sending immediately (the microphone stays open, so unmuting is instant); **Stop** releases it.

## Server changes

Small, and useful to the web client too:

1. **Push to talk** (built): `{"type":"talk","state":"start"}` when the button goes down, `{"type":"talk","state":"end"}` when it's let go. What's said in between is for Jarvis without the wake word (the voice must still be the owner's), and "end" finishes the phrase at once instead of waiting for a pause. A1's hold-to-talk button uses it; headset-button mode will too.
2. **Reachable from the phone:** document running behind `tailscale serve` (HTTPS with a real certificate, forwarding to `127.0.0.1:5180`), and allow requests with no `Origin` (native clients send none; already allowed). The server keeps listening on localhost only.
3. **Pairing:** the web client shows a QR code with the server address and access key, so the phone is set up by scanning instead of typing.
4. **Device in the session:** phrases from the phone are tagged `android`, as the archive already records the device.
5. Later: **Opus** upload instead of raw PCM (about 10× less mobile data), and service notifications pushed to the phone (below).

## Battery

Targets, to be checked on the real phone and headset before V1 is called done:

| | Always listening | Headset button |
| --- | --- | --- |
| Phone, idle (listening, nobody talking) | under 3% an hour | under 0.5% an hour |
| Phone, while talking to Jarvis | not a concern (short) | same |
| Headset | as long as a phone call lasts on it (classic Bluetooth); much longer with LE Audio | close to its normal music time |
| Mobile data | speech only: about 2 MB per minute of speech (raw PCM; about 0.2 MB with Opus later) | same |

Measured with Android's battery statistics (`dumpsys batterystats`) over a few hours of each mode.

## Out of scope for V1

- A transcript or chat screen, typing to Jarvis, the session list.
- Notifications from Jarvis on the phone (alarms, reminders, service notifications through `/api/notifications/stream`). The next step after V1, since schedules and services now produce them.
- Voice training from the phone, and speaker recognition on the phone.
- The phone's own speaker as Jarvis's voice with the microphone open (needs echo handling).
- Android Auto, watches, wake word on the phone itself.

## Milestones

1. **A1, connection:** the app connects with the access key, sends the phone's microphone while a button is held, and plays Jarvis's replies through the phone. Proves the protocol and audio path.
2. **A2, headset:** routing to and from the Bluetooth headset, the headset button, headset-button mode end to end (with the server's push-to-talk message).
3. **A3, always listening:** the foreground service, on-phone voice detection, the wake word via the server, screen off and locked.
4. **A4, robustness:** reconnects across network changes, phone calls, headset disconnects, reboots, Doze and battery optimisation, the phone maker's app-killer.
5. **A5, measured:** the battery targets above, on your phone and headset; settings tuned.

Each milestone is installed on the phone with `adb install` and tried in real use before the next.

## Building and installing

### One-time setup (Ubuntu 26.04)

Done on 2026-11-10 on this computer; repeat these steps on a new one. No Android Studio and no separate Gradle are needed (the project brings its own `./gradlew`; Gradle downloads the Kotlin compiler and the Android Gradle Plugin on the first build).

1. **A JDK:** JDK 25 is installed (`javac -version` → 25). JDK 21 is the fallback if the Android build tools ever complain about 25.
   ```bash
   sudo apt install openjdk-25-jdk
   ```
2. **The Android SDK**, from Ubuntu's "installer" packages: each one downloads Google's official SDK component into `/usr/lib/android-sdk` when installed. They also pull in `google-android-licenses` (Google's Android SDK licence, which you're asked to accept), `po-debconf` and `default-jre-headless`.
   ```bash
   sudo apt install \
     google-android-cmdline-tools-19.0-installer \
     google-android-platform-tools-installer \
     google-android-build-tools-36.0.0-installer \
     google-android-platform-36-installer \
     android-udev-rules
   ```
   | Package | Gives |
   | --- | --- |
   | `google-android-cmdline-tools-19.0-installer` | `sdkmanager` |
   | `google-android-platform-tools-installer` | `adb` |
   | `google-android-build-tools-36.0.0-installer` | build tools 36.0.0 |
   | `google-android-platform-36-installer` | the Android 16 (API 36) platform to build against: the newest Ubuntu packages, so the app's `compileSdk` is 36 |
   | `android-udev-rules` | lets `adb` reach a phone over USB without root (you must be in the `plugdev` group) |

   Use `android-udev-rules`, **not** `android-sdk-platform-tools-common`: the latter conflicts with `google-android-platform-tools-installer` and apt refuses the whole install.
3. **The environment**, at the end of `~/.bashrc` (then open a new terminal). `sdkmanager` and `adb` are also linked into `/usr/bin`, so this is mainly for Gradle, which reads `ANDROID_HOME`:
   ```bash
   export ANDROID_HOME=/usr/lib/android-sdk
   export PATH=$PATH:$ANDROID_HOME/platform-tools
   ```
4. **Check:**
   ```bash
   adb version                    # Android Debug Bridge version 1.0.41, Version 36.0.0-…
   sdkmanager --list_installed    # build-tools;36.0.0, cmdline-tools;19.0, platform-tools, platforms;android-36
   ```

The SDK is owned by root. If a build ever asks for an SDK component that isn't there, Gradle can't download it itself: install the matching `google-android-…-installer` package (`apt-cache search google-android` lists them), or run `sudo sdkmanager "<component>"`.

### Building and installing the app

- See [apps/android/README.md](../apps/android/README.md): `./gradlew assembleDebug` builds the APK; `adb install -r` installs or updates it (USB, or wireless debugging on Android 11+).
- Versions: Gradle 9.8.2 (wrapper, checksum pinned), Android Gradle Plugin 9.4.1 with its built-in Kotlin, OkHttp 5.4.0 (5.5 needs API 37, which Ubuntu doesn't package yet).
- A signing key for Jarvis, kept outside git (like `.env.local`): every update must be signed with it, or Android refuses to update without uninstalling.

## Open questions

1. **Default listening mode:** always listening (what you asked for, heavy on the headset) or headset button (light)? Both are built; this is only the default.
2. **Which headset?** Its model decides whether LE Audio is available, which is what makes always listening last a day.
3. **Which phone (and Android version)?** Some makers stop background apps aggressively; knowing the phone lets the setup point to the right setting.
4. **Away from home:** is Tailscale fine (an app on the phone and on this computer, free for personal use)?
