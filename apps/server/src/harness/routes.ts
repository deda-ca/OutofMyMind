// REST API for the Tools tab: every plugin and its tools, and switching them on and off.

import type { FastifyInstance } from 'fastify'
import { isCrud } from './crud.ts'
import { harness } from './index.ts'

interface Toggle {
  enabled?: unknown
}

export async function toolRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tools', async () => ({ plugins: harness.catalog(), kinds: harness.kinds() }))

  /** Switch a kind of tool on or off: create, read, update or delete (every tool that does it). */
  app.put<{ Params: { kind: string }; Body: Toggle }>('/api/tool-kinds/:kind', async (req, reply) => {
    if (!isCrud(req.params.kind)) return reply.code(404).send({ error: 'Use create, read, update or delete' })
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'Send { "enabled": true | false }' })
    harness.setKind(req.params.kind, req.body.enabled)
    return { plugins: harness.catalog(), kinds: harness.kinds() }
  })

  /** Switch a whole plugin on or off. */
  app.put<{ Params: { plugin: string }; Body: Toggle }>('/api/tools/:plugin', async (req, reply) => {
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'Send { "enabled": true | false }' })
    if (!harness.setEnabled(req.params.plugin, null, req.body.enabled)) return reply.code(404).send({ error: `No plugin "${req.params.plugin}"` })
    return { plugins: harness.catalog(), kinds: harness.kinds() }
  })

  /** Switch one tool on or off. */
  app.put<{ Params: { plugin: string; tool: string }; Body: Toggle }>('/api/tools/:plugin/:tool', async (req, reply) => {
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'Send { "enabled": true | false }' })
    if (!harness.setEnabled(req.params.plugin, req.params.tool, req.body.enabled)) {
      return reply.code(404).send({ error: `No tool "${req.params.tool}" in plugin "${req.params.plugin}"` })
    }
    return { plugins: harness.catalog(), kinds: harness.kinds() }
  })
}
