// REST API for the owner's voice profile.

import type { FastifyInstance } from 'fastify'
import type { Speakers } from './speakers.ts'

export async function speakerRoutes(app: FastifyInstance, options: { speakers: Speakers }): Promise<void> {
  const { speakers } = options

  /** Whether speaker recognition is on, and the owner's training clips. */
  app.get('/api/owner', async () => {
    if (!speakers.enabled) return { enabled: false, clips: [] }
    return { enabled: true, model: speakers.model?.name, clips: speakers.ownerClips() }
  })

  /** Remove one clip from the owner's voice library (the recording stays in the archive). */
  app.delete<{ Params: { phraseId: string } }>('/api/owner/clips/:phraseId', async (req, reply) => {
    const id = Number(req.params.phraseId)
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Invalid id' })
    if (!speakers.removeOwnerClip(id)) return reply.code(404).send({ error: 'Not in the voice library' })
    return { ok: true }
  })

  /** Empty the owner's voice library (recordings stay in the archive). */
  app.delete('/api/owner/clips', async () => ({ removed: speakers.resetOwner() }))
}
