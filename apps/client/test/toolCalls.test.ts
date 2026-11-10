// Run: node --test test/ (Node strips the TypeScript types).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filesIn, workspaceFile } from '../src/toolCalls.ts'

const read = (name: string) => ({ name, crud: ['read'] })
const W = '/home/me/jarvis/apps/server/data/workspace'

test('a file a tool call named opens in the side panel when it is in the workspace', () => {
  assert.equal(workspaceFile(read('files__read_text_file'), `${W}/todo.md`), 'todo.md')
  assert.equal(workspaceFile(read('files__read_text_file'), `${W}/scripts/tmp/2026-11-10.js`), 'scripts/tmp/2026-11-10.js')
  assert.equal(workspaceFile({ name: 'files__write_file', crud: ['create', 'update'] }, `${W}/lists/shopping.md`), 'lists/shopping.md')
  // The notes plugin names notes by their path in notes/.
  assert.equal(workspaceFile(read('notes__read_note'), 'shopping'), 'notes/shopping.md')
  assert.equal(workspaceFile(read('notes__read_note'), 'trips/japan.md'), 'notes/trips/japan.md')
})

test("folders, files outside the workspace, binaries and deleted files aren't links", () => {
  assert.equal(workspaceFile(read('files__list_directory'), `${W}/lists`), null)
  assert.equal(workspaceFile(read('files__directory_tree'), `${W}/notes/a.md`), null)
  assert.equal(workspaceFile(read('files__get_file_info'), `${W}/lists`), null) // no extension: a folder
  assert.equal(workspaceFile(read('files__read_text_file'), '/etc/hosts'), null)
  assert.equal(workspaceFile(read('files__read_media_file'), `${W}/uploads/a.zip`), null)
  assert.equal(workspaceFile({ name: 'notes__delete_note', crud: ['delete'] }, 'old'), null)
  assert.equal(workspaceFile(read('notes__read_note'), '../../etc/passwd'), null)
})

test('the paths in a call are found by their argument names', () => {
  assert.deepEqual(filesIn(JSON.stringify({ source: `${W}/a.md`, destination: `${W}/b.md`, content: 'x' })), [`${W}/a.md`, `${W}/b.md`])
  assert.deepEqual(filesIn(JSON.stringify({ paths: [`${W}/a.md`, `${W}/c.md`] })), [`${W}/a.md`, `${W}/c.md`])
})
