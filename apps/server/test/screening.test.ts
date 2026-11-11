import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { wavFromPcm } from '../src/audiocpp.ts'
import { Bridge } from '../src/phone/bridge.ts'
import { FRAME_SAMPLES } from '../src/phone/rtp.ts'
import { Phone } from '../src/phone/phone.ts'
import { cleanRules, decide, DEFAULT_RULES, inQuietHours, isUsNumber, RulesStore } from '../src/phone/rules.ts'
import { type OwnerLeg, type ScreenDeps, type ScreenResult, screenCall, spokenNumber, type Stage } from '../src/phone/screening.ts'
import { LiveTranscript } from '../src/phone/live.ts'
import { CallEnded, VoiceLeg, wavToPcm16k } from '../src/phone/voice.ts'

test('rules: blocked, screens first, no cell, always, quiet hours (past midnight)', () => {
  const rules = cleanRules({ ...DEFAULT_RULES, always: [{ number: '613-555-0101', name: 'Mom' }], blocked: [{ number: '+1 613 555 0199', name: '' }], quietFrom: '22:00', quietTo: '07:00' })
  const noon = new Date(2026, 10, 11, 12, 0)
  const late = new Date(2026, 10, 11, 23, 30)
  const early = new Date(2026, 10, 12, 6, 59)
  const cell = { ownerCell: '6135550111' }
  assert.equal(decide(rules, '16135550199', { ...cell, now: noon }), 'block')
  assert.equal(decide(rules, '16135550101', { ...cell, now: late }), 'through')
  assert.equal(decide(rules, '16135550123', { ...cell, now: noon }), 'screen')
  assert.equal(decide(rules, '16135550123', { ...cell, now: late }), 'message')
  assert.equal(decide(rules, '16135550123', { ...cell, now: early }), 'message')
  assert.equal(decide(rules, '16135550123', { ownerCell: '', now: noon }), 'message')
  assert.equal(decide({ ...rules, answer: 'screens' }, '16135550123', { ...cell, now: noon }), 'ring')
  assert.equal(inQuietHours({ quietFrom: '', quietTo: '07:00' }, late), false)
  // Bad input from the Phone tab is made safe.
  const bad = cleanRules({ answer: 'everyone', always: [{ number: '' }, 'x', { number: '613 555 0101', name: 'A'.repeat(200) }], quietFrom: '25:00', recordingNotice: 'no' })
  assert.deepEqual({ ...bad, always: bad.always.map((c) => [c.number, c.name.length]) }, { answer: 'marvin', always: [['6135550101', 80]], blocked: [], quietFrom: '', quietTo: '', recordingNotice: true })
  assert.equal(isUsNumber('12125550123'), true)
  assert.equal(isUsNumber('16135550123'), false)
  assert.equal(spokenNumber('16135550123'), '6 1 3, 5 5 5, 0 1 2 3')
})

test('voice: a 24 kHz WAV becomes 16 kHz, keeping a tone', () => {
  const n = 2400 // 100 ms
  const pcm = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2)
  const out = wavToPcm16k(wavFromPcm(pcm, 24000))
  assert.equal(out.length, 1600)
  // Where the tone should be at 16 kHz, give or take the filter.
  let err = 0
  for (let i = 10; i < 1590; i++) err = Math.max(err, Math.abs(out[i]! - 8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)))
  assert.ok(err < 400, `max error ${err}`)
})

const frameOf = (level: number) => Int16Array.from({ length: FRAME_SAMPLES }, (_, i) => Math.round(level * Math.sin(i / 3)))

test('voice: hears an utterance after the speaker stops, not while Marvin talks', async () => {
  const leg = new VoiceLeg({ name: 'Marvin', synthesize: async () => wavFromPcm(Buffer.alloc(FRAME_SAMPLES * 2 * 3), 16000), transcribe: async (pcm) => `heard ${pcm.length}` })
  // Marvin talking: three frames out; what comes in meanwhile is ignored.
  const said = leg.say('hello')
  await new Promise((r) => setImmediate(r))
  for (let i = 0; i < 3; i++) {
    leg.write(frameOf(5000))
    assert.ok(leg.read())
  }
  await said
  assert.equal(leg.read(), null)
  const heard = leg.listen(1000, { endSilenceMs: 100 })
  // Wait out the echo guard, then: background noise, speech, silence.
  await new Promise((r) => setTimeout(r, 300))
  for (let i = 0; i < 20; i++) leg.write(frameOf(50))
  for (let i = 0; i < 25; i++) leg.write(frameOf(4000))
  for (let i = 0; i < 5; i++) leg.write(frameOf(50))
  const text = await heard
  // The speech, a little of what came before it, and the silence that ended it.
  const frames = Number(text.split(' ')[1]) / FRAME_SAMPLES
  assert.ok(frames >= 25 && frames <= 25 + 10 + 5, text)
  // Nobody talks: ''.
  assert.equal(await leg.listen(50), '')
  // The call ends while listening.
  const pending = leg.hear(5000)
  leg.close()
  await assert.rejects(pending, CallEnded)
})

