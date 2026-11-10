import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import Fastify from 'fastify'
import { SkillLibrary } from '../src/skills/library.ts'
import { skillRoutes } from '../src/skills/routes.ts'

async function appWith(seed = true) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skillroutes-'))
  const skills = new SkillLibrary(ws)
  if (seed) skills.seed()
  const app = Fastify()
  await app.register(skillRoutes, { skills })
  return { app, ws, skills }
}

test('skills tab: create, edit (comments kept), export one and all, import with each conflict choice, delete', async () => {
  const { app, ws, skills } = await appWith()
  const created = await app.inject({
    method: 'POST',
    url: '/api/skills',
    payload: { name: 'Reading list', description: 'Books to read', files: ['lists/reading.md'], triggers: ['book', 'read'], rules: '<!-- mine -->\n## Adding\n- One book per line.', template: '# Reading list\n' },
  })
  assert.equal(created.statusCode, 200, created.body)
  assert.equal(created.json().created, 'reading-list')
  const listed = (await app.inject({ method: 'GET', url: '/api/skills' })).json().skills as { id: string; rules: string; template: string; hasTemplate: boolean }[]
  const reading = listed.find((s) => s.id === 'reading-list')!
  assert.equal(reading.rules, '<!-- mine -->\n## Adding\n- One book per line.') // comments kept for editing
  assert.equal(reading.template, '# Reading list')
  assert.equal(reading.hasTemplate, true)
  assert.equal(skills.get('reading-list')!.template, '# Reading list')

  // Editing keeps the file name; Jarvis's dated rules survive a round trip through the editor.
  skills.addRule('reading-list', 'Adding', 'Note the author.', '2026-11-09')
  const before = (await app.inject({ method: 'GET', url: '/api/skills' })).json().skills.find((s: { id: string }) => s.id === 'reading-list')
  assert.match(before.rules, /- Note the author\. <!-- added 2026-11-09 -->/)
  const saved = await app.inject({ method: 'PUT', url: '/api/skills/reading-list', payload: { ...before, description: 'Books I want to read' } })
  assert.equal(saved.statusCode, 200, saved.body)
  assert.match(fs.readFileSync(path.join(ws, 'skills/reading-list.md'), 'utf8'), /description: "Books I want to read"[\s\S]*<!-- added 2026-11-09 -->[\s\S]*## Template\n```markdown\n# Reading list\n```/)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/skills/reading-list', payload: { ...before, files: ['../etc/passwd'] } })).statusCode, 400)

  // Export one (the .md) and all (a bundle).
  const one = await app.inject({ method: 'GET', url: '/api/skills/reading-list/export' })
  assert.match(String(one.headers['content-disposition']), /attachment; filename="reading-list\.md"/)
  assert.equal(one.body, fs.readFileSync(path.join(ws, 'skills/reading-list.md'), 'utf8'))
  const all = await app.inject({ method: 'GET', url: '/api/skills-export' })
  const bundle = all.json() as { format: string; skills: { id: string; text: string }[] }
  assert.equal(bundle.format, 'jarvis-skills')
  assert.deepEqual(bundle.skills.map((s) => s.id).sort(), ['reading-list', 'todo', 'weight-log'])

  // Import the bundle into an empty workspace, then again with each conflict choice.
  const other = await appWith(false)
  const imp = (files: unknown, onConflict: string) => other.app.inject({ method: 'POST', url: '/api/skills/import', payload: { files, onConflict } })
  const first = (await imp([{ name: 'jarvis-skills.json', text: all.body }], 'rename')).json()
  assert.deepEqual(first.results.map((r: { result: string }) => r.result), ['created', 'created', 'created'])
  assert.equal(fs.readFileSync(path.join(other.ws, 'skills/todo.md'), 'utf8'), fs.readFileSync(path.join(ws, 'skills/todo.md'), 'utf8'))
  const again = (await imp([{ name: 'todo.md', text: bundle.skills.find((s) => s.id === 'todo')!.text }], 'rename')).json()
  assert.deepEqual(again.results[0], { file: 'todo.md', id: 'todo-2', result: 'created' })
  assert.equal((await imp([{ name: 'todo.md', text: 'x' }], 'skip')).json().results[0].result, 'skipped')
  const replaced = (await imp([{ name: 'todo.md', text: '---\nname: "To-do list"\nfiles: [todo.md]\ntriggers: [todo]\n---\n## Short\n- Just this.' }], 'replace')).json()
  assert.equal(replaced.results[0].result, 'replaced')
  assert.equal(other.skills.get('todo')!.body, '## Short\n- Just this.')
  // A plain Markdown file: named after the file.
  const plain = (await imp([{ name: 'Packing List.md', text: '## Rules\n- One item per line.' }], 'rename')).json()
  assert.deepEqual(plain.results[0], { file: 'Packing List.md', id: 'packing-list', result: 'created' })
  assert.equal(other.skills.get('packing-list')!.name, 'packing-list')
  // Not a skills export.
  assert.equal((await imp([{ name: 'random.json', text: '{"a":1}' }], 'rename')).json().results[0].result, 'error')

  // Delete.
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/skills/reading-list' })).statusCode, 200)
  assert.ok(!fs.existsSync(path.join(ws, 'skills/reading-list.md')))
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/skills/reading-list' })).statusCode, 404)
  await app.close()
  await other.app.close()
})
