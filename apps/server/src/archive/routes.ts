// REST API for browsing the archive and marking recordings "keep forever".

import fs from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type { Archive } from './archive.ts'

function positiveInt(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function keepBody(body: unknown): { keep: boolean; note: string | null } | null {
  if (typeof body !== 'object' || body === null) return null
  const { keep, note } = body as { keep?: unknown; note?: unknown }
  if (typeof keep !== 'boolean') return null
  if (note !== undefined && note !== null && typeof note !== 'string') return null
  return { keep, note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null }
}

export async function archiveRoutes(app: FastifyInstance, options: { archive: Archive }): Promise<void> {
  const { archive } = options

  /** Newest first. `before` = a conversation id, for paging. */
  app.get<{ Querystring: { limit?: string; before?: string } }>('/api/conversations', async (req) => {
    const limit = Math.min(positiveInt(req.query.limit) ?? 50, 200)
    return { conversations: archive.listConversations(limit, positiveInt(req.query.before) ?? undefined) }
  })

  app.get<{ Params: { id: string } }>('/api/conversations/:id/phrases', async (req, reply) => {
    const id = positiveInt(req.params.id)
    if (!id) return reply.code(400).send({ error: 'Invalid id' })
    return { phrases: archive.conversationPhrases(id) }
  })

  app.get<{ Params: { id: string } }>('/api/phrases/:id/audio', async (req, reply) => {
    const id = positiveInt(req.params.id)
    const file = id ? archive.phraseAudioPath(id) : null
    if (!file || !fs.existsSync(file)) return reply.code(404).send({ error: 'No audio for this phrase' })
    return reply
      .header('Content-Type', 'audio/ogg; codecs=opus')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(fs.createReadStream(file))
  })

  app.put<{ Params: { id: string } }>('/api/conversations/:id/keep', async (req, reply) => {
    const id = positiveInt(req.params.id)
    const body = keepBody(req.body)
    if (!id || !body) return reply.code(400).send({ error: 'Expected {"keep": true|false, "note"?: string}' })
    if (!archive.setConversationKeep(id, body.keep, body.note)) return reply.code(404).send({ error: 'Not found' })
    return { ok: true }
  })

  app.put<{ Params: { id: string } }>('/api/phrases/:id/keep', async (req, reply) => {
    const id = positiveInt(req.params.id)
    const body = keepBody(req.body)
    if (!id || !body) return reply.code(400).send({ error: 'Expected {"keep": true|false, "note"?: string}' })
    if (!archive.setPhraseKeep(id, body.keep, body.note)) return reply.code(404).send({ error: 'Not found' })
    return { ok: true }
  })
}