test('bridge: recording can be stopped (and what was recorded is dropped)', () => {
  const bridge = new Bridge()
  bridge.join({ name: 'A', read: () => frameOf(1000), write: () => {} })
  bridge.tick()
  assert.equal(bridge.recordings().length, 1)
  bridge.stopRecording()
  bridge.tick()
  assert.equal(bridge.isRecording, false)
  assert.deepEqual(bridge.recordings(), [])
})

/** Marvin with a script: what it says is noted; what it hears comes from `answers`. */
function fakeVoice(answers: string[], log: string[], who: string, endsAfter = Infinity) {
  let ended = false
  let says = 0
  const voice = {
    async say(text: string) {
      if (ended || says++ >= endsAfter) throw new CallEnded()
      log.push(`${who}: ${text}`)
    },
    async play() {
      log.push(`${who}: (beep)`)
    },
    async listen() {
      if (ended) throw new CallEnded()
      return answers.shift() ?? ''
    },
    async hear() {
      if (ended) throw new CallEnded()
      const a = answers.shift()
      return a ? new Int16Array(FRAME_SAMPLES) : null
    },
    close() {
      ended = true
    },
  }
  return voice as unknown as VoiceLeg & { close(): void }
}

function scenario(o: { decision?: ScreenDeps['decision']; caller: string[]; owner?: { answers: string[]; digits: (string | null)[] } | null; callerEndsAfter?: number }) {
  const log: string[] = []
  const stages: Stage[] = []
  const reports: ScreenResult[] = []
  let connected = false
  let callerHungUp = false
  let ownerHungUp = false
  let recordingStopped = false
  const ownerVoice = o.owner ? fakeVoice(o.owner.answers, log, 'to owner') : null
  const owner: OwnerLeg | null = o.owner
    ? {
        voice: ownerVoice!,
        nextDigit: async () => {
          // Speech gets its turn first in the race.
          await new Promise((r) => setTimeout(r, 1))
          return o.owner!.digits.shift() ?? null
        },
        hangUp: async () => {
          ownerHungUp = true
          ownerVoice!.close()
        },
        get ended() {
          return ownerHungUp
        },
      }
    : null
  const deps: ScreenDeps = {
    marvin: fakeVoice(o.caller, log, 'to caller', o.callerEndsAfter),
    decision: o.decision ?? 'screen',
    callerLabel: 'Someone at 6 1 3, 5 5 5, 0 1 2 3',
    ownerName: 'Charlie Day',
    assistantName: 'Marvin',
    recordingNotice: true,
    ringOwner: async () => owner,
    connect: () => (connected = true),
    stopRecording: () => (recordingStopped = true),
    hangUp: async () => {
      callerHungUp = true
    },
    stage: (s) => stages.push(s),
    report: (r) => reports.push(r),
    clockMs: () => 12_345,
    timing: { holdMs: 5, choiceMs: 50, answerMs: 10, messageMs: 200, messageSilenceMs: 10 },
  }
  return {
    run: () => screenCall(deps),
    log,
    stages,
    reports,
    get connected() {
      return connected
    },
    get callerHungUp() {
      return callerHungUp
    },
    get ownerHungUp() {
      return ownerHungUp
    },
    get recordingStopped() {
      return recordingStopped
    },
  }
}

test('screening: asks who it is, tells the owner, and connects on 1', async () => {
  const s = scenario({ caller: ["It's Dr. Smith's office about Thursday's appointment"], owner: { answers: [], digits: ['1'] } })
  const r = await s.run()
  assert.equal(r.outcome, 'connected')
  assert.equal(s.connected, true)
  assert.equal(s.callerHungUp, false)
  assert.match(s.log[0]!, /^to caller: Hi, you've reached Charlie Day's phone\. I'm Marvin, an AI assistant\. This call is recorded\. Who's calling/)
  assert.ok(s.log.some((l) => /^to owner: Hi Charlie, it's Marvin\. Someone at 6 1 3, 5 5 5, 0 1 2 3 is calling\. They said: It's Dr\. Smith's office about Thursday's appointment\. Press 1/.test(l)), s.log.join('\n'))
  assert.deepEqual(s.stages, ['greeting', 'asking', 'ringing owner', 'announcing', 'connected'])
  assert.equal(s.reports.at(-1)?.outcome, 'connected')
})

