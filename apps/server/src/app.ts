// The Jarvis HTTP API.

import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { Archive } from './archive/archive.ts'
import { openDatabase } from './archive/db.ts'
import { archiveRoutes } from './archive/routes.ts'
import { AudiocppError, audiocppHealth, transcribePcm } from './audiocpp.ts'
import { config } from './config.ts'
import { streamRoute } from './stream/route.ts'

/** 30 s of 16 kHz s16le mono is ~1 MB; anything far beyond that is a mistake. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })
  const db = openDatabase(config.dataDir)
  const archive = new Archive(db, config.dataDir)
  app.addHook('onClose', async () => db.close())

  // Audio arrives as raw bytes.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES }, (_req, body, done) =>
    done(null, body),
  )

  void app.register(websocket, { options: { maxPayload: 64 * 1024 } })

  // Browsers always send Origin on POST and WebSocket; only our own web client may call us.
  // Non-browser clients (native apps, curl) send none. The server only listens
  // on localhost by default, so only local processes can reach it at all.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin
    if (origin && !config.allowedOrigins.includes(origin)) {
      return reply.code(403).send({ error: `Origin not allowed: ${origin}` })
    }
  })

  app.get('/api/health', async () => {
    const audiocpp = await audiocppHealth()
    return { status: audiocpp.ok ? 'ok' : 'degraded', audiocpp }
  })

  app.post<{ Querystring: { sampleRate?: string; language?: string }; Body: Buffer }>(
    '/api/transcribe',
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'Expected application/octet-stream' })
      const sampleRate = Number(req.query.sampleRate)
      if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
        return reply.code(400).send({ error: 'Invalid sampleRate' })
      }
      const pcm = req.body
      if (pcm.length === 0 || pcm.length % 2 !== 0) return reply.code(400).send({ error: 'Invalid PCM body' })

      try {
        const text = await transcribePcm(pcm, sampleRate, req.query.language ?? '')
        return { text }
      } catch (err) {
        if (err instanceof AudiocppError) return reply.code(502).send({ error: err.message })
        throw err
      }
    },
  )

  void app.register(streamRoute, { archive })
  void app.register(archiveRoutes, { archive })

  return app
}
