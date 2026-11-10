// The Services tab (docs/services.md):
//   GET    /api/services                      every service, the secrets (names and whether set, never values), today's turns
//   GET    /api/services/:id/changes          what approving it now would change: permissions in words, file diffs, its hash
//   POST   /api/services/:id/approve          {hash, develop?}: the version the owner looked at; develop: hours of development mode (null: until locked)
//   POST   /api/services/:id/develop          {hours}: development mode, Jarvis's changes approved automatically (hours null: until locked)
//   POST   /api/services/:id/lock             end development mode
//   POST   /api/services/:id/reject           {hash}
//   POST   /api/services/:id/run              run it now
//   POST   /api/services/:id/pause | resume
//   DELETE /api/services/:id                  its folder, approved copy, state and log
//   GET    /api/services/:id/log?lines=
//   POST   /api/services/stop-all             the kill switch
//   PUT    /api/secrets/:name                 {value, description?}: set (the value is never sent back)
//   DELETE /api/secrets/:name

import type { FastifyInstance, FastifyReply } from 'fastify'
import { services } from './index.ts'
import { ServiceError } from './supervisor.ts'
import { VaultError } from './vault.ts'

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  const guard = async (reply: FastifyReply, body: (s: NonNullable<ReturnType<typeof services>>) => unknown) => {
    const s = services()
    if (!s) return reply.code(503).send({ error: 'Services are off (SERVICES=off), or not started.' })
    try {
      return await body(s)
    } catch (err) {
      if (err instanceof ServiceError) return reply.code(err.status).send({ error: err.message })
      if (err instanceof VaultError) return reply.code(400).send({ error: err.message })
      throw err
    }
  }
  const hashOf = (body: unknown) => String((body as { hash?: unknown } | undefined)?.hash ?? '')

  app.get('/api/services', async (_req, reply) =>
    guard(reply, ({ supervisor, vault }) => {
      const list = supervisor.list()
      const usedBy = (name: string) => list.filter((v) => v.secrets.some((s) => s.name === name)).map((v) => v.id)
      const names = new Set([...vault.list().map((s) => s.name), ...list.flatMap((v) => v.secrets.map((s) => s.name))])
      const known = new Map(vault.list().map((s) => [s.name, s]))
      return {
        services: list,
        secrets: [...names].sort().map((name) => ({ name, description: '', set: false, ...known.get(name), usedBy: usedBy(name) })),
        budget: supervisor.triggers.budget(),
      }
    }),
  )

  app.get<{ Params: { id: string } }>('/api/services/:id/changes', async (req, reply) => guard(reply, ({ supervisor }) => supervisor.changes(req.params.id)))

  app.post<{ Params: { id: string }; Body: unknown }>('/api/services/:id/approve', async (req, reply) =>
    guard(reply, async ({ supervisor }) => {
      await supervisor.approve(req.params.id, hashOf(req.body))
      const develop = (req.body as { develop?: unknown } | undefined)?.develop
      if (develop !== undefined) await supervisor.develop(req.params.id, develop === null ? null : Number(develop))
      return supervisor.get(req.params.id)
    }),
  )

  app.post<{ Params: { id: string }; Body: unknown }>('/api/services/:id/reject', async (req, reply) =>
    guard(reply, ({ supervisor }) => {
      supervisor.reject(req.params.id, hashOf(req.body))
      return supervisor.get(req.params.id)
    }),
  )

  app.post<{ Params: { id: string }; Body: unknown }>('/api/services/:id/develop', async (req, reply) =>
    guard(reply, async ({ supervisor }) => {
      const hours = (req.body as { hours?: unknown } | undefined)?.hours
      await supervisor.develop(req.params.id, hours === null || hours === undefined ? null : Number(hours))
      return supervisor.get(req.params.id)
    }),
  )

  app.post<{ Params: { id: string } }>('/api/services/:id/lock', async (req, reply) =>
    guard(reply, ({ supervisor }) => {
      supervisor.lock(req.params.id)
      return supervisor.get(req.params.id)
    }),
  )

  app.post<{ Params: { id: string } }>('/api/services/:id/run', async (req, reply) => guard(reply, ({ supervisor }) => supervisor.runNow(req.params.id)))

  app.post<{ Params: { id: string } }>('/api/services/:id/pause', async (req, reply) =>
    guard(reply, ({ supervisor }) => {
      supervisor.pause(req.params.id, 'the owner')
      return supervisor.get(req.params.id)
    }),
  )

  app.post<{ Params: { id: string } }>('/api/services/:id/resume', async (req, reply) =>
    guard(reply, ({ supervisor }) => {
      supervisor.resume(req.params.id)
      return supervisor.get(req.params.id)
    }),
  )

  app.delete<{ Params: { id: string } }>('/api/services/:id', async (req, reply) =>
    guard(reply, async ({ supervisor }) => {
      await supervisor.remove(req.params.id)
      return { removed: req.params.id }
    }),
  )

  app.get<{ Params: { id: string }; Querystring: { lines?: string } }>('/api/services/:id/log', async (req, reply) =>
    guard(reply, ({ supervisor }) => ({ log: supervisor.log(req.params.id, Number(req.query.lines) || 300) })),
  )

  app.post('/api/services/stop-all', async (_req, reply) => guard(reply, ({ supervisor }) => ({ paused: supervisor.stopAll('the owner (stop all)') })))

  app.put<{ Params: { name: string }; Body: unknown }>('/api/secrets/:name', async (req, reply) =>
    guard(reply, ({ supervisor, vault }) => {
      const b = (req.body ?? {}) as { value?: unknown; description?: unknown }
      vault.set(req.params.name, typeof b.value === 'string' ? b.value : '', typeof b.description === 'string' ? b.description : undefined)
      supervisor.emit('change')
      supervisor.tick() // a service waiting for it can run now
      return { name: req.params.name, set: true }
    }),
  )

  app.delete<{ Params: { name: string } }>('/api/secrets/:name', async (req, reply) =>
    guard(reply, ({ supervisor, vault }) => {
      vault.remove(req.params.name)
      supervisor.emit('change')
      return { name: req.params.name, removed: true }
    }),
  )
}
