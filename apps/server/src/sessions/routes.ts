// REST API for the client's session list: list, open, rename, pin, delete,
// switch to, and start a new session.

import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AgentLibrary } from '../agents/library.ts'
import { MODEL_REF } from './format.ts'
import { SessionError, type SessionStore } from './store.ts'

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof SessionError) return reply.code(err.status).send({ error: err.message })
  throw err
}

export async function sessionRoutes(app: FastifyInstance, options: { sessions: SessionStore; agents: AgentLibrary }): Promise<void> {
  const { sessions, agents } = options
  const listing = () => ({ activeId: sessions.activeId(), newAgent: sessions.newAgent(), newModel: sessions.newModel(), sessions: sessions.list() })
  /** "connection/model", or '' for the agent's. */
  const badModel = (model: unknown) => model !== undefined && (typeof model !== 'string' || (model !== '' && !MODEL_REF.test(model)))
  const badAgent = (agent: unknown) => agent !== undefined && (typeof agent !== 'string' || (agent !== '' && !agents.has(agent)))

  app.get('/api/sessions', async () => listing())

  /** One session with all its messages. */
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const session = sessions.get(req.params.id)
    if (!session) return reply.code(404).send({ error: 'No such session' })
    return { session }
  })

  /** Rename ({ title }), pin ({ pinned }), change agent ({ agent }: an agent id, '' = the default) and/or model ({ model }: "connection/model", '' = the agent's). */
  app.patch<{ Params: { id: string }; Body: { title?: unknown; pinned?: unknown; agent?: unknown; model?: unknown } }>('/api/sessions/:id', async (req, reply) => {
    const { title, pinned, agent, model } = req.body ?? {}
    if (badAgent(agent)) return reply.code(400).send({ error: `No agent "${String(agent)}"` })
    if (badModel(model)) return reply.code(400).send({ error: 'The model is "connection/model" (or "" for the agent\'s)' })
    if (title !== undefined && typeof title !== 'string') return reply.code(400).send({ error: '"title" must be a string' })
    if (pinned !== undefined && typeof pinned !== 'boolean') return reply.code(400).send({ error: '"pinned" must be true or false' })
    try {
      sessions.update(req.params.id, { title, pinned, agent: agent as string | undefined, agentName: typeof agent === 'string' ? agents.get(agent).name : undefined, model: model as string | undefined })
      return listing()
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    try {
      sessions.delete(req.params.id)
      return listing()
    } catch (err) {
      return fail(reply, err)
    }
  })

  /** Talk in this session from now on. */
  app.post<{ Params: { id: string } }>('/api/sessions/:id/activate', async (req, reply) => {
    try {
      sessions.activate(req.params.id)
      return listing()
    } catch (err) {
      return fail(reply, err)
    }
  })

  /** Start a new session (saved with its first message), optionally with an agent ({ agent }). */
  app.post<{ Body: { agent?: unknown } | undefined }>('/api/sessions/new', async (req, reply) => {
    const agent = req.body?.agent
    if (badAgent(agent)) return reply.code(400).send({ error: `No agent "${String(agent)}"` })
    sessions.startNew(agent as string | undefined)
    return listing()
  })

  /** The agent for the new session, before its first message. */
  app.put<{ Body: { agent?: unknown } }>('/api/sessions/new/agent', async (req, reply) => {
    const agent = req.body?.agent
    if (agent === undefined || badAgent(agent)) return reply.code(400).send({ error: `No agent "${String(agent)}"` })
    sessions.setNewAgent(agent as string)
    return listing()
  })

  /** The model for the new session, before its first message ('' = its agent's). */
  app.put<{ Body: { model?: unknown } }>('/api/sessions/new/model', async (req, reply) => {
    const model = req.body?.model
    if (model === undefined || badModel(model)) return reply.code(400).send({ error: 'The model is "connection/model" (or "" for the agent\'s)' })
    sessions.setNewModel(model as string)
    return listing()
  })
}
