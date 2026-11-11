import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { AgentEvent, ChatTarget } from '../src/assistant/llm.ts'
import { loadPluginConfig } from '../src/harness/config.ts'
import { toolGuidance } from '../src/harness/index.ts'
import { runLoop, type LoopMessage, type ToolHost } from '../src/harness/loop.ts'
import { McpHub } from '../src/harness/mcp.ts'

// A fake chat server: each request gets the next scripted list of SSE deltas.
let script: Record<string, unknown>[][] = []
const requests: { messages: LoopMessage[]; tools?: unknown[] }[] = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    requests.push(JSON.parse(body))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const delta of script.shift() ?? []) {
      // { finish_reason } goes on the choice (e.g. "length": cut off at max_tokens); anything else is a delta.
      const choice = 'finish_reason' in delta ? { delta: {}, finish_reason: delta.finish_reason } : { delta }
      res.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`)
    }
    res.end('data: [DONE]\n\n')
  })
})
let target: ChatTarget
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  target = { url: `http://127.0.0.1:${port}`, model: 'test' }
})
after(() => server.close())

const host = (calls: { name: string; args: Record<string, unknown> }[]): ToolHost => ({
  tools: () => [{ type: 'function', function: { name: 'notes__read_note', parameters: { type: 'object' } } }],
  label: (name) => name,
  call: async (name, args) => {
    calls.push({ name, args })
    return { text: '- milk\n- eggs', isError: false }
  },
})

test('the loop runs streamed tool calls and feeds the results back', async () => {
  requests.length = 0
  script = [
    [
      { content: 'Let me look.' },
      { tool_calls: [{ index: 0, id: 'c1', function: { name: 'notes__read_note', arguments: '{"pa' } }] },
      { tool_calls: [{ index: 0, function: { arguments: 'th":"shopping"}' } }] },
    ],
    [{ content: 'You need milk' }, { content: ' and eggs.' }],
  ]
  const calls: { name: string; args: Record<string, unknown> }[] = []
  let streamed = ''
  const { text: said, steps } = await runLoop(target, [{ role: 'user', content: "what's on my shopping list?" }], host(calls), { onDelta: (d) => (streamed += d) })
  assert.equal(said, 'Let me look. You need milk and eggs.')
  assert.equal(streamed, said)
  assert.deepEqual(steps, requests[1].messages.slice(-2))
  assert.deepEqual(calls, [{ name: 'notes__read_note', args: { path: 'shopping' } }])
  assert.equal(requests.length, 2)
  assert.ok(requests[0].tools?.length)
  assert.deepEqual(requests[1].messages.slice(-2), [
    { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'notes__read_note', arguments: '{"path":"shopping"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '- milk\n- eggs' },
  ])
})

test('the last step is sent without tools, so the loop always ends', async () => {
  requests.length = 0
  const call = [{ tool_calls: [{ index: 0, id: 'c', function: { name: 'notes__read_note', arguments: '{}' } }] }]
  script = [call, call, [{ content: 'Done.' }]]
  const { text, steps } = await runLoop(target, [{ role: 'user', content: 'loop forever' }], host([]), { onDelta: () => {}, maxSteps: 3 })
  assert.equal(text, 'Done.')
  assert.equal(steps.length, 4)
  assert.equal(requests[2].tools, undefined)
})

test('bad tool arguments come back to the model as an error', async () => {
  requests.length = 0
  script = [[{ tool_calls: [{ index: 0, id: 'c', function: { name: 'notes__read_note', arguments: '{oops' } }] }], [{ content: 'Sorry.' }]]
  const calls: { name: string; args: Record<string, unknown> }[] = []
  await runLoop(target, [{ role: 'user', content: 'x' }], host(calls), { onDelta: () => {} })
  assert.equal(calls.length, 0)
  const toolMessage = requests[1].messages.at(-1) as { content: string }
  assert.match(toolMessage.content, /^Error: The arguments were not valid JSON/)
})

test('plugin config: mcpServers format, disabled entries skipped, ${VAR} expanded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-'))
  const file = path.join(dir, 'mcp.json')
  process.env.JARVIS_TEST_TOKEN = 'secret'
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        a: { command: 'node', args: ['a.ts'], env: { X: '${JARVIS_TEST_TOKEN}' } },
        b: { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer ${JARVIS_TEST_TOKEN}' } },
        c: { command: 'node', enabled: false },
        d: { command: 'node', exclude: ['run_anything'], maxResultChars: 20000 },
      },
    }),
  )
  const plugins = loadPluginConfig(file)
  assert.deepEqual(plugins.map((p) => p.name), ['a', 'b', 'd'])
  assert.deepEqual([plugins[2].exclude, plugins[2].maxResultChars], [['run_anything'], 20000])
  assert.equal('exclude' in plugins[0], false)
  assert.deepEqual(plugins[0].transport, { kind: 'stdio', command: 'node', args: ['a.ts'], env: { X: 'secret' }, cwd: dir })
  assert.deepEqual(plugins[1].transport, { kind: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer secret' } })
  assert.deepEqual(loadPluginConfig(path.join(dir, 'missing.json')), [])
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { e: { command: 'node', maxResultChars: 50 } } }))
  assert.throws(() => loadPluginConfig(file), /maxResultChars/)
})

