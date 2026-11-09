import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadPluginConfig } from '../src/harness/config.ts'
import { classify } from '../src/harness/crud.ts'
import { McpHub } from '../src/harness/mcp.ts'
import { ToolToggles } from '../src/harness/toggles.ts'

test('CRUD from names, annotations and mcp.json overrides', () => {
  const tag = (name: string, annotations?: Record<string, unknown>, configured?: ('create' | 'read' | 'update' | 'delete')[]) => classify({ name, annotations }, configured)
  assert.deepEqual(tag('list_directory_with_sizes').kinds, ['read'])
  assert.deepEqual(tag('getFileInfo').kinds, ['read'])
  assert.deepEqual(tag('create_directory').kinds, ['create'])
  assert.deepEqual(tag('copy_file').kinds, ['create'])
  assert.deepEqual(tag('write_file').kinds, ['create', 'update'])
  assert.deepEqual(tag('append_to_note').kinds, ['create', 'update'])
  assert.deepEqual(tag('edit_file').kinds, ['update'])
  assert.deepEqual(tag('move_file').kinds, ['update'])
  assert.deepEqual(tag('delete_note').kinds, ['delete'])
  assert.deepEqual(tag('removeItem').kinds, ['delete'])
  assert.deepEqual(tag('frobnicate'), { kinds: ['create', 'update', 'delete'], source: 'unknown' })
  assert.deepEqual(tag('frobnicate', { readOnlyHint: true }), { kinds: ['read'], source: 'annotation' })
  // An annotation saying it changes things beats a reading verb in the name.
  assert.deepEqual(tag('get_or_create', { readOnlyHint: false }).kinds, ['create', 'read'])
  assert.deepEqual(tag('get_token', { readOnlyHint: false }).kinds, ['create', 'update', 'delete'])
  assert.deepEqual(tag('sync', undefined, ['read', 'update']), { kinds: ['read', 'update'], source: 'config' })
})

test('the real plugins are tagged sensibly, and a switched-off kind blocks every tool that does it', async () => {
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-'))
  const pluginsDir = path.resolve(import.meta.dirname, '../../../mcp-plugins')
  const togglesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-t-')), 'tools.json')
  const toggles = new ToolToggles(togglesFile)
  const hub = new McpHub(
    [
      { name: 'notes', timeoutMs: 10_000, transport: { kind: 'stdio', command: process.execPath, args: ['notes/server.ts'], env: { NOTES_DIR: notesDir }, cwd: pluginsDir } },
      {
        name: 'files',
        timeoutMs: 10_000,
        transport: { kind: 'stdio', command: process.execPath, args: ['node_modules/@modelcontextprotocol/server-filesystem/dist/index.js', notesDir], env: {}, cwd: pluginsDir },
      },
    ],
    () => {},
    (plugin, tool, crud) => toggles.allowed(plugin, tool, crud),
  )
  try {
    await hub.start()
    const tags = Object.fromEntries(hub.catalog().flatMap((p) => p.tools.map((t) => [`${p.name}.${t.name}`, t.crud.join('+')])))
    assert.deepEqual(tags, {
      'notes.list_notes': 'read',
      'notes.read_note': 'read',
      'notes.search_notes': 'read',
      'notes.write_note': 'create+update',
      'notes.append_to_note': 'create+update',
      'files.read_file': 'read',
      'files.read_text_file': 'read',
      'files.read_media_file': 'read',
      'files.read_multiple_files': 'read',
      'files.write_file': 'create+update',
      'files.append_file': 'create+update',
      'files.edit_file': 'update',
      'files.create_directory': 'create',
      'files.list_directory': 'read',
      'files.list_directory_with_sizes': 'read',
      'files.directory_tree': 'read',
      'files.move_file': 'update',
      'files.copy_file': 'create',
      'files.search_files': 'read',
      'files.get_file_info': 'read',
      'files.list_allowed_directories': 'read',
    })

    // Updates off: write_file (create+update) goes too; create_directory and the readers stay.
    toggles.setKind('update', false)
    const offered = hub.tools().map((t) => t.function.name)
    assert.ok(!offered.includes('files__write_file') && !offered.includes('files__edit_file') && !offered.includes('notes__append_to_note'))
    assert.ok(offered.includes('files__create_directory') && offered.includes('files__read_text_file'))
    assert.match((await hub.call('files__edit_file', { path: 'x', edits: [] })).text, /switched off/)
    toggles.setKind('update', true)
    assert.ok(hub.tools().some((t) => t.function.name === 'files__edit_file'))
    assert.deepEqual(JSON.parse(fs.readFileSync(togglesFile, 'utf8')).disabledKinds, [])
  } finally {
    await hub.close()
  }
})

test('mcp.json "crud" overrides are read and checked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-'))
  const file = path.join(dir, 'mcp.json')
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { x: { command: 'node', crud: { sync: ['read', 'update'], peek: 'read' } } } }))
  assert.deepEqual(loadPluginConfig(file)[0]!.crud, { sync: ['read', 'update'], peek: ['read'] })
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { x: { command: 'node', crud: { sync: ['write'] } } } }))
  assert.throws(() => loadPluginConfig(file), /use "create", "read", "update" and\/or "delete"/)
})
