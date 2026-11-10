// Read aloud (the client's reader): text to speech on request, in any voice
// audio.cpp has, so pasted text can sound different from Jarvis.
//
//   GET  /api/tts/voices   → { voices, jarvis }   (jarvis: the voice Jarvis replies in)
//   POST /api/tts          { text, voice? } → audio/wav, one sentence (or part of one) at a time

import type { FastifyInstance } from 'fastify'
import { config } from '../config.ts'
import { SpeechError, synthesize, ttsVoices } from './speech.ts'

/** Longest piece accepted: the client sends a sentence at a time (long ones split). */
const MAX_CHARS = 1000

export async function ttsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tts/voices', async () => ({ voices: await ttsVoices(), jarvis: config.ttsVoice }))

  app.post<{ Body: { text?: unknown; voice?: unknown } }>('/api/tts', async (req, reply) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim() : ''
    if (!text) return reply.code(400).send({ error: 'Send { text }' })
    if (text.length > MAX_CHARS) return reply.code(400).send({ error: `At most ${MAX_CHARS} characters at a time` })
    const voices = await ttsVoices()
    const voice = typeof req.body?.voice === 'string' && req.body.voice ? req.body.voice : config.ttsVoice
    if (!voices.includes(voice)) return reply.code(400).send({ error: `No voice "${voice}" (audio.cpp has: ${voices.join(', ')})` })
    // Closing the tab or skipping ahead cancels the synthesis.
    const abort = new AbortController()
    req.raw.on('close', () => abort.abort())
    try {
      const wav = await synthesize(text, abort.signal, voice)
      return reply.header('Content-Type', 'audio/wav').header('Cache-Control', 'no-store').send(wav)
    } catch (err) {
      if (abort.signal.aborted) return reply.code(499).send({ error: 'Cancelled' })
      if (err instanceof SpeechError) return reply.code(502).send({ error: err.message })
      throw err
    }
  })
}
