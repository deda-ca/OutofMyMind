import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { NotesStore } from '../notes/store.ts'

async function store(): Promise<NotesStore> {
  const s = new NotesStore(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-')))
  await s.init()
  return s
}

test('write, append, read, list and search', async () => {
  const s = await store()
  assert.deepEqual(await s.write('projects/jarvis', '# Jarvis'), { relative: 'projects/jarvis.md', created: true })
  await s.append('shopping', '- milk')
  await s.append('shopping.md', '- eggs')
  assert.equal(await s.read('shopping'), '- milk\n- eggs\n')
  assert.deepEqual((await s.list()).map((n) => n.path), ['projects/jarvis.md', 'shopping.md'])
  assert.deepEqual((await s.list('projects')).map((n) => n.path), ['projects/jarvis.md'])
  assert.deepEqual(await s.search('EGGS'), [{ path: 'shopping.md', line: 2, text: '- eggs' }])
})

test('paths cannot leave the notes folder', async () => {
  const s = await store()
  for (const bad of ['../secret', '/etc/passwd', 'a/../../b', '']) await assert.rejects(s.read(bad))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
  fs.symlinkSync(outside, path.join(s.root, 'link'))
  await assert.rejects(s.write('link/escape', 'x'), /outside/)
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('missing notes give a clear message', async () => {
  await assert.rejects((await store()).read('nothing'), /There is no note "nothing.md"/)
})