test('screening: "connect" said aloud works too; voicemail (no answer to the question) never gets connected', async () => {
  const yes = scenario({ caller: ['Bob'], owner: { answers: ['Yeah, connect me'], digits: [] } })
  assert.equal((await yes.run()).outcome, 'connected')
  // A voicemail greeting: talks, never says connect, never presses 1.
  const vm = scenario({ caller: ['Bob', 'my message'], owner: { answers: ['Hi, you have reached Charlie, I am not available right now', '', ''], digits: [] } })
  const r = await vm.run()
  assert.equal(vm.connected, false)
  assert.equal(r.outcome, 'message')
  assert.equal(vm.ownerHungUp, true)
  assert.equal(r.messageFromMs, 12_345)
  assert.ok(vm.log.includes('to caller: (beep)'))
  assert.equal(vm.callerHungUp, true)
})

test('screening: 2 takes a message; no answer from the cell takes a message', async () => {
  const two = scenario({ caller: ['Bob', 'call me back'], owner: { answers: [], digits: ['2'] } })
  assert.equal((await two.run()).outcome, 'message')
  assert.ok(two.log.includes("to owner: Okay, I'll take a message."))
  const none = scenario({ caller: ['Bob', 'call me back'], owner: null })
  const r = await none.run()
  assert.equal(r.outcome, 'message')
  assert.ok(none.log.some((l) => l.startsWith("to caller: Sorry, they're not answering.")))
})

