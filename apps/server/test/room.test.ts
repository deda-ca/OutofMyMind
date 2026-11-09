import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectListenMode } from '../src/assistant/controls.ts'
import { Room, speakerLabel } from '../src/assistant/room.ts'
import { stamp } from '../src/sessions/history.ts'
import type { SpeakerTag } from '../src/speaker/speakers.ts'
import { StreamSession } from '../src/stream/session.ts'

const tag = (name: string | null, isOwner: boolean | null, confidence: SpeakerTag['confidence'], speakerId: number | null = 1): SpeakerTag => ({
  speakerId,
  name,
  named: true,
  isOwner,
  similarity: null,
  match: null,
  confidence,
})
const OWNER = tag('You', true, 'high', 0)
const MARIA = tag('Maria', false, 'high', 2)

test('speaker labels say how sure the voice match is', () => {
  assert.equal(speakerLabel(OWNER).who, 'Owner')
  assert.equal(speakerLabel(MARIA).who, 'Maria')
  assert.equal(speakerLabel(tag('Maria', false, 'low', 2)).who, 'Maria (probably)')
  assert.equal(speakerLabel(tag('Speaker B', false, 'uncertain', 3)).who, 'Speaker B (unsure)')
  assert.equal(speakerLabel(undefined).who, 'Someone (unknown voice)')
})

test('the room note: who has been heard (counted, sure or not), and what was said, within the window', () => {
  let windowMs = 5 * 60_000
  const room = new Room(() => windowMs)
  const t0 = Date.parse('2026-11-09T14:00:00')
  room.hear(tag('Old', false, 'high', 9), 'long ago', t0 - 10 * 60_000)
  room.hear(MARIA, 'When does the bakery close?', t0)
  room.hear(tag('Speaker B', false, 'uncertain', 3), 'Around six I think', t0 + 5_000)
  const asked = room.hear(OWNER, 'Jarvis, what did Maria ask?', t0 + 60_000)
  asked.inSession = true // it's the request: in the conversation already
  const note = room.note(t0 + 61_000)!
  assert.match(note, /3 voices heard in the last 5 minutes: the owner, Maria \(voice match sure\), Speaker B \(voice match not sure\)\./)
  assert.match(note, /\[14:00:00\] Maria: When does the bakery close\?\n\[14:00:05\] Speaker B \(unsure\): Around six I think\)$/)
  assert.doesNotMatch(note, /long ago|what did Maria ask/)

  // Alone: said so. A longer window brings older lines back. Off: no note.
  assert.match(new Room(() => windowMs).note(t0)!, /Nobody has been heard in the last 5 minutes\./)
  windowMs = 15 * 60_000
  assert.match(room.note(t0 + 61_000)!, /long ago/)
  windowMs = 0
  assert.equal(room.note(t0), null)
})

test('history times: [HH:MM] today, with the day before that', () => {
  const now = new Date('2026-11-09T15:00:00')
  assert.equal(stamp(new Date('2026-11-09T14:30:00').toISOString(), now), '[14:30]')
  assert.match(stamp(new Date('2026-11-08T09:05:00').toISOString(), now), /^\[Sun 8 Nov 09:05\]$/)
})

test('listen-mode commands', () => {
  for (const t of ['Jarvis, only when I say your name', 'wake word only', 'Jarvis, stand by', 'Only answer when I call your name please']) assert.equal(detectListenMode(t), 'wake-word-only', t)
  for (const t of ['Jarvis, normal mode', 'back to normal', 'you can listen for follow ups again', 'follow-ups on']) assert.equal(detectListenMode(t), 'follow-ups', t)
  for (const t of ['what is the normal mode of a distribution', 'stand by me is a good song', 'only']) assert.equal(detectListenMode(t), null, t)
})

// A session with a trained owner voice, where phrases come in with speaker tags.
function session(settings: Record<string, number> = {}) {
  const sent: { type: string; [k: string]: unknown }[] = []
  const s = new StreamSession((m) => sent.push(m as { type: string }), { log: () => {} })
  s.start(16000, 'English', { speakReplies: 0, ...settings })
  const assistant = (s as unknown as { assistant: { handle: (p: unknown) => void } }).assistant
  ;(assistant as unknown as { o: { ownerTrained: () => boolean } }).o.ownerTrained = () => true
  let id = 1
  const say = (speaker: SpeakerTag, text: string) => assistant.handle({ id: id++, archiveId: null, text, speaker })
  const state = () => (sent.filter((m) => m.type === 'assistant.state').at(-1) as { state?: string } | undefined)?.state
  return { s, sent, say, state }
}

test('someone else speaking (surely not the owner) ends the follow-up window: Jarvis steps back', () => {
  const { s, say, state } = session()
  say(OWNER, 'Jarvis')
  assert.equal(state(), 'conversation')
  say(tag('Maria', false, 'low', 2), 'Is that the new speaker?') // not sure it's not the owner: stays
  assert.equal(state(), 'conversation')
  say(MARIA, 'It sounds great.')
  assert.equal(state(), 'idle')
  s.close()
})

test('wake word only: the owner talking without "Jarvis" in a conversation is left alone; the mode switches by voice', async () => {
  const { s, sent, say } = session()
  say(OWNER, 'Jarvis, only when I say your name')
  await new Promise((r) => setImmediate(r))
  assert.ok(sent.some((m) => m.type === 'assistant.done' && String(m.text).startsWith('Understood. Only when you say my name')))
  assert.ok(sent.some((m) => m.type === 'settings' && (m.settings as { wakeWordOnly: number }).wakeWordOnly === 1))
  const before = sent.filter((m) => m.type === 'assistant.start').length
  say(OWNER, 'Did you see the game last night?') // talking to someone else
  assert.equal(sent.filter((m) => m.type === 'assistant.start').length, before)
  say(OWNER, 'Jarvis, normal mode')
  await new Promise((r) => setImmediate(r))
  assert.ok(sent.some((m) => m.type === 'settings' && (m.settings as { wakeWordOnly: number }).wakeWordOnly === 0))
  s.close()
})
