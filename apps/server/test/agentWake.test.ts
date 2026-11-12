// "Chef, …": an agent called by name takes the session over, and it's the one
// that answers (its instructions in the system prompt). The assistant with a fake LLM.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { AgentLibrary, toAgentFile, validate } from '../src/agents/library.ts'
import { Assistant, type AssistantMessage } from '../src/assistant/assistant.ts'
import { config } from '../src/config.ts'
import type { SessionEntry } from '../src/sessions/format.ts'

async function fakeLlm() {
  const systems: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      systems.push(String(JSON.parse(body).messages[0].content))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { systems, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => (server.closeAllConnections(), server.close()) }
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test("an agent's name wakes it and switches the session to it; the default agent's name switches back", async (t) => {
  const llm = await fakeLlm()
  const saved = config.llmUrl
  ;(config as { llmUrl: string }).llmUrl = llm.url
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agentwake-'))
  t.after(() => {
    ;(config as { llmUrl: string }).llmUrl = saved
    llm.close()
    fs.rmSync(ws, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(ws, 'agents'), { recursive: true })
  const agents = new AgentLibrary(ws)
  fs.writeFileSync(path.join(ws, 'agents', 'chef.md'), toAgentFile(validate({ name: 'Chef', description: 'Cooking', tools: null, body: 'You are the kitchen helper.' })))
  let agent = ''
  const switched: string[] = []
  const entries: SessionEntry[] = []
  const events: AssistantMessage[] = []
  const assistant = new Assistant({
    emit: (m) => events.push(m),
    saveReply: () => {},
    ownerTrained: () => false,
    followUpMs: () => 60_000,
    speak: () => false,
    roomMemoryMs: () => 0,
    agents,
    session: { entries: () => entries, agentId: () => agent, record: (e) => void entries.push(e), startNew: () => {}, setAgent: (a) => void switched.push((agent = a)) },
    log: () => {},
  })
  const done = () => events.filter((e) => e.type === 'assistant.done').length
  let id = 0
  const say = async (text: string) => {
    const before = done()
    assistant.handle({ id: ++id, archiveId: null, text, speaker: undefined })
    await until(() => done() > before)
  }

  await say('Chef, how long do I boil an egg?')
  assert.deepEqual(switched, ['chef'])
  assert.match(llm.systems.at(-1)!, /You are the kitchen helper\./)
  // Chef again: already Chef, nothing changes. Just the name: "Yes?", no switch.
  await say('Chef, and a soft one?')
  assert.deepEqual(switched, ['chef'])
  // "Jarvis" is the default agent: the session goes back to the default.
  await say('Jarvis, what is the weather?')
  assert.deepEqual(switched, ['chef', ''])
  assert.doesNotMatch(llm.systems.at(-1)!, /kitchen helper/)
  // Typed works the same.
  const before = done()
  assistant.handleTyped({ id: ++id, archiveId: null, text: 'chef: what can I make with leeks?', speaker: undefined })
  await until(() => done() > before)
  assert.deepEqual(switched, ['chef', '', 'chef'])
  assistant.close()
})
