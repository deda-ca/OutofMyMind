import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import Fastify from 'fastify'
import { fileRoutes } from '../src/files/routes.ts'
import { FileError, safeName, saveUpload, workspaceFile } from '../src/files/workspaceFiles.ts'
import { fromMarkdown, toMarkdown } from '../src/sessions/format.ts'
import { filesMessage } from '../src/sessions/history.ts'
import { SessionStore } from '../src/sessions/store.ts'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-files-'))

test('file names: no folders, no link-breaking characters, never empty', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd')
  assert.equal(safeName('C:\\Users\\me\\My Photo (1).jpg'), 'My Photo 1.jpg')
  assert.equal(safeName('notes [draft]#2.md'), 'notes draft2.md')
  assert.equal(safeName('...'), 'file')
})

test('uploads go to uploads/<day>/, never overwrite, and respect the size limit', async () => {
  const ws = tmp()
  const day = new Date('2026-11-09T10:00:00')
  const a = await saveUpload(ws, Readable.from([Buffer.from('hello')]), 'note.md', 'text/markdown', day)
  const b = await saveUpload(ws, Readable.from([Buffer.from('again')]), 'note.md', 'text/markdown', day)
  assert.deepEqual(a, { path: 'uploads/2026-11-09/note.md', name: 'note.md', type: 'text/markdown', size: 5 })
  assert.equal(b.path, 'uploads/2026-11-09/note-1.md')
  assert.equal(fs.readFileSync(path.join(ws, a.path), 'utf8'), 'hello')
  await assert.rejects(saveUpload(ws, Readable.from([]), 'empty.txt', '', day), /empty/)
  assert.ok(!fs.existsSync(path.join(ws, 'uploads/2026-11-09/empty.txt')))
})

test('workspace files: inside only (no .., no symlink out)', () => {
  const ws = tmp()
  fs.writeFileSync(path.join(ws, 'in.txt'), 'x')
  fs.symlinkSync('/etc/hostname', path.join(ws, 'escape'))
  assert.equal(workspaceFile(ws, 'in.txt'), path.join(fs.realpathSync(ws), 'in.txt'))
  assert.throws(() => workspaceFile(ws, '../../etc/passwd'), (e: unknown) => e instanceof FileError && (e.status === 403 || e.status === 404))
  assert.throws(() => workspaceFile(ws, 'escape'), (e: unknown) => e instanceof FileError && e.status === 403)
  assert.throws(() => workspaceFile(ws, 'missing.txt'), /No such file/)
})

test('a files message survives Markdown, and tells the model full paths and limits', () => {
  const files = [
    { path: 'uploads/2026-11-09/My Photo 1.jpg', name: 'My Photo 1.jpg', type: 'image/jpeg', size: 2207345 },
    { path: 'uploads/2026-11-09/list.md', name: 'list.md', type: '', size: 12 },
  ]
  const session = { id: 's', title: '', pinned: false, agent: '', created: '2026-11-09T15:00:00.000Z', updated: '2026-11-09T15:00:00.000Z', entries: [{ kind: 'files' as const, at: '2026-11-09T15:00:00.000Z', text: 'For the album', files }] }
  const md = toMarkdown(session)
  assert.match(md, /- \[My Photo 1\.jpg\]\(<\.\.\/uploads\/2026-11-09\/My Photo 1\.jpg>\) · image\/jpeg · 2207345 bytes/)
  assert.deepEqual(fromMarkdown('s', md).entries, session.entries)
  const message = filesMessage(files, 'For the album')
  assert.match(message, /added 2 files/)
  assert.match(message, /\/uploads\/2026-11-09\/My Photo 1\.jpg \(image\/jpeg, 2\.1 MB\)/)
  assert.match(message, /list\.md \(unknown type, 12 B, text you can read\)/)
  assert.match(message, /can't see inside images/)
  assert.match(message, /move_file/)
  assert.match(message, /note with them: For the album/)
})

test('the routes: upload, attach to the session, read back (sandboxed), refuse outside', async () => {
  const ws = tmp()
  const sessions = new SessionStore(path.join(ws, 'sessions'), path.join(ws, 'sessions.json'))
  const app = Fastify()
  await app.register(fileRoutes, { workspaceDir: ws, sessions })
  const up = await app.inject({ method: 'POST', url: '/api/uploads', headers: { 'content-type': 'application/vnd.jarvis.upload', 'x-file-name': encodeURIComponent('Été photo.png'), 'x-file-type': 'image/png' }, payload: Buffer.from([137, 80, 78, 71]) })
  assert.equal(up.statusCode, 200, up.body)
  const { file } = up.json() as { file: { path: string; name: string } }
  assert.equal(file.name, 'Été photo.png')

  const attach = await app.inject({ method: 'POST', url: '/api/uploads/attach', payload: { files: [file] } })
  assert.equal(attach.statusCode, 200, attach.body)
  const entry = sessions.entries().at(-1)!
  assert.equal(entry.kind, 'files')

  const back = await app.inject({ method: 'GET', url: `/api/workspace-file?path=${encodeURIComponent(file.path)}` })
  assert.equal(back.statusCode, 200)
  assert.equal(back.headers['content-type'], 'image/png')
  assert.match(String(back.headers['content-security-policy']), /sandbox/)
  assert.equal(back.rawPayload.length, 4)

  assert.equal((await app.inject({ method: 'GET', url: '/api/workspace-file?path=../../etc/passwd' })).statusCode >= 403, true)
  assert.equal((await app.inject({ method: 'POST', url: '/api/uploads/attach', payload: { files: [{ path: '../outside' }] } })).statusCode >= 403, true)
  assert.equal((await app.inject({ method: 'POST', url: '/api/uploads', headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode, 415)
  await app.close()
})
