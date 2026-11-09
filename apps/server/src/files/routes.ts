// Dropping files into a conversation:
//
//   POST /api/uploads            one file, the raw bytes as the body (Content-Type application/vnd.jarvis.upload,
//                                its name in X-File-Name, URI-encoded; its type in X-File-Type) → { file }
//   POST /api/uploads/attach     { files: [file, …], note? } → adds them to the active session (one "Files" message)
//   GET  /api/workspace-file     ?path=uploads/… → the file, for the transcript (only inside the workspace)
//
// Two steps so a drop of several files becomes one message, after they're all saved.

import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { FileRef } from '../sessions/format.ts'
import type { SessionStore } from '../sessions/store.ts'
import { FileError, contentTypeOf, saveUpload, workspaceFile } from './workspaceFiles.ts'

const UPLOAD_TYPE = 'application/vnd.jarvis.upload'

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof FileError) return reply.code(err.status).send({ error: err.message })
  throw err
}

export async function fileRoutes(app: FastifyInstance, options: { workspaceDir: string; sessions: SessionStore }): Promise<void> {
  const { workspaceDir, sessions } = options

  // The body is streamed straight to disk (saveUpload enforces the size limit), never buffered.
  app.addContentTypeParser(UPLOAD_TYPE, (_req, payload, done) => done(null, payload))

  app.post('/api/uploads', async (req, reply) => {
    if (req.headers['content-type'] !== UPLOAD_TYPE) return reply.code(415).send({ error: `Send the file as ${UPLOAD_TYPE}` })
    const rawName = String(req.headers['x-file-name'] ?? '')
    let name: string
    try {
      name = decodeURIComponent(rawName)
    } catch {
      name = rawName
    }
    const type = String(req.headers['x-file-type'] ?? '')
    try {
      const file = await saveUpload(workspaceDir, req.body as Readable, name || 'file', type)
      req.log.info({ file }, 'upload saved')
      return { file }
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Body: { files?: unknown; note?: unknown } }>('/api/uploads/attach', async (req, reply) => {
    const files = req.body?.files
    if (!Array.isArray(files) || files.length === 0 || files.length > 50) return reply.code(400).send({ error: 'Send { files: [ … ] } (1 to 50)' })
    const refs: FileRef[] = []
    try {
      for (const f of files as Partial<FileRef>[]) {
        if (typeof f?.path !== 'string') return reply.code(400).send({ error: 'Each file needs its path' })
        const absolute = workspaceFile(workspaceDir, f.path) // must exist, inside the workspace
        refs.push({
          path: path.relative(fs.realpathSync(workspaceDir), absolute).split(path.sep).join('/'),
          name: typeof f.name === 'string' && f.name ? f.name : path.basename(absolute),
          type: typeof f.type === 'string' ? f.type.slice(0, 100) : '',
          size: fs.statSync(absolute).size,
        })
      }
    } catch (err) {
      return fail(reply, err)
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000) : ''
    sessions.record({ kind: 'files', at: new Date().toISOString(), text: note, files: refs })
    return { activeId: sessions.activeId(), files: refs }
  })

  app.get<{ Querystring: { path?: string; download?: string } }>('/api/workspace-file', async (req, reply) => {
    try {
      const file = workspaceFile(workspaceDir, String(req.query.path ?? ''))
      const name = path.basename(file)
      return reply
        .header('Content-Type', contentTypeOf(file))
        .header('Content-Length', fs.statSync(file).size)
        .header('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`)
        // A dropped .svg or .html opens as a document of this site: no scripts, no sniffing.
        .header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'")
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, max-age=3600')
        .send(fs.createReadStream(file))
    } catch (err) {
      return fail(reply, err)
    }
  })
}
