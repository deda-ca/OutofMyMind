package dev.jarvis.phone

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import java.nio.FloatBuffer
import java.nio.LongBuffer

/**
 * Silero VAD v5, the same model the web client runs (assets/silero_vad_v5.onnx,
 * MIT licence, from @ricky0123/vad-web): the probability that a 512-sample
 * frame at 16 kHz is speech. Each frame is passed with the last 64 samples of
 * the one before, and the model's recurrent state carries over between frames,
 * as vad-web does it.
 */
class Vad(context: Context) : AutoCloseable {
    private val env = OrtEnvironment.getEnvironment()
    private val session: OrtSession
    private var state = FloatArray(2 * 1 * 128)
    private val context = FloatArray(CONTEXT)
    private val input = FloatArray(CONTEXT + Microphone.FRAME_SAMPLES)
    private val sampleRate = OnnxTensor.createTensor(env, LongBuffer.wrap(longArrayOf(Microphone.SAMPLE_RATE.toLong())), longArrayOf(1))

    init {
        val model = context.assets.open("silero_vad_v5.onnx").use { it.readBytes() }
        val options = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(1)
            setInterOpNumThreads(1)
        }
        session = env.createSession(model, options)
    }

    /** Speech probability (0–1) of one frame of 512 samples. */
    fun probability(frame: ShortArray): Float {
        System.arraycopy(context, 0, input, 0, CONTEXT)
        for (i in frame.indices) input[CONTEXT + i] = frame[i] / 32768f
        System.arraycopy(input, input.size - CONTEXT, context, 0, CONTEXT)
        OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, input.size.toLong())).use { audio ->
            OnnxTensor.createTensor(env, FloatBuffer.wrap(state), longArrayOf(2, 1, 128)).use { st ->
                session.run(mapOf("input" to audio, "state" to st, "sr" to sampleRate)).use { out ->
                    @Suppress("UNCHECKED_CAST")
                    val p = (out.get("output").get().value as Array<FloatArray>)[0][0]
                    val next = (out.get("stateN").get() as OnnxTensor).floatBuffer
                    next.get(state, 0, minOf(state.size, next.remaining()))
                    return p
                }
            }
        }
    }

    fun reset() {
        state = FloatArray(2 * 1 * 128)
        context.fill(0f)
    }

    override fun close() {
        sampleRate.close()
        session.close()
    }

    private companion object {
        const val CONTEXT = 64
    }
}
