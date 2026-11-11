# Jarvis for Android

Jarvis from the phone. Specification and milestones: [docs/android-client.md](../../docs/android-client.md).

**Now:** press **Start listening** and the phone listens until you press **Stop listening** (on the screen, or in the notification), with the screen off, the phone locked or the app closed. Voice detection runs on the phone (Silero VAD v5, the web client's model), so only speech is sent. The server transcribes and keeps everything it hears, recognises who's talking, and answers "Jarvis, …" (then follow-ups without the name), through the phone's speaker or a connected headset. The screen shows the last phrases heard and the reply.

Native Kotlin, Android 10+ (API 29), built against API 36, 64-bit ARM only. Libraries: OkHttp (the WebSocket) and ONNX Runtime (voice detection; most of the 40 MB APK). Package `dev.jarvis.phone`.

| File | What |
| --- | --- |
| `MainActivity.kt` | The screen: server, key, Start / Stop listening, Stop talking, what was heard |
| `ListeningService.kt` | The foreground service (type microphone) with its notification; voice detection and the send gate (speech plus pre-roll and hang-over, from the server's settings); the server's messages |
| `JarvisLink.kt` | The WebSocket to `/api/stream` (the web client's protocol), sign-in, reconnects, trusting a self-signed certificate |
| `Microphone.kt` | 16 kHz mono in 32 ms frames, voice-call processing (echo cancellation) |
| `Vad.kt` | Silero VAD v5 on ONNX Runtime: speech probability per frame |
| `SpeechPlayer.kt` | Jarvis's sentences (WAV) in order; stop, continue, repeat; reports playing / stopped / idle |
| `Settings.kt` | Server address, trusted certificate, access key (encrypted with the Android Keystore) |

The first Start listening asks for the microphone and notifications, and once to leave Jarvis out of battery optimisation (otherwise the phone cuts its network while asleep). Some phone makers have their own app-killers on top: if listening stops by itself with the screen off, allow Jarvis to run in the background in the phone's battery settings.

## Build

One-time setup of this computer (JDK, Android SDK): [docs/android-client.md](../../docs/android-client.md#one-time-setup-ubuntu-2604).

```bash
cd apps/android
./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
```

The first build downloads Gradle 9.8.2 (checksum pinned in `gradle/wrapper/gradle-wrapper.properties`), the Android Gradle Plugin 9.4.1 and OkHttp; later builds take seconds.

Versions are held back on purpose: OkHttp 5.5 needs API 37 to compile against, and Ubuntu's SDK packages stop at 36.

## Install on the phone

1. On the phone: *Settings → About phone*, tap *Build number* 7 times; then *Settings → System → Developer options*, turn on *USB debugging* (or *Wireless debugging*, Android 11+).
2. Connect it (USB, and accept the prompt on the phone; or `adb pair <ip>:<port>` with the code from *Wireless debugging*, then `adb connect <ip>:<port>`).
3. `adb devices` lists it; then:
   ```bash
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```
   `-r` updates it in place, keeping its settings.

The debug build is signed with `~/.android/debug.keystore` (made by the first build). Every update must be signed with the same key: back that file up. A release key comes with a release build.

## Connect

- **Server address:** the web client's address on the network, e.g. `https://192.168.1.50:5173` (the dev server passes `/api` on to Jarvis), or a Tailscale HTTPS address later. `https` only.
- **Access key:** the same one the web client asks for (printed in the server's log at start, kept in `apps/server/data/access-key`).
- **Certificate:** the dev server's certificate is self-signed, so the first connection says Android doesn't trust it and shows its SHA-256 fingerprint. *Trust this certificate* remembers it for that address. Check it's your server's: `openssl s_client -connect 127.0.0.1:5173 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256` on the computer.