test('the hub runs the real notes plugin over stdio', async () => {
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-'))
  const pluginsDir = path.resolve(import.meta.dirname, '../../../plugins')
  const logs: string[] = []
  const hub = new McpHub(
    [{ name: 'notes', timeoutMs: 10_000, transport: { kind: 'stdio', command: process.execPath, args: ['notes/server.ts'], env: { NOTES_DIR: notesDir }, cwd: pluginsDir } }],
    (m) => logs.push(m),
  )
  try {
    await hub.start()
    assert.deepEqual(hub.status()[0].connected, true, logs.join('\n'))
    const names = hub.tools().map((t) => t.function.name)
    assert.ok(names.includes('notes__append_to_note') && names.includes('notes__read_note'), names.join())
    assert.equal((await hub.call('notes__append_to_note', { path: 'shopping', text: '- milk' })).text, 'Created shopping.md.')
    assert.equal((await hub.call('notes__read_note', { path: 'shopping' })).text, '- milk\n')
    const escape = await hub.call('notes__read_note', { path: '../../etc/passwd' })
    assert.equal(escape.isError, true)
    assert.equal((await hub.call('nope__tool', {})).isError, true)
    // Every call is logged, so "it said it saved but didn't" can be checked in the server log.
    assert.ok(logs.some((l) => l.startsWith('harness: notes.append_to_note {"path":"shopping","text":"- milk"} → Created shopping.md.')), logs.join('\n'))
  } finally {
    await hub.close()
  }
})

test('tool guidance and plugin instructions are added to the system message', () => {
  const guidance = toolGuidance(['weather: The owner lives in Ottawa.'])
  assert.match(guidance, /^You have tools\..*never guess/s)
  assert.match(guidance, /- weather: The owner lives in Ottawa\.$/)
  assert.doesNotMatch(toolGuidance([]), /About the tools/)
})

test('each tool call is announced when it starts and again with its result, CRUD tags and time', async () => {
  script = [
    [{ tool_calls: [{ index: 0, id: 'c9', function: { name: 'notes__read_note', arguments: '{"path":"shopping"}' } }] }],
    [{ content: 'Milk and eggs.' }],
  ]
  const events: AgentEvent[] = []
  const tagged: ToolHost = { ...host([]), crud: (name) => (name === 'notes__read_note' ? ['read'] : []) }
  await runLoop(target, [{ role: 'user', content: 'list?' }], tagged, { onDelta: () => {}, onEvent: (e) => events.push(e) })
  assert.equal(events.length, 2)
  assert.deepEqual(events[0]!.call, { id: 'c9', name: 'notes__read_note', args: '{"path":"shopping"}', crud: ['read'], status: 'running' })
  const done = events[1]!.call!
  assert.equal(done.status, 'done')
  assert.equal(done.id, 'c9')
  assert.equal(done.result, '- milk\n- eggs')
  assert.equal(done.isError, false)
  assert.ok(typeof done.durationMs === 'number')
})

test('tool-call markup written as text is never passed on; the reply says it stopped', async () => {
  script = [[{ content: 'Let me create it. <tool_' }, { content: 'call>\n<function=files__write_file>…' }]]
  let streamed = ''
  const { text } = await runLoop(target, [{ role: 'user', content: 'x' }], host([]), { onDelta: (d) => (streamed += d) })
  assert.doesNotMatch(streamed, /tool_call|function=/)
  assert.equal(streamed, text)
  assert.match(text, /^Let me create it\. +I couldn't finish that in one go/)
})

test('a cut-off tool call is not run, goes back as {} (so llama-server can parse the history), and the model is told to split it', async () => {
  requests.length = 0
  script = [
    [{ tool_calls: [{ index: 0, id: 'w1', function: { name: 'notes__read_note', arguments: '{"path":"todo","content":"# To-do\\n\\n- [ ] Book doc' } }] }, { finish_reason: 'length' }],
    [{ content: 'I will write it in parts.' }],
  ]
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const events: AgentEvent[] = []
  await runLoop(target, [{ role: 'user', content: 'organise it' }], host(calls), { onDelta: () => {}, onEvent: (e) => events.push(e) })
  assert.equal(calls.length, 0) // never run
  const sentBack = requests[1]!.messages.slice(-2) as { role: string; tool_calls?: { function: { arguments: string } }[]; content?: string }[]
  assert.equal(sentBack[0]!.tool_calls![0]!.function.arguments, '{}')
  assert.match(String(sentBack[1]!.content), /^Error: Not done: .* Split the work into smaller calls/)
  assert.equal(events.at(-1)!.call!.isError, true)
})

test("a plugin's excluded tools are never offered or run; its result limit applies", async () => {
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-'))
  fs.writeFileSync(path.join(notesDir, 'long.md'), 'x'.repeat(5000))
  const pluginsDir = path.resolve(import.meta.dirname, '../../../plugins')
  const hub = new McpHub(
    [{ name: 'notes', timeoutMs: 10_000, exclude: ['append_to_note'], maxResultChars: 1000, transport: { kind: 'stdio', command: process.execPath, args: ['notes/server.ts'], env: { NOTES_DIR: notesDir }, cwd: pluginsDir } }],
    () => {},
  )
  try {
    await hub.start()
    const names = hub.tools().map((t) => t.function.name)
    assert.ok(names.includes('notes__read_note'), names.join())
    assert.ok(!names.includes('notes__append_to_note'))
    assert.ok(!hub.catalog()[0].tools.some((t) => t.name === 'append_to_note'))
    const refused = await hub.call('notes__append_to_note', { path: 'x', text: 'y' })
    assert.equal(refused.isError, true)
    assert.equal(fs.existsSync(path.join(notesDir, 'x.md')), false)
    assert.match((await hub.call('notes__read_note', { path: 'long' })).text, /^x{1000}\n… \(cut: 400\d more characters\)$/)
  } finally {
    await hub.close()
    fs.rmSync(notesDir, { recursive: true, force: true })
  }
})
