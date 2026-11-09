import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PhraseSegmenter } from '../src/stream/phraseSegmenter.ts'

const RATE = 16000
const FRAME = 512 // 32 ms
const segmenter = () =>
  new PhraseSegmenter({
    sampleRate: RATE,
    speechThreshold: 0.5,
    silenceThreshold: 0.35,
    pauseMs: 700,
    preSpeechPadMs: 300,
    postSpeechPadMs: 100,
    minSpeechMs: 0,
    maxPhraseMs: 30_000,
  })
const frame = (value: number) => new Int16Array(FRAME).fill(value)

test('muting (cut) ends the phrase in progress at once', () => {
  const s = segmenter()
  assert.deepEqual(s.feed(frame(1), 0.9).map((e) => e.type), ['start'])
  s.feed(frame(1), 0.9)
  const events = s.cut()
  assert.equal(events.length, 1)
  assert.equal(events[0]!.type, 'end')
  assert.equal(s.inPhrase, false)
  assert.deepEqual(s.cut(), []) // nothing left to end
})

test('after muting, the next phrase has no pre-pad audio from before the mute', () => {
  const s = segmenter()
  for (let i = 0; i < 5; i++) s.feed(frame(7), 0.1) // quiet audio, kept as pre-pad
  s.cut()
  s.feed(frame(2), 0.9)
  const [end] = s.cut()
  assert.ok(end?.type === 'end')
  assert.equal(end.audio.length, FRAME) // only the new speech frame
  assert.ok(end.audio.every((v) => v === 2))

  // Without the cut the pre-pad is kept (the behaviour mute changes).
  const t = segmenter()
  for (let i = 0; i < 5; i++) t.feed(frame(7), 0.1)
  t.feed(frame(2), 0.9)
  const [kept] = t.flush()
  assert.ok(kept?.type === 'end' && kept.audio.length > FRAME)
})
