// GET /api/agents: the agents in WORKSPACE_DIR/agents, for the client's agent picker.

import type { FastifyInstance } from 'fastify'
import type { AgentLibrary } from './library.ts'

export async function agentRoutes(app: FastifyInstance, options: { agents: AgentLibrary }): Promise<void> {
  app.get('/api/agents', async () => ({
    agents: options.agents.list().map(({ id, name, description, tools, brain, temperature }) => ({ id, name, description, tools, brain, temperature })),
  }))
}
