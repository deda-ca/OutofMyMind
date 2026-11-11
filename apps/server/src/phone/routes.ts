// The Phone tab (docs/phone.md):
//   GET  /api/phone                    the line, the call in progress, recent calls
//   POST /api/phone/call               {number}: place a call (the owner pressed Call: that's their yes)
//   POST /api/phone/answer | decline | hangup
//   POST /api/phone/dtmf               {digit}
//   POST /api/phone/mute               {muted}
//   POST /api/phone/texts              {number, message}: send a text (the owner pressed Send)
//   GET  /api/phone/audio              WebSocket: the owner's device on the call. Binary both ways: s16le mono 16 kHz.
//   GET  /api/phone/calls/:id/:n.ogg   a call's recording (one per leg)

import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { config } from '../config.ts'
import { phoneLine, phoneTexts } from './index.ts'
import { NumberError } from './numbers.ts'
import { type Phone, PhoneError } from './phone.ts'
import { TextError } from './texts.ts'
import { toE164 } from './numbers.ts'

export async function phoneRoutes(app: FastifyInstance): Promise<void> {
  const guard = async (reply: FastifyReply, body: (p: Phone) => unknown) => {
    const p = phoneLine()
    if (!p) return reply.code(503).send({ error: 'The phone isn\'t set up (VOIPMS_SIP_SERVER, VOIPMS_SIP_USER and VOIPMS_SIP_PASSWORD in .env.local), or PHONE=off.' })
    try {
      return await body(p)
    } catch (err) {
      if (err instanceof PhoneError || err instanceof NumberError || err instanceof TextError) return reply.code(400).send({ error: err.message })
      if (err instanceof Error && /line isn't ready/.test(err.message)) return reply.code(503).send({ error: err.message })
      throw err
    }
  }

  app.get('/api/phone', async (_req, reply) => {
    const p = phoneLine()
    if (!p) return reply.send({ enabled: false })
    const t = phoneTexts()
    return { enabled: true, ...p.status(), texts: t ? { enabled: true, error: t.error, list: t.recent(50) } : { enabled: false, error: '', list: [] } }
  })
  app.post<{ Body: { number?: unknown; message?: unknown } }>('/api/phone/texts', async (req, reply) =>
    guard(reply, async () => {
      const t = phoneTexts()
      if (!t) return reply.code(503).send({ error: 'Texts need VOIPMS_API_USER and VOIPMS_API_PASSWORD (and VOIPMS_DID) in .env.local.' })
      return { text: await t.send(toE164(String(req.body?.number ?? '')).slice(1), String(req.body?.message ?? '')) }
    }),
  )
  app.post<{ Body: { number?: unknown } }>('/api/phone/call', async (req, reply) => guard(reply, async (p) => ({ call: await p.dial(String(req.body?.number ?? '')) })))
  app.post('/api/phone/answer', async (_req, reply) => guard(reply, (p) => (p.answer(), { ok: true })))
  app.post('/api/phone/decline', async (_req, reply) => guard(reply, (p) => (p.decline(), { ok: true })))
  app.post('/api/phone/hangup', async (_req, reply) => guard(reply, async (p) => (await p.hangUp(), { ok: true })))
  app.post<{ Body: { digit?: unknown } }>('/api/phone/dtmf', async (req, reply) => guard(reply, (p) => (p.dtmf(String(req.body?.digit ?? '')), { ok: true })))
  app.post<{ Body: { muted?: unknown } }>('/api/phone/mute', async (req, reply) => guard(reply, (p) => (p.mute(req.body?.muted === true), { ok: true })))

  app.get<{ Params: { id: string; n: string } }>('/api/phone/calls/:id/:n', async (req, reply) =>
    guard(reply, (p) => {
      const record = p.recent(500).find((r) => r.id === req.params.id)
      const rec = record?.recordings[Number(req.params.n.replace(/\.ogg$/, '')) - 1]
      if (!rec) return reply.code(404).send({ error: 'No such recording.' })
      const file = path.join(config.dataDir, rec.file)
      if (!fs.existsSync(file)) return reply.code(404).send({ error: 'The recording was deleted.' })
      return reply.type('audio/ogg').send(fs.createReadStream(file))
    }),
  )

  app.get('/api/phone/audio', { websocket: true }, (socket) => {
    const p = phoneLine()
    if (!p) return socket.close(1011, 'no phone')
    let attached: ReturnType<Phone['attachDevice']>
    try {
      attached = p.attachDevice((frame) => {
        if (socket.readyState === socket.OPEN) socket.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength))
      })
    } catch (err) {
      return socket.close(1008, (err as Error).message.slice(0, 120))
    }
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary || data.length % 2 !== 0 || data.length > 64 * 1024) return
      const samples = new Int16Array(data.length / 2)
      new Uint8Array(samples.buffer).set(data)
      attached.leg.push(samples)
    })
    socket.on('close', () => attached.leave())
  })
}
