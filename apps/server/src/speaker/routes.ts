// REST API for voices and people. These mirror the AI tools in the design
// (list_people, recent_speakers, name_speaker, retag_phrase, merge_people,
// forget_person): the web UI uses them now; the LLM will call the same
// Speakers methods later, after the server checks the request came from the owner.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { backfillSpeakers } from './backfill.ts'
import { SpeakerError, type Speakers } from './speakers.ts'

function id(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof SpeakerError) return reply.code(err.status).send({ error: err.message })
  throw err
}

export async function speakerRoutes(app: FastifyInstance, options: { speakers: Speakers; dataDir: string }): Promise<void> {
  const { speakers } = options

  // ---------------------------------------------------------------- owner voice training

  app.get('/api/owner', async () => {
    if (!speakers.enabled) return { enabled: false, clips: [] }
    return { enabled: true, model: speakers.model?.name, clips: speakers.ownerClips() }
  })

  app.delete<{ Params: { phraseId: string } }>('/api/owner/clips/:phraseId', async (req, reply) => {
    const phraseId = id(req.params.phraseId)
    if (!phraseId) return reply.code(400).send({ error: 'Invalid id' })
    if (!speakers.removeOwnerClip(phraseId)) return reply.code(404).send({ error: 'Not in the voice library' })
    return { ok: true }
  })

  app.delete('/api/owner/clips', async () => ({ removed: speakers.resetOwner() }))

  // ---------------------------------------------------------------- people (AI tools)

  /** list_people */
  app.get('/api/people', async () => ({ people: speakers.listPeople() }))

  /** A person's voice-library clips. */
  app.get<{ Params: { id: string } }>('/api/people/:id/clips', async (req, reply) => {
    const personId = id(req.params.id)
    if (!personId) return reply.code(400).send({ error: 'Invalid id' })
    return { clips: speakers.clips(personId) }
  })

  /** recent_speakers: who spoke in the last N minutes (default 5), most recent first. */
  app.get<{ Querystring: { minutes?: string } }>('/api/speakers/recent', async (req) => {
    const minutes = Math.min(Math.max(Number(req.query.minutes) || 5, 1), 24 * 60)
    return { speakers: speakers.recentSpeakers(minutes) }
  })

  /** name_speaker. `:id` may be "recent-other" = the most recent speaker other than the owner. */
  app.put<{ Params: { id: string }; Body: { name?: unknown } }>('/api/people/:id/name', async (req, reply) => {
    try {
      const personId = req.params.id === 'recent-other' ? (speakers.mostRecentOther()?.id ?? null) : id(req.params.id)
      if (!personId) return reply.code(404).send({ error: 'Nobody other than you has spoken recently.' })
      if (typeof req.body?.name !== 'string') return reply.code(400).send({ error: 'Expected {"name": "…"}' })
      return { person: speakers.nameSpeaker(personId, req.body.name) }
    } catch (err) {
      return fail(reply, err)
    }
  })

  /** retag_phrase: body {"personId": 12} or {"personId": "new"}. */
  app.put<{ Params: { id: string }; Body: { personId?: unknown } }>('/api/phrases/:id/speaker', async (req, reply) => {
    try {
      const phraseId = id(req.params.id)
      const target = req.body?.personId === 'new' ? 'new' : id(req.body?.personId)
      if (!phraseId || !target) return reply.code(400).send({ error: 'Expected {"personId": <id> | "new"}' })
      speakers.retagPhrase(phraseId, target)
      return { ok: true }
    } catch (err) {
      return fail(reply, err)
    }
  })

  /** merge_people: body {"into": <id>}. */
  app.post<{ Params: { id: string }; Body: { into?: unknown } }>('/api/people/:id/merge', async (req, reply) => {
    try {
      const from = id(req.params.id)
      const into = id(req.body?.into)
      if (!from || !into) return reply.code(400).send({ error: 'Expected {"into": <id>}' })
      speakers.mergePeople(from, into)
      return { ok: true }
    } catch (err) {
      return fail(reply, err)
    }
  })

  /** forget_person: ?deleteAudio=true also deletes their recordings' audio. */
  app.delete<{ Params: { id: string }; Querystring: { deleteAudio?: string } }>('/api/people/:id', async (req, reply) => {
    try {
      const personId = id(req.params.id)
      if (!personId) return reply.code(400).send({ error: 'Invalid id' })
      speakers.forgetPerson(personId, req.query.deleteAudio === 'true')
      return { ok: true }
    } catch (err) {
      return fail(reply, err)
    }
  })

  /** Tag archived phrases recorded before speaker recognition existed. */
  app.post<{ Querystring: { force?: string } }>('/api/speakers/backfill', async (req, reply) => {
    try {
      return await backfillSpeakers(speakers, options.dataDir, req.query.force === 'true')
    } catch (err) {
      return fail(reply, err)
    }
  })
}
