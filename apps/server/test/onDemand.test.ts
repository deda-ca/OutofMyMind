import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { ChatTarget } from '../src/assistant/llm.ts'
import { harness } from '../src/harness/index.ts'

// Tools on demand (docs/tool-loading.md): a plugin marked "on demand" is not
// sent with every request; the model loads it with tools__load, and then its
// tools are offered for the rest of the reply. Run against the real notes plugin.

let script: Record<string, unknown>[][] = []
const requests: { messages: { role: string; content?: unknown }[]; tools?: { function: { name: string } }[] }[] = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    requests.push(JSON.parse(body))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const delta of script.shift() ?? []) {
      const choice = 'finish_reason' in delta ? { delta: {}, finish_reason: delta.finish_reason } : { delta }
      res.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`)
    }
    res.end('data: [DONE]\n\n')
  })
})
let target: ChatTarget
let dir: string
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  target = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: 'test' }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'on-demand-'))
  const notesDir = path.join(dir, 'notes')
  fs.mkdirSync(notesDir)
  fs.writeFileSync(path.join(notesDir, 'shopping.md'), '- milk\n- eggs\n')
  const pluginsDir = path.resolve(import.meta.dirname, '../../../plugins')
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        notes: {
          command: process.execPath,
          args: [path.join(pluginsDir, 'notes/server.ts')],
          env: { NOTES_DIR: notesDir },
          load: 'on demand',
          summary: 'the owner\'s notes and lists (read, append, write)',
        },
      },
    }),
  )
  await harness.start(path.join(dir, 'mcp.json'), () => {})
})
after(async () => {
  await harness.close()
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const names = (r: { tools?: { function: { name: string } }[] }) => (r.tools ?? []).map((t) => t.function.name)

test('the on-demand plugin is listed by a line, its tools are left out, and tools__load is offered', async () => {
  assert.deepEqual(harness['hub']!.deferred().map((d) => d.name), ['notes'])
  const guidance = harness.toolGuidance()
  assert.match(guidance, /notes \(on demand\): the owner's notes and lists/)
  assert.doesNotMatch(guidance, /notes__read_note/, "its full instructions aren't in the system prompt")

  requests.length = 0
  script = [[{ content: 'Nothing needed.' }]]
  await harness.run(target, [{ role: 'user', content: 'hi' }], () => {})
  const offered = names(requests[0]!)
  assert.ok(offered.includes('tools__load'))
  assert.ok(!offered.some((n) => n.startsWith('notes__')), 'no notes tools until they are loaded')
})

test('the model loads the plugin, and its tools are offered from the next step on', async () => {
  requests.length = 0
  script = [
    [{ tool_calls: [{ index: 0, id: 'l1', function: { name: 'tools__load', arguments: '{"plugin":"notes"}' } }] }],
    [{ tool_calls: [{ index: 0, id: 'r1', function: { name: 'notes__read_note', arguments: '{"path":"shopping"}' } }] }],
    [{ content: 'You need milk and eggs.' }],
  ]
  const events: string[] = []
  const r = await harness.run(target, [{ role: 'user', content: "what's on my shopping list?" }], () => {}, undefined, (e) => e.call?.status === 'running' && events.push(e.call.name))
  assert.equal(r.text, 'You need milk and eggs.')
  assert.ok(!names(requests[0]!).some((n) => n.startsWith('notes__')))
  assert.ok(names(requests[1]!).includes('notes__read_note'), 'loaded: offered after tools__load')
  const result = requests[2]!.messages.at(-1)!
  assert.equal(result.role, 'tool')
  assert.equal(result.content, '- milk\n- eggs\n')
  assert.deepEqual(events, ['tools__load', 'notes__read_note'])
})

test('a new reply starts with the plugin on demand again (the prompt stays the same across replies)', async () => {
  requests.length = 0
  script = [[{ content: 'Hello.' }]]
  await harness.run(target, [{ role: 'user', content: 'hi again' }], () => {})
  assert.ok(!names(requests[0]!).some((n) => n.startsWith('notes__')))
})

test('loading a plugin the agent may not use is refused, and nothing is loaded', async () => {
  requests.length = 0
  script = [
    [{ tool_calls: [{ index: 0, id: 'l2', function: { name: 'tools__load', arguments: '{"plugin":"notes"}' } }] }],
    [{ content: 'Okay.' }],
  ]
  // The agent may only use tools whose names start with "weather__": notes isn't among them, so it isn't offered at all.
  await harness.run(target, [{ role: 'user', content: 'list my notes' }], () => {}, undefined, undefined, (name) => name.startsWith('weather__'))
  assert.ok(!names(requests[0]!).includes('tools__load'), 'no tools__load when none of its tools may be used')
})

test('an unknown plugin name to tools__load is an error', async () => {
  requests.length = 0
  script = [
    [{ tool_calls: [{ index: 0, id: 'l3', function: { name: 'tools__load', arguments: '{"plugin":"nope"}' } }] }],
    [{ content: 'Sorry.' }],
  ]
  await harness.run(target, [{ role: 'user', content: 'x' }], () => {})
  const result = requests[1]!.messages.at(-1)!
  assert.match(String(result.content), /No plugin "nope" to load/)
})
