// REST API for the Skills tab: list, view, create, edit, delete, export, import.
// Skills are files in WORKSPACE_DIR/skills (library.ts); hand edits there show up here too.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { SkillError, editableSkill, type SkillInput, type SkillLibrary } from './library.ts'

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof SkillError) return reply.code(err.status).send({ error: err.message })
  throw err
}

function input(body: unknown): SkillInput {
  const b = (body ?? {}) as Record<string, unknown>
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : [])
  return {
    name: String(b.name ?? ''),
    description: String(b.description ?? ''),
    files: list(b.files),
    triggers: list(b.triggers),
    rules: String(b.rules ?? ''),
    template: String(b.template ?? ''),
  }
}

/** The bundle "Export all" downloads and import accepts. */
interface Bundle {
  format: 'jarvis-skills'
  version: 1
  exported: string
  skills: { id: string; text: string }[]
}

export async function skillRoutes(app: FastifyInstance, options: { skills: SkillLibrary }): Promise<void> {
  const { skills } = options
  const listing = () => ({
    skills: skills.list().map((s) => ({ ...editableSkill(s.id, skills.source(s.id) ?? ''), hasTemplate: !!s.template })),
  })

  app.get('/api/skills', async () => listing())

  app.post<{ Body: unknown }>('/api/skills', async (req, reply) => {
    try {
      const id = (req.body as { id?: unknown } | undefined)?.id
      const created = skills.create(input(req.body), typeof id === 'string' && id ? id : undefined)
      return { created: created.id, ...listing() }
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.put<{ Params: { id: string }; Body: unknown }>('/api/skills/:id', async (req, reply) => {
    try {
      skills.save(req.params.id, input(req.body))
      return listing()
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.delete<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    try {
      skills.remove(req.params.id)
      return listing()
    } catch (err) {
      return fail(reply, err)
    }
  })

  /** One skill, as its .md file. */
  app.get<{ Params: { id: string } }>('/api/skills/:id/export', async (req, reply) => {
    const text = skills.source(req.params.id)
    if (text === undefined) return reply.code(404).send({ error: 'No such skill' })
    return reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${req.params.id}.md"`)
      .send(text)
  })

  /** Every skill, as one bundle to import elsewhere. */
  app.get('/api/skills-export', async (_req, reply) => {
    const bundle: Bundle = {
      format: 'jarvis-skills',
      version: 1,
      exported: new Date().toISOString(),
      skills: skills.list().map((s) => ({ id: s.id, text: skills.source(s.id) ?? '' })),
    }
    const day = bundle.exported.slice(0, 10)
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="jarvis-skills-${day}.json"`)
      .send(JSON.stringify(bundle, null, 2))
  })

  /**
   * Import: { files: [{ name, text }], onConflict: "rename" | "replace" | "skip" }. Each file is a
   * skill (.md: its name is the id) or an exported bundle (.json). Reports each skill's outcome.
   */
  app.post<{ Body: { files?: unknown; onConflict?: unknown } }>('/api/skills/import', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const files = req.body?.files
    const onConflict = req.body?.onConflict === 'replace' || req.body?.onConflict === 'skip' ? req.body.onConflict : 'rename'
    if (!Array.isArray(files) || files.length === 0 || files.length > 100) return reply.code(400).send({ error: 'Send { files: [{ name, text }] } (1 to 100)' })
    const results: { file: string; id?: string; result: string; error?: string }[] = []
    for (const f of files as { name?: unknown; text?: unknown }[]) {
      const name = String(f?.name ?? 'skill.md')
      const text = String(f?.text ?? '')
      // A bundle from "Export all": every skill in it.
      let entries: { id: string; text: string }[] = [{ id: name, text }]
      if (/\.json$/i.test(name)) {
        try {
          const bundle = JSON.parse(text) as Partial<Bundle>
          if (bundle.format !== 'jarvis-skills' || !Array.isArray(bundle.skills)) throw new Error('not a Jarvis skills export')
          entries = bundle.skills.map((s) => ({ id: String(s.id), text: String(s.text) }))
        } catch (err) {
          results.push({ file: name, result: 'error', error: `Not a skills export: ${(err as Error).message}` })
          continue
        }
      }
      for (const entry of entries) {
        try {
          const outcome = skills.importText(entry.id, entry.text, onConflict)
          results.push({ file: name, id: outcome.id, result: outcome.result })
        } catch (err) {
          results.push({ file: name, id: entry.id, result: 'error', error: err instanceof SkillError ? err.message : (err as Error).message })
        }
      }
    }
    return { results, ...listing() }
  })
}
