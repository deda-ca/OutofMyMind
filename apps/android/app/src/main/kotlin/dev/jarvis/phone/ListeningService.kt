package dev.jarvis.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Listening, with the screen off and the phone locked: a foreground service
 * (type microphone) with an ongoing notification, from "Start listening" until
 * "Stop listening" (on the screen or in the notification).
 *
 * Everything heard goes through voice detection on the phone, and only speech
 * (with a little before and after it) is sent to the server, which
 * transcribes and keeps all of it, recognises who's talking, and answers when
 * you say "Jarvis" (then follow-ups without it). Jarvis's replies play
 * through the phone's speaker, or a connected headset.
 */
class ListeningService : Service(), JarvisLink.Listener {
    /** What the screen shows (read on the main thread). */
    object Status {
        var listening = false
        var connected = false
        var connection = ""
        /** Speech is being sent right now. */
        var hearing = false
        var talking = false
        /** Fingerprint of a certificate Android doesn't trust, for the owner to decide. */
        var untrusted: String? = null
        val heard = ArrayDeque<String>()
        var reply = ""
        val observers = LinkedHashSet<() -> Unit>()

        fun changed() = observers.toList().forEach { it() }
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var settings: Settings
    private var link: JarvisLink? = null
    private var player: SpeechPlayer? = null
    private var mic: Microphone? = null
    private var vad: Vad? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var replyId = -1

    // The send gate (the mic thread): speech, with a pre-roll before it and a hang-over after it.
    @Volatile private var threshold = 0.5f
    @Volatile private var preRollFrames = 300 / Microphone.FRAME_MS
    @Volatile private var hangoverFrames = 1500 / Microphone.FRAME_MS
    private val preRoll = ArrayDeque<ByteArray>()
    private var sending = false
    private var hangoverLeft = 0
    private var lastHearingUpdate = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopListening()
            else -> startListening()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        shutDown()
        if (current === this) current = null
        super.onDestroy()
    }

