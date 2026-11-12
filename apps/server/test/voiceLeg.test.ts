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

/** Speech-like loudness (sine amplitude a), 20 ms at 16 kHz. */
const tone = (a: number) => {
  const f = new Int16Array(FRAME_SAMPLES)
  for (let i = 0; i < FRAME_SAMPLES; i++) f[i] = Math.round(a * Math.sin(i / 3))
  return f
}

test("the line's echo of Marvin doesn't stop it; the other side talking over it does", async () => {
  const { BARGE_MS, BARGE_MIN_RMS } = await import('../src/phone/voice.ts')
  assert.ok(BARGE_MIN_RMS > 0 && BARGE_MS >= 200)
  const leg = new VoiceLeg({ name: 'Marvin', synthesize: async () => Buffer.alloc(0), transcribe: async () => '' })
  // Marvin's voice: 1.5 s of loud tone, played out at real time. The echo comes back 100 ms later, a quarter as loud.
  const pcm = new Int16Array(FRAME_SAMPLES * 75)
  for (let f = 0; f < 75; f++) pcm.set(tone(6000), f * FRAME_SAMPLES)
  const sent: Int16Array[] = []
  const pace = () => new Promise((r) => setTimeout(r, 20))
  const playing = leg.play(pcm)
  const echo: Int16Array[] = []
  for (let f = 0; f < 75; f++) {
    const out = leg.read()
    if (out) sent.push(out)
    // The echo: what went out 5 frames ago, quieter.
    const old = sent[f - 5]
    const e = old ? old.map((x) => Math.round(x * 0.25)) : new Int16Array(FRAME_SAMPLES)
    echo.push(e)
    leg.write(e)
    await pace()
  }
  await playing
  assert.equal(leg.interrupted, 0, "Marvin finished its sentence: the echo didn't stop it")
  leg.close()
})

test('the other side talking over Marvin for 300 ms stops it, and what they say is heard', async () => {
  const leg = new VoiceLeg({ name: 'Marvin', synthesize: async () => Buffer.alloc(0), transcribe: async () => 'Wait, what time?' })
  const pcm = new Int16Array(FRAME_SAMPLES * 150)
  for (let f = 0; f < 150; f++) pcm.set(tone(6000), f * FRAME_SAMPLES)
  const playing = leg.play(pcm)
  // Marvin is playing; after 200 ms the other side starts talking over it, at a voice that's quieter than Marvin's but clearly speech.
  const pace = () => new Promise((r) => setTimeout(r, 20))
  const heard = leg.hear(3000)
  for (let f = 0; f < 150; f++) {
    leg.read()
    if (f >= 10) leg.write(tone(4000))
    else leg.write(new Int16Array(FRAME_SAMPLES))
    await pace()
    if (leg.interrupted) break
  }
  await playing
  assert.equal(leg.interrupted, 1, 'Marvin stopped')
  // Then the other side keeps talking a moment, and silence ends the utterance.
  // (A pause of over 800 ms ends the utterance.)
  for (let f = 0; f < 80; f++) {
    leg.write(f < 30 ? tone(4000) : new Int16Array(FRAME_SAMPLES))
    await pace()
  }
  const got = await heard
  assert.ok(got && got.length > FRAME_SAMPLES * 10, 'their words are what Marvin hears')
  leg.close()
})

test('a sentence cut off by the other side is recorded as the part that was said; a finished one whole', async () => {
  const { wavFromPcm } = await import('../src/audiocpp.ts')
  const { cutText } = await import('../src/phone/voice.ts')
  assert.equal(cutText('one two three four five six', 0.5), 'one two three')
  assert.equal(cutText('one two three four', 0), '')
  const text = 'one two three four five six seven eight nine ten'
  const logged: string[] = []
  // Two seconds of Marvin's voice (the test's audio), played out at real time.
  const leg = new VoiceLeg({
    name: 'Marvin',
    synthesize: async () => wavFromPcm(Buffer.alloc(64000), 16000),
    transcribe: async () => '',
    onSay: (said) => void logged.push(said),
  })
  const pace = () => new Promise((r) => setTimeout(r, 20))
  const drain = setInterval(() => leg.read(), 20)
  drain.unref()
  try {
    // Finished: nothing talks over it.
    const whole = await leg.say('Okay then.')
    assert.equal(whole, 'Okay then.')
    // Cut off after about a second of two: the other side talks over it.
    const said = leg.say(text)
    await new Promise((r) => setTimeout(r, 1000))
    for (let f = 0; f < 60 && leg.interrupted === 0; f++) {
      leg.write(tone(4000))
      await pace()
    }
    const part = await said
    assert.equal(leg.interrupted, 1)
    assert.ok(part.length > 0 && part.length < text.length, `cut: "${part}"`)
    assert.ok(text.startsWith(part), 'what was said is the start of the sentence')
    assert.deepEqual(logged, ['Okay then.', part], 'the live transcript has what was said, not the whole sentence')
  } finally {
    clearInterval(drain)
    leg.close()
  }
})
