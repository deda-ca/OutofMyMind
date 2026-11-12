// The Jarvis HTTP API.

import path from 'node:path'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { Archive } from './archive/archive.ts'
import { openDatabase } from './archive/db.ts'
import { archiveRoutes } from './archive/routes.ts'
import { AudiocppError, audiocppHealth, transcribePcm } from './audiocpp.ts'
import { registerAuth } from './auth.ts'
import { AgentLibrary } from './agents/library.ts'
import { agentRoutes } from './agents/routes.ts'
import { contextMonitor } from './assistant/context.ts'
import { chatTarget } from './assistant/llm.ts'
import { connections } from './assistant/models.ts'
import { usageLog } from './assistant/usage.ts'
import { ttsRoutes } from './assistant/ttsRoutes.ts'
import { config } from './config.ts'
import { fileRoutes } from './files/routes.ts'
import { toolRoutes } from './harness/routes.ts'
import { notifier, startSchedules, stopSchedules } from './schedule/index.ts'
import { startServices, stopServices } from './services/index.ts'
import { startPhone, stopPhone } from './phone/index.ts'
import { startTelegram, stopTelegram } from './telegram/index.ts'
import { startPlatform, stopPlatform } from './plugins/index.ts'
import { pluginRoutes } from './plugins/routes.ts'
import { phoneRoutes } from './phone/routes.ts'
import { serviceRoutes } from './services/routes.ts'
import { scheduleRoutes } from './schedule/routes.ts'
import { sessionRoutes } from './sessions/routes.ts'
import { siteRoutes } from './site.ts'
import { SessionStore } from './sessions/store.ts'
import { SkillLibrary } from './skills/library.ts'
import { skillRoutes } from './skills/routes.ts'
import { speakerRoutes } from './speaker/routes.ts'
import { Speakers } from './speaker/speakers.ts'
import type { VoiceprintModel } from './speaker/voiceprint.ts'
import { streamRoute } from './stream/route.ts'

/** 30 s of 16 kHz s16le mono is ~1 MB; anything far beyond that is a mistake. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024

export interface AppOptions {
  voiceprintModel: VoiceprintModel | null
  accessKey: string
  schedules?: boolean
  /** Serve HTTPS (src/tls.ts). */
  https?: { key: Buffer; cert: Buffer }
  /** Serve the built web client from this folder at / (src/site.ts). */
  siteDir?: string | null
}

