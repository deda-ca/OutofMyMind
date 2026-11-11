// Push to talk (the Android app's held button): a phrase said while it's held
// is for Jarvis without the wake word, but only from the owner's voice.
import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { Assistant, type AssistantMessage } from '../src/assistant/assistant.ts'
import { config } from '../src/config.ts'
import type { SessionEntry } from '../src/sessions/format.ts'
import type { SpeakerTag } from '../src/speaker/speakers.ts'

const owner: SpeakerTag = { speakerId: 1, name: 'You', named: true, isOwner: true, similarity: 0.7, match: null, confidence: 'high' }
const stranger: SpeakerTag = { speakerId: 2, name: 'Speaker A', named: false, isOwner: false, similarity: 0.4, match: 0.8, confidence: 'high' }

test('push to talk: no wake word needed while held; the voice still has to be the owner', async (t) => {
  let asked = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      asked++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Sunny.' } }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const saved = config.llmUrl
  ;(config as { llmUrl: string }).llmUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const events: AssistantMessage[] = []
  const entries: SessionEntry[] = []
  const assistant = new Assistant({
    emit: (m) => events.push(m),
    saveReply: () => {},
    ownerTrained: () => true,
    followUpMs: () => 60_000,
    speak: () => false,
    roomMemoryMs: () => 0,
    session: { entries: () => entries, agentId: () => '', record: (e) => void entries.push(e), startNew: () => void (entries.length = 0) },
    log: () => {},
  })
  t.after(() => {
    assistant.close()
    server.close()
    ;(config as { llmUrl: string }).llmUrl = saved
  })
  const done = () => events.filter((e) => e.type === 'assistant.done').length

  // Idle, no wake word, not held: nothing.
  assistant.handle({ id: 1, archiveId: null, text: "What's the weather tomorrow?", speaker: owner })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(done(), 0)
  // Held, someone else's voice: nothing.
  assistant.handle({ id: 2, archiveId: null, text: "What's the weather tomorrow?", speaker: stranger, addressed: true })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(done(), 0)
  // Held, the owner: answered.
  assistant.handle({ id: 3, archiveId: null, text: "What's the weather tomorrow?", speaker: owner, addressed: true })
  const end = Date.now() + 3000
  while (done() === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
  assert.equal(done(), 1)
  assert.equal(asked, 1)
})