    private fun startListening() {
        if (Status.listening) return
        settings = Settings(this)
        createChannel()
        startForeground(NOTIFICATION_ID, notification("Connecting…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        Status.listening = true
        Status.untrusted = null
        Status.changed()

        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jarvis:listening").apply {
            setReferenceCounted(false)
            acquire()
        }
        val link = JarvisLink(this).also { this.link = it }
        player = SpeechPlayer(this) { state ->
            link.send(JSONObject().put("type", "playback").put("state", state))
            Status.talking = state == "playing"
            Status.changed()
        }
        try {
            vad = Vad(this)
        } catch (e: Exception) {
            fail("Voice detection couldn't start: ${e.message}")
            return
        }
        mic = Microphone(onFrame = ::onFrame, onError = { why -> main.post { fail(why) } })
        try {
            mic!!.start()
        } catch (e: Exception) {
            fail(e.message ?: "The microphone couldn't be opened")
            return
        }
        link.connect(settings.serverUrl, settings.accessKey, settings.pinnedFingerprint)
    }

    private fun stopListening() {
        shutDown()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun fail(why: String) {
        Status.connection = why
        stopListening()
    }

    private fun shutDown() {
        mic?.stop()
        mic = null
        link?.send(JSONObject().put("type", "stop"))
        link?.close()
        link = null
        player?.close()
        player = null
        vad?.close()
        vad = null
        wakeLock?.release()
        wakeLock = null
        synchronized(preRoll) { preRoll.clear() }
        sending = false
        Status.listening = false
        Status.connected = false
        Status.hearing = false
        Status.talking = false
        Status.changed()
    }

    /** One frame from the microphone (its thread): voice detection, then the send gate. */
    private fun onFrame(samples: ShortArray) {
        val vad = vad ?: return
        val link = link ?: return
        val p = try { vad.probability(samples) } catch (_: Exception) { 0f }
        val packet = ByteBuffer.allocate(4 + samples.size * 2).order(ByteOrder.LITTLE_ENDIAN).apply {
            putFloat(p)
            for (s in samples) putShort(s)
        }.array()
        val speech = p >= threshold
        synchronized(preRoll) {
            if (speech) {
                if (!sending) {
                    for (earlier in preRoll) link.sendAudio(earlier)
                    preRoll.clear()
                    sending = true
                }
                hangoverLeft = hangoverFrames
            }
            if (sending) {
                link.sendAudio(packet)
                if (!speech && --hangoverLeft <= 0) sending = false
            } else {
                preRoll.addLast(packet)
                while (preRoll.size > preRollFrames) preRoll.removeFirst()
            }
        }
        // The "hearing speech" dot on screen, at most a few times a second.
        val now = SystemClock.elapsedRealtime()
        if (sending != Status.hearing && now - lastHearingUpdate > 250) {
            lastHearingUpdate = now
            val hearing = sending
            main.post {
                Status.hearing = hearing
                Status.changed()
            }
        }
    }

    // ── The server ─────────────────────────────────────────────────────────

    override fun onState(state: JarvisLink.State, detail: String) {
        Status.connected = state == JarvisLink.State.CONNECTED
        Status.connection = if (Status.connected) "Listening" else detail
        updateNotification(if (Status.connected) "Listening" else detail)
        // The link gives up only when retrying can't help (a wrong key, an untrusted certificate):
        // then there's no point keeping the microphone open.
        if (state == JarvisLink.State.DISCONNECTED && Status.listening) {
            fail(detail)
            return
        }
        Status.changed()
    }

    override fun onUntrustedCertificate(fingerprint: String) {
        Status.untrusted = fingerprint
    }

    override fun onMessage(message: JSONObject) {
        val player = player ?: return
        when (message.optString("type")) {
            "ready", "settings" -> message.optJSONObject("settings")?.let { s ->
                threshold = s.optDouble("speechThreshold", 0.5).toFloat()
                preRollFrames = (s.optInt("preSpeechPadMs", 300) / Microphone.FRAME_MS).coerceAtLeast(0)
                hangoverFrames = (message.optInt("sendHangoverMs", 1500) / Microphone.FRAME_MS).coerceAtLeast(1)
            }
            "phrase" -> if (message.optBoolean("final")) {
                Status.heard.addLast(message.optString("text"))
                while (Status.heard.size > 6) Status.heard.removeFirst()
            }
            "assistant.start" -> {
                replyId = message.optInt("replyId")
                Status.reply = "…"
            }
            "assistant.delta" -> if (message.optInt("replyId") == replyId) Status.reply = (if (Status.reply == "…") "" else Status.reply) + message.optString("delta")
            "assistant.done" -> {
                player.replyDone(message.optInt("replyId"))
                if (message.optInt("replyId") == replyId) Status.reply = message.optString("text")
            }
            "assistant.cancel" -> if (message.optInt("replyId") == replyId) Status.reply = ""
            "assistant.error" -> {
                player.replyDone(message.optInt("replyId"))
                Status.reply = "⚠ ${message.optString("message")}"
            }
            "assistant.audio" -> {
                val wav = try { Base64.decode(message.optString("wav"), Base64.DEFAULT) } catch (_: Exception) { return }
                player.add(message.optInt("replyId"), message.optInt("seq"), wav)
            }
            "assistant.control" -> when (message.optString("action")) {
                "stop" -> player.stop()
                "continue", "resume" -> player.continueSpeaking()
                "repeat" -> player.repeat(message.optInt("replyId"))
            }
            "error" -> Status.connection = "⚠ ${message.optString("message")}"
            else -> return
        }
        Status.changed()
    }

    /** "Stop talking" on the screen. */
    fun stopTalking() = player?.stop()

    // ── The notification ───────────────────────────────────────────────────

    private fun createChannel() {
        val channel = NotificationChannel(CHANNEL, "Listening", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while Jarvis is listening"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, ListeningService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Jarvis is listening")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(Notification.Action.Builder(null, "Stop listening", stop).build())
            .build()
    }

    private fun updateNotification(text: String) {
        if (!Status.listening) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    companion object {
        private const val CHANNEL = "listening"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP = "dev.jarvis.phone.STOP"

        /** The running service, for "Stop talking". */
        var current: ListeningService? = null
            private set

        fun start(context: Context) = context.startForegroundService(Intent(context, ListeningService::class.java))

        fun stop(context: Context) {
            context.startService(Intent(context, ListeningService::class.java).setAction(ACTION_STOP))
        }
    }

    override fun onCreate() {
        super.onCreate()
        current = this
    }
}
