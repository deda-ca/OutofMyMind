import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StreamSession } from '../src/stream/session.ts'
import type { ServerMessage } from '../src/stream/protocol.ts'

function session() {
  const sent: ServerMessage[] = []
  const s = new StreamSession((m) => sent.push(m), { log: () => {} })
  s.start(16000, 'English', { speakReplies: 0 })
  return { s, sent }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('typed text is echoed as a final owner phrase and wakes Jarvis without a voiceprint', async () => {
  const { s, sent } = session()
  s.typed('  Jarvis  ')
  await settle()
  const phrase = sent.find((m) => m.type === 'phrase')
  assert.deepEqual(phrase, { type: 'phrase', id: 1, text: 'Jarvis', final: true, typed: true })
  const speaker = sent.find((m) => m.type === 'phrase.speaker')
  assert.equal(speaker?.type === 'phrase.speaker' && speaker.speaker.isOwner, true)
  assert.ok(sent.some((m) => m.type === 'assistant.done' && m.text === 'Yes?'))
  assert.ok(sent.some((m) => m.type === 'assistant.state' && m.state === 'conversation'))
  s.close()
})

test('typed dismissal ends the conversation', async () => {
  const { s, sent } = session()
  s.typed('Jarvis')
  s.typed("that's all")
  await settle()
  assert.ok(sent.some((m) => m.type === 'assistant.done' && m.kind === 'dismiss'))
  const last = sent.filter((m) => m.type === 'assistant.state').at(-1)
  assert.equal(last?.type === 'assistant.state' && last.state, 'idle')
  s.close()
})

test('blank typed text is ignored', async () => {
  const { s, sent } = session()
  const before = sent.length
  s.typed('   ')
  await settle()
  assert.equal(sent.length, before)
  s.close()
})
