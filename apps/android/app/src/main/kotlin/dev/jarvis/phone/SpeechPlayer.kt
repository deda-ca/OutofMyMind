package dev.jarvis.phone

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Jarvis's voice: the server sends each reply sentence by sentence
 * (assistant.audio: a WAV each, with the reply's id and the sentence's
 * number), and they're played in order as they arrive. A newer reply replaces
 * an older one. Stop, continue and repeat work as on the web client
 * (SpeechPlayer.ts). The state (playing, stopped, idle) is reported, so the
 * server knows when Jarvis has finished talking.
 *
 * While talking, other audio (music) is turned down (audio focus).
 */
class SpeechPlayer(context: Context, private val onState: (String) -> Unit) {
    private class Sentence(val pcm: ShortArray, val sampleRate: Int)

    private val audio = context.getSystemService(AudioManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val lock = Object()
    private val replies = LinkedHashMap<Int, MutableMap<Int, Sentence>>()
    /** Replies the server has finished sending (assistant.done). */
    private val done = HashSet<Int>()
    private var currentReply = -1
    private var nextSeq = 0
    private var stopped = false
    /** Bumped by stop/repeat: the sentence being written is abandoned. */
    private var generation = 0
    @Volatile
    private var reported = "idle"
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(ATTRIBUTES)
        .build()

    @Volatile
    private var closed = false
    private val worker = Thread({ loop() }, "jarvis-speech").apply { start() }

    /** One sentence from the server (base64 WAV). */
    fun add(replyId: Int, seq: Int, wav: ByteArray) {
        val sentence = decodeWav(wav) ?: return
        synchronized(lock) {
            if (replyId < currentReply) return // an old reply
            if (replyId > currentReply) {
                currentReply = replyId
                nextSeq = 0
                stopped = false
                generation++
            }
            replies.getOrPut(replyId) { HashMap() }[seq] = sentence
            while (replies.size > 5) replies.remove(replies.keys.first())
            lock.notifyAll()
        }
    }

    /** The server finished a reply (assistant.done): once its last sentence has played, Jarvis is idle. */
    fun replyDone(replyId: Int) = synchronized(lock) {
        done.add(replyId)
        if (done.size > 20) done.remove(done.min())
        lock.notifyAll()
    }

    /** Stop talking (the button, or "stop"): "continue" picks up at the sentence it stopped in. */
    fun stop() = synchronized(lock) {
        if (reported != "playing") return
        stopped = true
        generation++
        lock.notifyAll()
    }

    fun continueSpeaking() = synchronized(lock) {
        if (!stopped) return
        stopped = false
        lock.notifyAll()
    }

    /** From the start of a reply. */
    fun repeat(replyId: Int) = synchronized(lock) {
        if (replies[replyId] == null) return
        currentReply = replyId
        nextSeq = 0
        stopped = false
        generation++
        lock.notifyAll()
    }

    val isTalking: Boolean get() = reported == "playing"

    fun close() {
        closed = true
        synchronized(lock) { lock.notifyAll() }
        worker.interrupt()
    }

    private fun loop() {
        var track: AudioTrack? = null
        var trackRate = 0
        try {
            while (!closed) {
                var sentence: Sentence? = null
                var gen = 0
                var finished = false
                synchronized(lock) {
                    if (!stopped) sentence = replies[currentReply]?.get(nextSeq)
                    gen = generation
                    if (sentence == null) {
                        // Between sentences Jarvis is still talking (the next one is on its way);
                        // it has finished once the reply is done (or it was stopped).
                        finished = reported == "playing" && (stopped || currentReply in done)
                        if (!finished) lock.wait(250)
                    }
                }
                val next = sentence
                if (next == null) {
                    if (finished) {
                        track?.let { t ->
                            if (synchronized(lock) { stopped }) {
                                t.pause()
                                t.flush()
                            } else {
                                drain(t)
                            }
                        }
                        audio.abandonAudioFocusRequest(focus)
                        synchronized(lock) {
                            if (stopped) report("stopped") else if (replies[currentReply]?.get(nextSeq) == null) report("idle")
                        }
                    }
                    continue
                }
                if (track == null || trackRate != next.sampleRate) {
                    track?.release()
                    track = newTrack(next.sampleRate)
                    trackRate = next.sampleRate
                }
                val t = track
                if (reported != "playing") {
                    audio.requestAudioFocus(focus)
                    report("playing")
                }
                if (t.playState != AudioTrack.PLAYSTATE_PLAYING) t.play()
                // In pieces of ~100 ms, so stop is quick.
                val piece = next.sampleRate / 10
                var at = 0
                while (at < next.pcm.size && !closed) {
                    if (synchronized(lock) { gen != generation }) break
                    val n = t.write(next.pcm, at, minOf(piece, next.pcm.size - at))
                    if (n <= 0) break
                    at += n
                }
                synchronized(lock) {
                    if (gen != generation) {
                        // Stopped or restarted mid-sentence: cut the sound now.
                        t.pause()
                        t.flush()
                        if (stopped) {
                            report("stopped")
                            audio.abandonAudioFocusRequest(focus)
                        }
                    } else {
                        nextSeq++
                    }
                }
            }
        } catch (_: InterruptedException) {
            // closing
        } finally {
            track?.release()
            audio.abandonAudioFocusRequest(focus)
        }
    }

    /** Waits for what's been written to finish playing, then stops the track. */
    private fun drain(track: AudioTrack) {
        track.stop() // plays out what's buffered
        val until = System.currentTimeMillis() + 3000
        while (track.playState == AudioTrack.PLAYSTATE_PLAYING && System.currentTimeMillis() < until) Thread.sleep(20)
    }

    private fun report(state: String) {
        if (state == reported) return
        reported = state
        main.post { onState(state) }
    }

    private fun newTrack(rate: Int): AudioTrack = AudioTrack.Builder()
        .setAudioAttributes(ATTRIBUTES)
        .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setTransferMode(AudioTrack.MODE_STREAM)
        .setBufferSizeInBytes(maxOf(AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), rate / 5 * 2))
        .build()

    companion object {
        private val ATTRIBUTES: AudioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        /** A 16-bit PCM WAV (mono, or the first channel of stereo) → samples; null if it isn't one. */
        private fun decodeWav(bytes: ByteArray): Sentence? {
            val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            if (bytes.size < 44 || String(bytes, 0, 4) != "RIFF" || String(bytes, 8, 4) != "WAVE") return null
            var pos = 12
            var rate = 0
            var channels = 1
            var bits = 16
            while (pos + 8 <= bytes.size) {
                val id = String(bytes, pos, 4)
                val size = b.getInt(pos + 4)
                val body = pos + 8
                if (id == "fmt ") {
                    channels = b.getShort(body + 2).toInt()
                    rate = b.getInt(body + 4)
                    bits = b.getShort(body + 14).toInt()
                } else if (id == "data") {
                    if (bits != 16 || rate == 0) return null
                    val end = minOf(bytes.size, body + (if (size <= 0) bytes.size else size))
                    val frames = (end - body) / (2 * channels)
                    val pcm = ShortArray(frames) { i -> b.getShort(body + i * 2 * channels) }
                    return Sentence(pcm, rate)
                }
                pos = body + size + (size and 1)
            }
            return null
        }
    }
}
