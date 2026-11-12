import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FRAME_SAMPLES } from '../src/phone/rtp.ts'
import { VoiceLeg } from '../src/phone/voice.ts'

/** A frame of speech-like loudness (or silence), 20 ms at 16 kHz. */
const frame = (loud: boolean) => {
  const f = new Int16Array(FRAME_SAMPLES)
  if (loud) for (let i = 0; i < FRAME_SAMPLES; i++) f[i] = Math.round(3000 * Math.sin(i / 3))
  return f
}

test("what the other side says while Marvin isn't listening is kept for the next listen", async () => {
  const leg = new VoiceLeg({ name: 'Marvin', synthesize: async () => Buffer.alloc(0), transcribe: async () => 'hi' })
  // One second of talking, then a second of quiet: the utterance ends with nobody waiting.
  for (let i = 0; i < 50; i++) leg.write(frame(true))
  for (let i = 0; i < 50; i++) leg.write(frame(false))
  const got = await leg.hear(100)
  assert.ok(got && got.length > FRAME_SAMPLES * 10, 'the utterance is still there when Marvin listens')
  leg.close()
})

test('a call: the other side talks while Marvin is thinking, and Marvin hears it after', async () => {
  const { errandCall } = await import('../src/phone/errand.ts')
  const { wavFromPcm } = await import('../src/audiocpp.ts')
  // Each utterance's words are queued in the order they're fed; the transcriber returns them in that order.
  const words: string[] = []
  const heard: string[] = []
  const leg = new VoiceLeg({
    name: 'Marvin',
    synthesize: async () => wavFromPcm(Buffer.alloc(6400), 16000),
    transcribe: async () => {
      const w = words.shift() ?? ''
      heard.push(w)
      return w
    },
  })
  // Frames arrive every 20 ms, as on a line (the echo guard after Marvin talks drops what comes in the same instant).
  const pace = () => new Promise((r) => setTimeout(r, 20))
  const speak = async (text: string) => {
    words.push(text)
    for (let i = 0; i < 50; i++) {
      leg.write(frame(true))
      await pace()
    }
    for (let i = 0; i < 50; i++) {
      leg.write(frame(false))
      await pace()
    }
  }
  // Marvin's audio goes out as it's played (the bridge reads Marvin's leg every 20 ms).
  const drain = setInterval(() => leg.read(), 20)
  drain.unref()
  try {
    // They say the greeting as the call connects: nobody is listening yet, so Marvin keeps it.
    await speak("Joe's Garage, how can I help?")
    let turns = 0
    const done = errandCall({
      marvin: leg,
      brief: { number: '16135550123', who: "Joe's Garage", goal: 'ask for an oil change', share: '', windows: [], minutes: 60, title: '', voicemail: false },
      ownerName: 'Sam',
      callback: '6 1 3, 5 5 5, 0 1 9 9',
      assistantName: 'Marvin',
      recordingNotice: false,
      target: { url: 'http://x', model: 'm' },
      busy: async () => [],
      book: async () => null,
      dtmf: () => {},
      hangUp: async () => {},
      report: () => {},
      timing: { firstMs: 300, answerMs: 300, keyGapMs: 0 },
      loop: (async () => {
        // Marvin is thinking; the other side says something now, while nobody is listening.
        if (turns++ === 0) void speak('Sure, what time?')
        await new Promise((r) => setTimeout(r, 2500))
        return { text: 'Tuesday at nine works.', steps: [] }
      }) as never,
    })
    const result = await Promise.race([done, new Promise((r) => setTimeout(() => r('timeout'), 20_000))])
    assert.notEqual(result, 'timeout')
    assert.ok(heard.includes("Joe's Garage, how can I help?"), 'the greeting is heard')
    assert.ok(heard.includes('Sure, what time?'), 'what they said while Marvin was thinking is heard')
  } finally {
    clearInterval(drain)
    leg.close()
  }
})
