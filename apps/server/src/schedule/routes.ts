// The Schedule tab and the screens' notifications:
//   GET    /api/schedules                    every schedule, soonest first, with when (in words) and presence
//   POST   /api/schedules                    create {title, kind, in | time (+date), repeat, days, every, until, prompt, message, allowChanges}
//   PATCH  /api/schedules/:id                change any of those, or {enabled}
//   DELETE /api/schedules/:id
//   POST   /api/schedules/:id/run            go off now (to try it)
//   POST   /api/schedules/:id/skip           a repeat skips its next time
//   GET    /api/notifications                the last 100
//   POST   /api/notifications/:id/ack        {action: "dismiss" | "snooze", minutes?}; id "ringing" = everything ringing
//   GET    /api/notifications/stream?device= server-sent events for an open screen (notifier.ts NotifierEvent)

import type { FastifyInstance } from 'fastify'
import { notifier, schedules } from './index.ts'
import { dueOf, ScheduleError, type Schedule, type ScheduleInput } from './scheduler.ts'

const KEEPALIVE_MS = 25_000

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  const view = (s: Schedule) => ({ ...s, due: dueOf(s)?.toISOString() ?? null, summary: schedules()!.describe(s) })
  const guard = <T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, body: () => T) => {
    if (!schedules()) return reply.code(503).send({ error: 'The scheduler is not running.' })
    try {
      return body()
    } catch (err) {
      return reply.code(err instanceof ScheduleError ? 400 : 500).send({ error: (err as Error).message })
    }
  }

  app.get('/api/schedules', async (_req, reply) => guard(reply, () => ({ schedules: schedules()!.list().map(view), presence: notifier.presence() })))

  app.post<{ Body: ScheduleInput }>('/api/schedules', async (req, reply) => guard(reply, () => view(schedules()!.create(req.body ?? ({} as ScheduleInput)))))

  app.patch<{ Params: { id: string }; Body: Partial<ScheduleInput> & { enabled?: boolean } }>('/api/schedules/:id', async (req, reply) =>
    guard(reply, () => view(schedules()!.update(req.params.id, req.body ?? {}))),
  )

  app.delete<{ Params: { id: string } }>('/api/schedules/:id', async (req, reply) => guard(reply, () => view(schedules()!.remove(req.params.id))))

  app.post<{ Params: { id: string } }>('/api/schedules/:id/run', async (req, reply) =>
    guard(reply, () => {
      schedules()!.runNow(req.params.id)
      return { ok: true }
    }),
  )

  app.post<{ Params: { id: string } }>('/api/schedules/:id/skip', async (req, reply) => guard(reply, () => view(schedules()!.skipNext(req.params.id))))

  app.get('/api/notifications', async () => ({ notifications: notifier.recent(), presence: notifier.presence() }))

  app.post<{ Params: { id: string }; Body: { action?: string; minutes?: number } }>('/api/notifications/:id/ack', async (req) => {
    const action = req.body?.action === 'snooze' ? 'snooze' : 'dismiss'
    const done = notifier.ack(req.params.id === 'ringing' ? null : req.params.id, action, Number(req.body?.minutes) || 9)
    return { acknowledged: done.map((n) => n.id) }
  })

  app.get<{ Querystring: { device?: string } }>('/api/notifications/stream', (req, reply) => {
    const device = (req.query.device ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) || 'screen'
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.write(': connected\n\n')
    const disconnect = notifier.connect(device, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`))
    const keepalive = setInterval(() => res.write(': keep-alive\n\n'), KEEPALIVE_MS)
    req.raw.on('close', () => {
      clearInterval(keepalive)
      disconnect()
    })
  })
}
