import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { AgentLibrary, DEFAULT_SYSTEM, parseAgent, toAgentFile, toolAllowed } from '../src/agents/library.ts'
import { config } from '../src/config.ts'
import { SessionStore } from '../src/sessions/store.ts'
import { StreamSession } from '../src/stream/session.ts'

test('agent files: frontmatter (inline and block lists, all/none), comments left out', () => {
  // A leftover "brain:" line (from when Hermes was an option) is ignored.
  const email = parseAgent('email', '---\nname: Email\ndescription: "Drafts replies"\ntools: [files__read_text_file, email__*]  # read only\nbrain: local\ntemperature: 0.4\n---\n<!-- note to self -->\nDraft replies for {{owner}}.\n')
  assert.deepEqual(email, { id: 'email', name: 'Email', description: 'Drafts replies', tools: ['files__read_text_file', 'email__*'], temperature: 0.4, instructions: 'Draft replies for {{owner}}.', body: '<!-- note to self -->\nDraft replies for {{owner}}.' })
  assert.deepEqual(parseAgent('t', '---\ntools:\n  - files__*\n  - weather__get_weather\n---\nTest things.').tools, ['files__*', 'weather__get_weather'])
  assert.equal(parseAgent('a', '---\ntools: all\n---\n').tools, null)
  assert.deepEqual(parseAgent('n', '---\ntools: none\ntemperature: 9\nbrain: gpt\n---\n').tools, [])
  const plain = parseAgent('plain', 'Just instructions, no frontmatter.')
  assert.equal(plain.name, 'plain')
  assert.equal(plain.tools, null)
  assert.equal(plain.temperature, undefined)
  assert.equal(parseAgent('n', '---\ntemperature: 9\n---\n').temperature, undefined)
})

test('tool patterns: exact names and * wildcards', () => {
  const agent = parseAgent('x', '---\ntools: [files__read_*, weather__get_weather]\n---\n')
  assert.equal(toolAllowed(agent, 'files__read_text_file'), true)
  assert.equal(toolAllowed(agent, 'files__write_file'), false)
  assert.equal(toolAllowed(agent, 'weather__get_weather'), true)
  assert.equal(toolAllowed(agent, 'weather__get_weatherX'), false)
  assert.equal(toolAllowed(parseAgent('all', ''), 'anything__at_all'), true)
})

test('SYSTEM.md: seeded once, comments out, owner filled in; missing = default, empty = none', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-'))
  const lib = new AgentLibrary(ws)
  lib.seed()
  assert.equal(fs.readFileSync(path.join(ws, 'SYSTEM.md'), 'utf8'), DEFAULT_SYSTEM)
  assert.ok(fs.existsSync(path.join(ws, 'agents', 'jarvis.md')))
  const text = lib.system('Charbel')
  assert.match(text, /^You are Jarvis, Charbel's private assistant/)
  assert.doesNotMatch(text, /<!--|\{\{/)

  fs.writeFileSync(path.join(ws, 'SYSTEM.md'), 'Always answer in French.')
  lib.seed() // never overwrites
  assert.equal(lib.system('Charbel'), 'Always answer in French.')
  fs.writeFileSync(path.join(ws, 'SYSTEM.md'), '')
  fs.utimesSync(path.join(ws, 'SYSTEM.md'), new Date(), new Date(Date.now() + 5000))
  assert.equal(lib.system('Charbel'), '')
  fs.rmSync(path.join(ws, 'SYSTEM.md'))
  assert.match(lib.system('Charbel'), /^You are Jarvis/)

  fs.writeFileSync(path.join(ws, 'agents', 'email.md'), '---\nname: Email\n---\nDraft.')
  assert.deepEqual(lib.list().map((a) => a.id), ['jarvis', 'email'])
  assert.equal(lib.get('missing').id, 'jarvis')
  assert.equal(lib.get('../../etc/passwd').id, 'jarvis')
})

test("a request carries SYSTEM.md, the session's agent and its temperature, with the time last", async () => {
  const bodies: { messages: { role: string; content: string }[]; temperature?: number }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      bodies.push(JSON.parse(body))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Drafted.' } }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const savedUrl = config.llmUrl
  ;(config as { llmUrl: string }).llmUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-'))
    const agents = new AgentLibrary(ws)
    agents.seed()
    fs.writeFileSync(path.join(ws, 'SYSTEM.md'), 'SYSTEM RULES for {{owner}}.')
    fs.writeFileSync(path.join(ws, 'agents', 'email.md'), '---\nname: Email\ntools: none\ntemperature: 0.2\n---\nEMAIL RULES.')
    const store = new SessionStore(path.join(ws, 'sessions'), path.join(ws, 'sessions.json'))
    store.startNew('email')

    const sent: { type: string; text?: string }[] = []
    const s = new StreamSession((m) => sent.push(m as { type: string }), { sessions: store, agents, log: () => {} })
    s.start(16000, 'English', { speakReplies: 0 })
    s.typed('Reply to Maria saying yes.')
    for (let i = 0; i < 100 && !sent.some((m) => m.type === 'assistant.done'); i++) await new Promise((r) => setTimeout(r, 20))
    s.close()

    const [request] = bodies
    assert.ok(request)
    assert.equal(request.temperature, 0.2)
    const system = request.messages[0]!
    assert.equal(system.role, 'system')
    const order = ['SYSTEM RULES for', 'not to you', '## Agent: Email\nEMAIL RULES.', 'It is '].map((t) => system.content.indexOf(t))
    assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!)), system.content)
    assert.ok(system.content.trimEnd().endsWith('.') && /It is [^\n]+$/.test(system.content), 'the time comes last')
    assert.equal(store.get(store.activeId()!)?.agent, 'email') // the new session got the chosen agent
  } finally {
    ;(config as { llmUrl: string }).llmUrl = savedUrl
    server.close()
  }
})