export function buildApp(options: AppOptions): FastifyInstance {
  const logger = { level: process.env.LOG_LEVEL ?? 'info' }
  // (Fastify types an HTTPS instance differently; the routes don't care.)
  const app = (options.https ? Fastify({ logger, https: options.https }) : Fastify({ logger })) as FastifyInstance
  const db = openDatabase(config.dataDir)
  const archive = new Archive(db, config.dataDir)
  const speakers = new Speakers(db, config.dataDir, options.voiceprintModel)
  const agents = new AgentLibrary(config.workspaceDir, path.join(config.dataDir, 'agents.json'))
  const skills = new SkillLibrary(config.workspaceDir)
  const sessions = new SessionStore(path.join(config.workspaceDir, 'sessions'), path.join(config.dataDir, 'sessions.json'))
  app.addHook('onClose', async () => db.close())
  // Timers, alarms, reminders (off in tests unless asked for).
  if (options.schedules) {
    // What the LLMs cost (usage.ts): kept in the data folder, screens told when it changes (at most every 2 s).
    usageLog.open(config.dataDir)
    let usageTimer: NodeJS.Timeout | undefined
    const onUsage = () => {
      usageTimer ??= setTimeout(() => {
        usageTimer = undefined
        notifier.broadcast({ type: 'usage' })
      }, 2000)
    }
    const onBudget = (connection: string, budget: number, spent: number) =>
      void notifier.notify({ title: 'LLM budget', text: `Today's budget for ${connection} (${budget.toFixed(2)} dollars) is spent (${spent.toFixed(2)}): new requests use the default model until tomorrow.`, urgency: 'info', speak: false })
    usageLog.on('change', onUsage)
    usageLog.on('budget', onBudget)
    app.addHook('onClose', async () => {
      usageLog.off('change', onUsage)
      usageLog.off('budget', onBudget)
      clearTimeout(usageTimer)
      usageLog.flush()
    })
    // Self-contained plugins' events and requests (docs/plugins.md): from the start, so nothing a plugin sends while starting is lost.
    startPlatform({ agents, skills, sessions, log: (message, err) => (err ? app.log.warn({ err }, message) : app.log.info(message)) })
    app.addHook('onClose', async () => stopPlatform())
    // At listen time: after the plugins have started (main.ts), so a schedule due at start-up has its tools.
    app.addHook('onReady', async () => void startSchedules({ agents, skills, sessions, log: (message, err) => (err ? app.log.warn({ err }, message) : app.log.info(message)) }))
    app.addHook('onClose', async () => stopSchedules())
    // Background services Jarvis writes (docs/services.md), with the schedules: started after the plugins.
    app.addHook('onReady', async () => void startServices({ agents, skills, sessions, log: (message, err) => (err ? app.log.warn({ err }, message) : app.log.info(message)) }))
    app.addHook('onClose', async () => stopServices())
    // The phone line (docs/phone.md), when VoIP.ms is set up.
    app.addHook('onReady', async () => void startPhone({ sessions, log: (message, err) => (err ? app.log.warn({ err }, message) : app.log.info(message)) }))
    app.addHook('onClose', async () => stopPhone())
    app.addHook('onReady', async () => void startTelegram({ agents, skills, sessions, log: (message, err) => (err ? app.log.warn({ err }, message) : app.log.info(message)) }))
    app.addHook('onClose', async () => stopTelegram())
  }

  // Audio arrives as raw bytes.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES }, (_req, body, done) =>
    done(null, body),
  )

  void app.register(websocket, { options: { maxPayload: 64 * 1024 } })

  // Browsers always send Origin on POST and WebSocket; only our own web client may call us.
  // Non-browser clients (native apps, curl) send none. The server only listens
  // on localhost by default, so only local processes can reach it at all.
  // When this server serves the web client itself (SITE_DIR), the client calls from this server's own origin.
  const scheme = options.https ? 'https' : 'http'
  const ownOrigin = (origin: string, host: string | undefined) => Boolean(options.siteDir && host && origin === `${scheme}://${host}`)
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin
    if (origin && !config.allowedOrigins.includes(origin) && !ownOrigin(origin, req.headers.host)) {
      return reply.code(403).send({ error: `Origin not allowed: ${origin}` })
    }
  })

  // Everything under /api needs the pass-key (after the origin check).
  registerAuth(app, options.accessKey)

  app.get('/api/health', async () => {
    const audiocpp = await audiocppHealth()
    return { status: audiocpp.ok ? 'ok' : 'degraded', audiocpp }
  })

  /** What the LLMs cost: today (by model, by source), this month, a session (?session=id), and each connection's budget. */
  app.get<{ Querystring: { session?: string } }>('/api/usage', async (req) => ({
    ...usageLog.summary(req.query.session || sessions.activeId()),
    budgets: connections()
      .filter((c) => c.budget !== undefined)
      .map((c) => ({ connection: c.id, label: c.label, budget: c.budget, spent: usageLog.spentToday(c.id) })),
  }))

  /** The context meter: the last request to the local model, by section (null before the first). */
  app.get('/api/context', async () => {
    const stats = contextMonitor.latest() ?? null
    return { stats, limit: stats?.limit || (await contextMonitor.limit(chatTarget())) }
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

  void app.register(streamRoute, { archive, speakers, sessions, agents, skills })
  void app.register(archiveRoutes, { archive })
  void app.register(speakerRoutes, { speakers, dataDir: config.dataDir })
  void app.register(toolRoutes)
  void app.register(sessionRoutes, { sessions, agents })
  void app.register(pluginRoutes)
  void app.register(agentRoutes, { agents })
  void app.register(skillRoutes, { skills })
  void app.register(ttsRoutes)
  void app.register(scheduleRoutes)
  void app.register(serviceRoutes)
  void app.register(phoneRoutes)
  void app.register(fileRoutes, { workspaceDir: config.workspaceDir, sessions })
  if (options.siteDir) siteRoutes(app, options.siteDir)

  return app
}
