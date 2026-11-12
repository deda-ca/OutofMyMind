// REST API for the Agents tab and the session panel's agent picker: list,
// create, edit, delete, and choose the default agent. Agents are files in
// WORKSPACE_DIR/agents (library.ts); hand edits there show up here too.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { connections, defaultRef, listModels } from '../assistant/models.ts'
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
    ...(typeof b.model === 'string' && b.model.trim() ? { model: b.model.trim() } : {}),
    ...(typeof b.speech === 'string' && b.speech.trim() ? { speech: b.speech.trim() } : {}),
    body: String(b.body ?? ''),
  }
}

export async function agentRoutes(app: FastifyInstance, options: { agents: AgentLibrary }): Promise<void> {
  const { agents } = options
  const listing = () => {
    const defaultAgent = agents.defaultId()
    return {
      defaultAgent,
      agents: agents.list().map(({ id, name, description, tools, temperature, voice, icon, model, speech, body }) => ({
        id,
        name,
        description,
        tools,
        temperature,
        voice,
        icon,
        model,
        speech,
        body,
        isDefault: id === defaultAgent,
        /** The fallback agent: editable, not deletable. */
        builtIn: id === DEFAULT_AGENT_ID,
      })),
    }
  }

  app.get('/api/agents', async () => listing())

  /** For the agent editor's Model picker: the connections (never their keys), their models, and the default. */
  app.get('/api/llm', async () => {
    const list = connections()
    return {
      default: defaultRef(list),
      connections: await Promise.all(
        list.map(async (c) => {
          const { models, error } = await listModels(c)
          return { id: c.id, label: c.label, kind: c.kind, model: c.model, models, ...(error ? { error } : {}) }
        }),
      ),
    }
  })

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