test('agents from the editor: create, edit, delete, default; files read back the same', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-'))
  const lib = new AgentLibrary(ws, path.join(ws, 'agents.json'))
  lib.seed()
  const input = { name: 'Email #1: replies', description: 'Drafts "replies" # not a comment', tools: ['files__read_*', 'files__write_file'], temperature: 0.4, body: '<!-- mine -->\nDraft replies for {{owner}}.' }

  const id = lib.create(input)
  assert.equal(id, 'email-1-replies')
  const saved = lib.get(id)
  assert.deepEqual(
    { name: saved.name, description: saved.description, tools: saved.tools, temperature: saved.temperature, body: saved.body, instructions: saved.instructions },
    { ...input, instructions: 'Draft replies for {{owner}}.' },
  )
  assert.throws(() => lib.create(input), /already an agent/)
  assert.throws(() => lib.create({ ...input, name: '' }), /name is needed/)
  assert.throws(() => lib.create({ ...input, name: 'x', tools: ['rm -rf'] }), /function names/)
  assert.throws(() => lib.create({ ...input, name: 'y', temperature: 5 }), /temperature/)

  lib.update(id, { ...input, tools: [], temperature: undefined, body: 'Shorter.' })
  const edited = lib.get(id)
  assert.deepEqual(edited.tools, [])
  assert.equal(edited.temperature, undefined)
  assert.equal(edited.instructions, 'Shorter.')
  assert.equal(lib.get(id).name, 'Email #1: replies') // the id (file name) stays when edited
  assert.match(toAgentFile({ ...input, tools: null }), /^---\nname: "Email #1: replies"\n.*tools: all\n/s)

  // The default agent: '' resolves to it; deleting it falls back to Jarvis.
  assert.equal(lib.defaultId(), 'jarvis')
  lib.setDefault(id)
  assert.equal(lib.get('').id, id)
  assert.equal(lib.list()[0]!.id, id)
  assert.throws(() => lib.setDefault('nope'), /No agent/)
  assert.throws(() => lib.remove('jarvis'), /can be edited but not deleted/)
  lib.remove(id)
  assert.equal(lib.defaultId(), 'jarvis')
  assert.equal(lib.get(id).id, 'jarvis') // a session that used it falls back
})

test('an agent can have its own voice: read from its file, written back, checked', () => {
  const agent = parseAgent('coach', '---\nname: Coach\nvoice: male-tz-calm   # calmer\n---\nKeep {{owner}} on track.\n')
  assert.equal(agent.voice, 'male-tz-calm')
  assert.equal(parseAgent('x', '---\nname: X\n---\n').voice, undefined)
  assert.equal(parseAgent('x', '---\nvoice: "not a voice!"\n---\n').voice, undefined)
  const file = toAgentFile({ name: 'Coach', description: '', tools: null, voice: 'male-tz-calm', body: 'Hi.' })
  assert.match(file, /^voice: male-tz-calm$/m)
  assert.equal(parseAgent('coach', file).voice, 'male-tz-calm')
  assert.doesNotMatch(toAgentFile({ name: 'Plain', description: '', tools: null, body: '' }), /voice:/)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agents-'))
  try {
    const library = new AgentLibrary(dir)
    const id = library.create({ name: 'Coach', description: '', tools: null, voice: 'female-au-bright', body: '' })
    assert.equal(library.get(id).voice, 'female-au-bright')
    library.update(id, { name: 'Coach', description: '', tools: null, body: '' })
    assert.equal(library.get(id).voice, undefined)
    assert.throws(() => library.create({ name: 'Bad', description: '', tools: null, voice: 'a b', body: '' }), /voice/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
