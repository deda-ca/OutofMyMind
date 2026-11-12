// Text to speech on request (the reader, the agent editor's "hear this voice"),
// in any speech model and voice the speech servers have; and what they have.
//
//   GET  /api/audio        → { stt, tts, voice, connections: [{ id, label, kind, stt, tts }] }
//                            the defaults ("connection/model"; voice: Jarvis's) and each server's models
//   GET  /api/tts/voices?model=connection/model → { voices, jarvis }   (default model: audio.tts)
//   POST /api/tts          { text, voice?, model? } → audio/wav, one sentence (or part of one) at a time
//   POST /api/tts/sentences { text } → { sentences }   a reply as Jarvis speaks it (markdown cleaned),
//                          one /api/tts call each: for replaying an earlier reply

import type { FastifyInstance } from 'fastify'
import { audioConnections, audioModels, defaultAudioRef } from '../audioConnections.ts'
import { config } from '../config.ts'
import { SpeechError, spokenSentences, synthesize, ttsVoices } from './speech.ts'

/** Longest piece accepted: the client sends a sentence at a time (long ones split). */
const MAX_CHARS = 1000
/** Longest reply /api/tts/sentences splits. */
const MAX_REPLY_CHARS = 100_000

export async function ttsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/audio', async () => {
    const list = audioConnections()
    return {
      stt: defaultAudioRef('stt', list),
      tts: defaultAudioRef('tts', list),
      voice: config.ttsVoice,
      connections: await Promise.all(list.map(async (c) => ({ id: c.id, label: c.label, kind: c.kind, ...(await audioModels(c)) }))),
    }
  })

  app.get<{ Querystring: { model?: string } }>('/api/tts/voices', async (req) => ({ voices: await ttsVoices(req.query.model || undefined), jarvis: config.ttsVoice }))

  app.post<{ Body: { text?: unknown } }>('/api/tts/sentences', async (req, reply) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : ''
    if (!text.trim()) return reply.code(400).send({ error: 'Send { text }' })
    if (text.length > MAX_REPLY_CHARS) return reply.code(400).send({ error: `At most ${MAX_REPLY_CHARS} characters` })
    return { sentences: spokenSentences(text) }
  })

  app.post<{ Body: { text?: unknown; voice?: unknown; model?: unknown } }>('/api/tts', async (req, reply) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim() : ''
    if (!text) return reply.code(400).send({ error: 'Send { text }' })
    if (text.length > MAX_CHARS) return reply.code(400).send({ error: `At most ${MAX_CHARS} characters at a time` })
    const model = typeof req.body?.model === 'string' && req.body.model ? req.body.model : undefined
    const voices = await ttsVoices(model)
    const voice = typeof req.body?.voice === 'string' && req.body.voice ? req.body.voice : config.ttsVoice
    if (!voices.includes(voice)) return reply.code(400).send({ error: `No voice "${voice}" (${model ?? defaultAudioRef('tts')} has: ${voices.join(', ')})` })
    // Closing the tab or skipping ahead cancels the synthesis.
    const abort = new AbortController()
    req.raw.on('close', () => abort.abort())
    try {
      const wav = await synthesize(text, abort.signal, voice, model)
      return reply.header('Content-Type', 'audio/wav').header('Cache-Control', 'no-store').send(wav)
    } catch (err) {
      if (abort.signal.aborted) return reply.code(499).send({ error: 'Cancelled' })
      if (err instanceof SpeechError) return reply.code(502).send({ error: err.message })
      throw err
    }
  })
}