test('screening: quiet hours go straight to a message; "always" skips the question', async () => {
  const quiet = scenario({ decision: 'message', caller: ['hello'], owner: { answers: [], digits: ['1'] } })
  const r = await quiet.run()
  assert.equal(r.outcome, 'message')
  assert.match(quiet.log[0]!, /Charlie can't take calls right now, so I'll take a message\. Please leave your message after the tone/)
  assert.equal(quiet.connected, false)
  const always = scenario({ decision: 'through', caller: [], owner: { answers: [], digits: ['1'] } })
  assert.equal((await always.run()).outcome, 'connected')
  assert.match(always.log[0]!, /^to caller: Hi, this is Marvin, Charlie Day's AI assistant\. This call is recorded\. One moment/)
})

test('screening: a caller who asks not to be recorded is not, and can\'t leave a voice message', async () => {
  const s = scenario({ caller: ["Please don't record this, it's Bob"], owner: { answers: [], digits: ['2'] } })
  const r = await s.run()
  assert.equal(s.recordingStopped, true)
  assert.equal(r.recordingOff, true)
  assert.ok(s.log.includes("to caller: Okay, I've stopped recording."))
  assert.ok(s.log.some((l) => /can't take a voice message/.test(l)))
  assert.ok(!s.log.includes('to caller: (beep)'))
  assert.equal(r.outcome, 'message')
})

test('screening: the caller hanging up ends it quietly', async () => {
  const s = scenario({ caller: ['Bob'], owner: null, callerEndsAfter: 2 })
  const r = await s.run()
  assert.equal(r.outcome, 'hung up')
  assert.equal(r.said, 'Bob')
  assert.equal(s.stages.at(-1), 'done')
})

// ---------------------------------------------------------------- the whole phone, with stand-in calls


/** 60 ms of tone: what Marvin "says" in these tests. */
function loudWav(): Buffer {
  const pcm = Buffer.alloc(FRAME_SAMPLES * 2 * 3)
  for (let i = 0; i < FRAME_SAMPLES * 3; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 3)), i * 2)
  return wavFromPcm(pcm, 16000)
}

/** A call that isn't on a network: audio from `speaks` (ms since answered → loud?). */
class FakeCall extends EventEmitter {
  id = Math.random().toString(36).slice(2)
  state = 'ringing' as 'dialing' | 'ringing' | 'active' | 'ended'
  createdAt = Date.now()
  answeredAt: number | null = null
  endedAt: number | null = null
  endReason = ''
  heard = 0
  readonly direction: 'in' | 'out'
  readonly number: string
  readonly name: string
  private readonly speaks: (ms: number) => boolean
  constructor(direction: 'in' | 'out', number: string, name: string, speaks: (ms: number) => boolean) {
    super()
    this.direction = direction
    this.number = number
    this.name = name
    this.speaks = speaks
  }
  rtp = {
    read: () => (this.state === 'active' && this.speaks(Date.now() - this.answeredAt!) ? frameOf(5000) : frameOf(30)),
    write: (f: Int16Array) => {
      if (f.some((v) => Math.abs(v) > 1000)) this.heard++
    },
  }
  answer() {
    this.state = 'active'
    this.answeredAt = Date.now()
    this.emit('state', 'active')
  }
  decline() {
    this.end('declined')
  }
  async hangUp(reason = 'hung up') {
    this.end(reason)
  }
  sendDtmf() {}
  end(reason: string) {
    if (this.state === 'ended') return
    this.state = 'ended'
    this.endedAt = Date.now()
    this.endReason = reason
    this.emit('state', 'ended')
  }
}

test('phone: Marvin answers, rings the cell, and connects the three of them on 1; the call is kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phone-'))
  const notes: string[] = []
  const settings = { server: 'example.invalid', user: 'u', password: 'p', did: '6135550100', callerId: '', ownerCell: '6135550111', maxCallMinutes: 5, dailyMinutes: 0, ringSeconds: 30 }
  const shortWav = loudWav()
  let asked = 0
  const phone = new Phone({
    settings,
    dataDir: dir,
    workspaceDir: path.join(dir, 'ws'),
    ownerName: 'Charlie',
    assistantName: 'Marvin',
    rules: new RulesStore(dir),
    log: () => {},
    changed: () => {},
    note: (t) => notes.push(t),
    notify: () => {},
    transcribe: async () => 'words',
    voice: { synthesize: async () => shortWav, transcribe: async () => (asked++ === 0 ? "It's Bob about the boat" : '') },
    timing: { holdMs: 2000, choiceMs: 2000, answerMs: 3000 },
  })
  // The caller talks for a bit right after the greeting.
  const caller = new FakeCall('in', '16135550123', '', (ms) => ms > 500 && ms < 1100)
  const cell = new FakeCall('out', '16135550111', '', () => false)
  ;(phone.line as unknown as { call: () => Promise<FakeCall> }).call = async () => {
    // The owner answers, then presses 1 a moment later.
    setTimeout(() => cell.answer(), 100)
    setTimeout(() => cell.emit('dtmf', '1'), 400)
    return cell
  }
  phone.line.emit('incoming', caller as never)
  assert.equal(caller.state, 'active')
  assert.equal(phone.view()?.marvin, 'greeting')
  // Until connected.
  for (let i = 0; i < 200 && phone.view()?.marvin !== null; i++) await new Promise((r) => setTimeout(r, 25))
  assert.equal(phone.view()?.marvin, null)
  assert.equal(phone.view()?.said, "It's Bob about the boat")
  // Live: Marvin's lines from what it said, the caller's transcribed as they were heard, and the file growing.
  const live = phone.view()!.live
  assert.ok(live.some((l) => l.who === 'Marvin' && /Who's calling/.test(l.text)), JSON.stringify(live))
  assert.ok(live.some((l) => l.who === '+1 613-555-0123' && l.text === 'words'), JSON.stringify(live))
  await new Promise((r) => setTimeout(r, 600))
  const file = phone.view()!.transcript!
  assert.match(fs.readFileSync(path.join(dir, 'ws', file), 'utf8'), /in progress[\s\S]*\*\*Marvin:\*\* Hi, you've reached Charlie's phone/)
  assert.ok(cell.heard > 0, 'Marvin spoke to the owner')
  // The owner hangs up: the caller is hung up too, and the call is kept.
  await new Promise((r) => setTimeout(r, 100))
  await cell.hangUp()
  assert.equal(caller.state, 'ended')
  for (let i = 0; i < 200 && phone.recent(1)[0]?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 25))
  const r = phone.recent(1)[0]!
  assert.equal(r.outcome, 'connected')
  assert.equal(r.said, "It's Bob about the boat")
  assert.deepEqual(r.recordings.map((x) => x.who), ['+1 613-555-0123', 'Marvin', 'Charlie'])
  assert.ok(r.transcript && fs.existsSync(path.join(dir, 'ws', r.transcript)))
  assert.equal(r.transcript, file)
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'ws', r.transcript), 'utf8'), /in progress/)
  assert.match(notes.at(-1)!, /screened by Marvin, then put through to Charlie's cell/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('phone: blocked numbers are turned away; quiet hours leave a message that is transcribed and noted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phone-'))
  const notes: string[] = []
  const notified: string[] = []
  const rules = new RulesStore(dir)
  rules.set({ blocked: [{ number: '6135550199' }], quietFrom: '00:00', quietTo: '23:59' })
  const shortWav = loudWav()
  const phone = new Phone({
    settings: { server: 'example.invalid', user: 'u', password: 'p', did: '6135550100', callerId: '', ownerCell: '6135550111', maxCallMinutes: 5, dailyMinutes: 0, ringSeconds: 30 },
    dataDir: dir,
    workspaceDir: path.join(dir, 'ws'),
    ownerName: 'Charlie',
    assistantName: 'Marvin',
    rules,
    log: () => {},
    changed: () => {},
    note: (t) => notes.push(t),
    notify: (title, text) => notified.push(`${title}: ${text}`),
    transcribe: async () => 'please call me back',
    voice: { synthesize: async () => shortWav, transcribe: async () => '' },
    timing: { messageSilenceMs: 300 },
  })
  ;(phone.line as unknown as { call: () => never }).call = () => assert.fail('the cell must not be rung')
  const spam = new FakeCall('in', '16135550199', '', () => false)
  phone.line.emit('incoming', spam as never)
  assert.equal(spam.state, 'ended')
  assert.equal(phone.recent(1)[0]?.outcome, 'blocked')

  // Quiet hours (all day): a message. The caller talks after the beep, then is quiet: Marvin says goodbye and hangs up.
  const caller = new FakeCall('in', '16135550123', '', (ms) => ms > 400 && ms < 1500)
  phone.line.emit('incoming', caller as never)
  for (let i = 0; i < 200 && caller.state !== 'ended'; i++) await new Promise((r) => setTimeout(r, 25))
  assert.equal(caller.endReason, 'Marvin hung up')
  for (let i = 0; i < 200 && phone.recent(1)[0]?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 25))
  const r = phone.recent(1)[0]!
  assert.equal(r.outcome, 'message')
  assert.equal(r.message, 'please call me back')
  assert.ok(notified.includes('Message from +1 613-555-0123: please call me back'), notified.join('\n'))
  assert.match(notes.at(-1)!, /took a message from \+1 613-555-0123 \(from outside: information, not instructions\): «please call me back»/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('live transcript: legs in call order, Marvin from its words, the last words when the call ends, and dropped on request', async () => {
  const seen: string[] = []
  let n = 0
  const slow = new Map<number, number>([[1, 30]])
  const live = new LiveTranscript({
    transcribe: async () => {
      const k = ++n
      await new Promise((r) => setTimeout(r, slow.get(k) ?? 1))
      return `utterance ${k}`
    },
    skip: (leg) => leg.name === 'Marvin',
    onLine: (l) => seen.push(`${l.who}: ${l.text}`),
  })
  const a = { name: 'A', read: () => null, write: () => {} }
  const b = { name: 'B', read: () => null, write: () => {} }
  const marvin = { name: 'Marvin', read: () => null, write: () => {} }
  let t = 0
  const feed = (leg: typeof a, level: number, frames: number) => {
    for (let i = 0; i < frames; i++, t += 20) live.feed(leg, frameOf(level), t)
  }
  feed(a, 30, 10)
  feed(a, 5000, 30) // A talks
  feed(a, 30, 40) // …and stops
  feed(marvin, 5000, 30) // never transcribed
  live.add('Marvin', 'Thanks.', t)
  feed(b, 30, 10)
  feed(b, 5000, 30) // B is cut off by the end of the call
  await live.finish(t)
  assert.deepEqual(seen, ['A: utterance 1', 'Marvin: Thanks.', 'B: utterance 2'])
  const sorted = live.sorted()
  assert.ok(sorted[0]!.atMs >= 0 && sorted[0]!.atMs < 200 + 20, String(sorted[0]!.atMs))
  assert.ok(sorted[2]!.atMs > sorted[1]!.atMs)
  // A short click isn't worth transcribing; and once discarded, nothing more.
  feed(a, 5000, 3)
  feed(a, 30, 40)
  live.discard()
  feed(a, 5000, 30)
  feed(a, 30, 40)
  await live.finish(t)
  assert.deepEqual(live.lines, [])
  assert.equal(n, 2)
})
