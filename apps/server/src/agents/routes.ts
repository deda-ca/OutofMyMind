// REST API for the Agents tab and the session panel's agent picker: list,
// create, edit, delete, and choose the default agent. Agents are files in
// WORKSPACE_DIR/agents (library.ts); hand edits there show up here too.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { AgentError, DEFAULT_AGENT_ID, type AgentInput, type AgentLibrary } from './library.ts'

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof AgentError) return reply.code(err.status).send({ error: err.message })
  throw err
}

/** The editor's fields, as sent: checked by the library. */
function input(body: unknown): AgentInput {
  const b = (body ?? {}) as Record<string, unknown>
  return {
    name: String(b.name ?? ''),
    description: String(b.description ?? ''),
    tools: b.tools === null || b.tools === undefined ? null : (b.tools as string[]),
    ...(b.temperature === undefined || b.temperature === null || b.temperature === '' ? {} : { temperature: Number(b.temperature) }),
    ...(typeof b.voice === 'string' && b.voice.trim() ? { voice: b.voice.trim() } : {}),
    ...(typeof b.icon === 'string' && b.icon.trim() ? { icon: b.icon.trim() } : {}),
    body: String(b.body ?? ''),
  }
}

export async function agentRoutes(app: FastifyInstance, options: { agents: AgentLibrary }): Promise<void> {
  const { agents } = options
  const listing = () => {
    const defaultAgent = agents.defaultId()
    return {
      defaultAgent,
      agents: agents.list().map(({ id, name, description, tools, temperature, voice, icon, body }) => ({
        id,
        name,
        description,
        tools,
        temperature,
        voice,
        icon,
        body,
        isDefault: id === defaultAgent,
        /** The fallback agent: editable, not deletable. */
        builtIn: id === DEFAULT_AGENT_ID,
      })),
    }
  }

  app.get('/api/agents', async () => listing())

  /** New agent; its id comes from the name unless { id } is given. */
  app.post<{ Body: unknown }>('/api/agents', async (req, reply) => {
    try {
      const id = (req.body as { id?: unknown } | undefined)?.id
      const created = agents.create(input(req.body), typeof id === 'string' && id ? id : undefined)
      return { created, ...listing() }
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.put<{ Params: { id: string }; Body: unknown }>('/api/agents/:id', async (req, reply) => {
    try {
      agents.update(req.params.id, input(req.body))
      return listing()
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.delete<{ Params: { id: string } }>('/api/agents/:id', async (req, reply) => {
    try {
      agents.remove(req.params.id)
      return listing()
    } catch (err) {
      return fail(reply, err)
    }
  })

  /** The default agent: what every session without its own agent uses. */
  app.put<{ Body: { id?: unknown } }>('/api/default-agent', async (req, reply) => {
    try {
      agents.setDefault(String(req.body?.id ?? ''))
      return listing()
    } catch (err) {
      return fail(reply, err)
    }
  })
}
