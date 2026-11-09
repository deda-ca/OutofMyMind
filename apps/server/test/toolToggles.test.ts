import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { McpHub } from '../src/harness/mcp.ts'
import { ToolToggles } from '../src/harness/toggles.ts'

test('tool switches: on unless switched off, saved, and a plugin switch covers its tools', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-toggles-')), 'tools.json')
  const toggles = new ToolToggles(file)
  assert.equal(toggles.allowed('notes', 'read_note'), true)

  toggles.setTool('notes', 'delete_note', false)
  toggles.setPlugin('weather', false)
  assert.equal(toggles.allowed('notes', 'delete_note'), false)
  assert.equal(toggles.allowed('notes', 'read_note'), true)
  assert.equal(toggles.allowed('weather', 'forecast'), false)
  assert.equal(toggles.toolEnabled('weather', 'forecast'), true) // its own switch is still on

  // Saved, and read back by a fresh instance (a server restart).
  const reloaded = new ToolToggles(file)
  assert.equal(reloaded.allowed('notes', 'delete_note'), false)
  assert.equal(reloaded.pluginEnabled('weather'), false)

  reloaded.setTool('notes', 'delete_note', true)
  reloaded.setPlugin('weather', true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { disabledPlugins: [], disabledTools: {}, disabledKinds: [] })
})

test('the hub neither offers nor runs a switched-off tool, but still lists it', async () => {
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-'))
  const pluginsDir = path.resolve(import.meta.dirname, '../../../mcp-plugins')
  const off = new Set(['append_to_note'])
  const hub = new McpHub(
    [{ name: 'notes', timeoutMs: 10_000, transport: { kind: 'stdio', command: process.execPath, args: ['notes/server.ts'], env: { NOTES_DIR: notesDir }, cwd: pluginsDir } }],
    () => {},
    (_plugin, tool) => !off.has(tool),
  )
  try {
    await hub.start()
    const offered = hub.tools().map((t) => t.function.name)
    assert.ok(!offered.includes('notes__append_to_note'), offered.join())
    assert.ok(offered.includes('notes__read_note'), offered.join())
    const refused = await hub.call('notes__append_to_note', { path: 'x', text: 'y' })
    assert.equal(refused.isError, true)
    assert.match(refused.text, /switched off/)
    assert.equal(fs.existsSync(path.join(notesDir, 'x.md')), false)

    // The Tools tab still sees it, with its parameters.
    const [notes] = hub.catalog()
    const append = notes.tools.find((t) => t.name === 'append_to_note')
    assert.ok(append && 'properties' in append.parameters)

    off.clear()
    assert.ok(hub.tools().some((t) => t.function.name === 'notes__append_to_note'))
  } finally {
    await hub.close()
  }
})
