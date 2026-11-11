package dev.jarvis.phone

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder

/**
 * The phone's microphone (or a headset's, when Android routes it there), as
 * the server wants it: 16 kHz mono, frames of 512 samples (32 ms), handed to
 * `onFrame` on the microphone's own thread, one after another, for as long as
 * it's open.
 */
class Microphone(private val onFrame: (ShortArray) -> Unit, private val onError: (String) -> Unit) {
    @Volatile
    private var running = false
    private var thread: Thread? = null

    val isOpen: Boolean get() = running

    /** Needs the RECORD_AUDIO permission (asked for before this is called). */
    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        val min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        // Voice-call processing: echo cancellation and noise suppression, where the phone has them
        // (so Jarvis's own voice from the speaker is mostly not heard back).
        val record = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            maxOf(min, FRAME_SAMPLES * 2 * 16),
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            throw IllegalStateException("The microphone couldn't be opened")
        }
        running = true
        record.startRecording()
        thread = Thread({
            try {
                while (running) {
                    val samples = ShortArray(FRAME_SAMPLES)
                    var filled = 0
                    while (filled < FRAME_SAMPLES && running) {
                        val n = record.read(samples, filled, FRAME_SAMPLES - filled)
                        if (n < 0) throw IllegalStateException("The microphone stopped (error $n)")
                        filled += n
                    }
                    if (filled == FRAME_SAMPLES) onFrame(samples)
                }
            } catch (e: Exception) {
                if (running) onError(e.message ?: "The microphone stopped")
                running = false
            } finally {
                record.stop()
                record.release()
            }
        }, "jarvis-mic").apply { start() }
    }

    fun stop() {
        running = false
        thread?.join(1000)
        thread = null
    }

    companion object {
        const val SAMPLE_RATE = 16000
        const val FRAME_SAMPLES = 512
        const val FRAME_MS = 32
    }
}
