import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatTarget } from '../src/assistant/llm.ts'
import type { LoopResult, ToolHost } from '../src/harness/loop.ts'
import { type Busy, type ErrandBrief, errandCall, type ErrandResult } from '../src/phone/errand.ts'
import { readBrief } from '../src/phone/tools.ts'
import type { VoiceLeg } from '../src/phone/voice.ts'

const NOW = new Date('2026-11-16T10:00:00')
const brief: ErrandBrief = {
  number: '16135550123',
  who: "Joe's Garage",
  goal: 'book an oil change for the 2019 Civic',
  share: '2019 Honda Civic',
  windows: [{ from: new Date('2026-11-17T08:00'), to: new Date('2026-11-17T12:00') }],
  minutes: 60,
  title: "Oil change at Joe's Garage",
  voicemail: false,
}

/** A call: what they say, in order ('' = silence); what Marvin says is kept. */
function fakeCall(lines: string[]) {
  const said: string[] = []
  const voice = {
    say: async (text: string) => void said.push(text),
    listen: async () => lines.shift() ?? '',
  } as unknown as VoiceLeg
  return { voice, said }
}

/** The LLM, scripted: each step gets the tools and returns words (and may call tools). */
type Step = (host: ToolHost) => Promise<string>
function scripted(steps: Step[]) {
  const prompts: string[] = []
  const loop = async (_t: ChatTarget, messages: { role: string; content?: unknown }[], host: ToolHost): Promise<LoopResult> => {
    prompts.push(String(messages[0]!.content))
    const step = steps.shift()
    return { text: step ? await step(host) : '', steps: [] }
  }
  return { loop: loop as never, prompts }
}

function run(lines: string[], steps: Step[], opts: { busy?: Busy[] | null; bookFails?: string; brief?: ErrandBrief } = {}) {
  const call = fakeCall(lines)
  const booked: { start: Date; end: Date; notes: string }[] = []
  const reports: ErrandResult[] = []
  let hungUp = false
  const { loop, prompts } = scripted(steps)
  const done = errandCall({
    marvin: call.voice,
    brief: opts.brief ?? brief,
    ownerName: 'Sam',
    callback: '6 1 3, 5 5 5, 0 1 9 9',
    assistantName: 'Marvin',
    recordingNotice: true,
    target: { url: 'http://x', model: 'm' },
    busy: async () => (opts.busy === undefined ? [] : opts.busy),
    book: async (start, end, notes) => {
      if (opts.bookFails) return opts.bookFails
      booked.push({ start, end, notes })
      return null
    },
    dtmf: () => {},
    hangUp: async () => void (hungUp = true),
    report: (r) => void reports.push(r),
    timing: { keyGapMs: 0 },
    loop,
    now: () => NOW,
  })
  return { done, call, booked, reports, prompts, hungUp: () => hungUp }
}

test('a time inside the windows and free: checked, booked, on the calendar; Marvin says it is an AI', async () => {
  const r = run(
    ["Joe's Garage, how can I help?", 'Sure, we have Tuesday at nine.', 'Great, see you then.'],
    [
      async () => 'I\'d like to book an oil change for a 2019 Honda Civic. Do you have anything Tuesday morning?',
      async (h) => {
        assert.match((await h.call('check_time', { start: '2026-11-17T09:00' })).text, /^OK/)
        assert.match((await h.call('book', { start: '2026-11-17T09:00', notes: '$79.99' })).text, /^Booked/)
        return 'Tuesday at nine works. Thank you!'
      },
      async (h) => {
        await h.call('end_call', { outcome: 'booked', summary: 'Booked Tuesday 9:00, $79.99.' })
        return 'Thanks, goodbye.'
      },
    ],
  )
  const result = await r.done
  assert.match(r.call.said[0]!, /Marvin, an AI assistant calling on behalf of Sam\. This call may be recorded\./)
  assert.equal(result.outcome, 'booked')
  assert.equal(result.summary, 'Booked Tuesday 9:00, $79.99.')
  assert.equal(r.booked.length, 1)
  assert.equal(r.booked[0]!.start.getTime(), new Date('2026-11-17T09:00').getTime())
  assert.equal(r.booked[0]!.end.getTime(), new Date('2026-11-17T10:00').getTime())
  assert.match(r.booked[0]!.notes, /Booked by Marvin on a call with Joe's Garage\. \$79\.99/)
  assert.equal(r.call.said.at(-1), 'Thanks, goodbye.')
  assert.ok(r.hungUp())
  // Only what the brief allows is in its instructions.
  assert.match(r.prompts[0]!, /You may tell them only: Sam's name; their callback number, 6 1 3, 5 5 5, 0 1 9 9; and: 2019 Honda Civic/)
})

test('the limits are kept in code: outside the windows, busy, unchecked, calendar unreadable, a second booking', async () => {
  const outcomes: string[] = []
  const r = run(['Hello', 'How about Wednesday?'], [
    async (h) => {
      outcomes.push((await h.call('check_time', { start: '2026-11-18T09:00' })).text) // outside the windows
      outcomes.push((await h.call('book', { start: '2026-11-17T09:30' })).text) // never checked
      outcomes.push((await h.call('check_time', { start: '2026-11-17T11:30' })).text) // ends after the window
      outcomes.push((await h.call('check_time', { start: '2026-11-15T09:00' })).text) // past
      return 'Do you have Tuesday morning?'
    },
    async (h) => {
      await h.call('end_call', { outcome: 'booked', summary: 'Said booked but nothing was.' })
      return 'Goodbye.'
    },
  ])
  const result = await r.done
  assert.match(outcomes[0]!, /outside the times Sam gave/)
  assert.match(outcomes[1]!, /check_time first/)
  assert.match(outcomes[2]!, /outside the times/)
  assert.match(outcomes[3]!, /already passed/)
  assert.equal(r.booked.length, 0)
  assert.equal(result.outcome, 'not done', "'booked' only counts when something was booked")

  const busy = run(['Hi'], [
    async (h) => {
      assert.match((await h.call('check_time', { start: '2026-11-17T09:00' })).text, /Sam has "Dentist" then/)
      return 'Goodbye.'
    },
  ], { busy: [{ start: new Date('2026-11-17T09:30'), end: new Date('2026-11-17T10:30'), title: 'Dentist', allDay: false }] })
  await busy.done

  const blind = run(['Hi'], [
    async (h) => {
      assert.match((await h.call('check_time', { start: '2026-11-17T09:00' })).text, /can't be checked/)
      return 'Goodbye.'
    },
  ], { busy: null })
  await blind.done

  const twice = run(['Hi'], [
    async (h) => {
      await h.call('check_time', { start: '2026-11-17T08:00' })
      await h.call('book', { start: '2026-11-17T08:00' })
      await h.call('check_time', { start: '2026-11-17T10:00' })
      assert.match((await h.call('book', { start: '2026-11-17T10:00' })).text, /only one booking/)
      return 'Goodbye.'
    },
  ])
  await twice.done
  assert.equal(twice.booked.length, 1)
})

test("they stop answering: two hellos, then Marvin hangs up; times they offered outside the windows go to the owner", async () => {
  const r = run(['Hi there', '', '', ''], [async () => 'I\'m calling to book an oil change.'])
  const result = await r.done
  assert.deepEqual(r.call.said.slice(-2), ['Hello? Are you still there?', 'Hello? Are you still there?'])
  assert.equal(result.outcome, 'not done')
  assert.match(result.summary, /stopped answering/)
  assert.ok(r.hungUp())

  const owner = run(['Hi', 'Only Thursday afternoon.'], [
    async () => 'Do you have Tuesday morning?',
    async (h) => {
      await h.call('end_call', { outcome: 'needs owner', summary: 'They only have Thursday afternoon.' })
      return "I'll check with Sam and we'll call back. Thank you, goodbye."
    },
  ])
  const o = await owner.done
  assert.equal(o.outcome, 'needs owner')
  assert.equal(o.summary, 'They only have Thursday afternoon.')
})

test('voicemail: no message is left', async () => {
  const r = run(['Please leave a message after the tone.'], [
    async (h) => {
      await h.call('end_call', { outcome: 'voicemail', summary: 'Got their voicemail.' })
      return 'Hi, this is Marvin…'
    },
  ])
  const result = await r.done
  assert.equal(result.outcome, 'voicemail')
  assert.equal(r.call.said.length, 0, 'a booking call says nothing to a machine')
})

test('the brief is checked before anything is dialled', () => {
  const ok = readBrief({ number: '613-555-0123', who: "Joe's", goal: 'oil change', title: 'Oil change', windows: [{ from: '2026-11-17T08:00', to: '2026-11-17T12:00' }] }, NOW)
  assert.equal(ok.number, '16135550123')
  assert.equal(ok.minutes, 60)
  const bad = (args: Record<string, unknown>, says: RegExp) => assert.throws(() => readBrief({ number: '613-555-0123', who: "Joe's", goal: 'x', title: 't', windows: [{ from: '2026-11-17T08:00', to: '2026-11-17T12:00' }], ...args }, NOW), says)
  bad({ windows: [{ from: '2026-11-17T12:00', to: '2026-11-17T08:00' }] }, /after/)
  bad({ windows: [{ from: '2026-11-01T08:00', to: '2026-11-01T12:00' }] }, /past/)
  bad({ windows: [{ from: '2027-06-01T08:00', to: '2027-06-01T12:00' }] }, /days away/)
  bad({ minutes: 2 }, /minutes/)
  bad({ goal: '' }, /goal/)
  bad({ number: '911' }, /./)
})

test("what's said: the words after the last action, without a stray </think>", async () => {
  const { spokenPart } = await import('../src/phone/errand.ts')
  const steps = [{ role: 'assistant' as const, content: 'Let me check that.', tool_calls: [{ id: '1', type: 'function' as const, function: { name: 'check_time', arguments: '{}' } }] }]
  assert.equal(spokenPart({ text: 'Let me check that. Tuesday at ten works.', steps }), 'Tuesday at ten works.')
  assert.equal(spokenPart({ text: 'thinking about it </think> Tuesday works.', steps: [] }), 'Tuesday works.')
  assert.equal(spokenPart({ text: 'Let me check that.', steps }), 'Let me check that.')
})

const message: ErrandBrief = { number: '16135550188', who: 'Maria', goal: "tell her Sam will be about 30 minutes late, he's stuck in traffic", share: '', windows: [], minutes: 60, title: '', voicemail: true }

test('a message for someone: no calendar actions, passed on, their reply goes to the owner', async () => {
  let tools: string[] = []
  const r = run(['Hello?', 'Oh, okay. Tell him to drive safe.', 'Bye.'], [
    async (h) => {
      tools = h.tools().map((t) => t.function.name)
      assert.match((await h.call('book', { start: '2026-11-17T09:00' })).text, /not for a booking/)
      return "Hi Maria, Sam asked me to let you know he'll be about 30 minutes late. He's stuck in traffic."
    },
    async (h) => {
      await h.call('end_call', { outcome: 'done', summary: 'Maria got the message; she says drive safe.' })
      return "I'll tell him. Bye!"
    },
  ], { brief: message })
  const result = await r.done
  assert.deepEqual(tools, ['press_keys', 'wait_on_hold', 'end_call'])
  assert.equal(result.outcome, 'done')
  assert.equal(result.summary, 'Maria got the message; she says drive safe.')
  assert.equal(r.booked.length, 0)
  assert.match(r.prompts[0]!, /Get straight to it/)
  assert.doesNotMatch(r.prompts[0]!, /check_time/)
})

test('voicemail: a message for a person is left; a booking call hangs up', async () => {
  const r = run(['You have reached Maria. Leave a message after the tone.'], [
    async (h) => {
      await h.call('end_call', { outcome: 'voicemail', summary: 'Left a voicemail.' })
      return "Hi Maria, this is Marvin for Sam: he'll be about 30 minutes late. Bye."
    },
  ], { brief: message })
  const result = await r.done
  assert.equal(result.outcome, 'voicemail')
  assert.match(r.call.said.at(-1)!, /30 minutes late/)
  assert.match(r.prompts[0]!, /leave a short message after the tone/)
})

test('a brief without windows is a message or a question: voicemail on, no title needed', () => {
  const b = readBrief({ number: '613-555-0188', who: 'Maria', goal: "tell her I'll be late" }, NOW)
  assert.deepEqual(b.windows, [])
  assert.equal(b.voicemail, true)
  assert.equal(readBrief({ number: '613-555-0188', who: 'Maria', goal: 'x', voicemail: false }, NOW).voicemail, false)
  assert.throws(() => readBrief({ number: '613-555-0123', who: "Joe's", goal: 'book', windows: [{ from: '2026-11-17T08:00', to: '2026-11-17T12:00' }] }, NOW), /title/)
})

test("an answering machine is known in code: the message is left and the call ends; a booking call hangs up at once", async () => {
  const left = run(["Hi, you've reached Maria. Leave a message after the beep."], [async () => "Sam asked me to let you know he'll be 30 minutes late. Bye."], { brief: message })
  const r1 = await left.done
  assert.equal(r1.outcome, 'voicemail')
  assert.match(r1.summary, /Left a voicemail: «Sam asked me/)
  assert.ok(!left.call.said.some((x) => /still there/.test(x)))

  const booking = run(['Please leave a message after the tone.'], [async () => 'should not be said'])
  const r2 = await booking.done
  assert.equal(r2.outcome, 'voicemail')
  assert.equal(booking.call.said.length, 0, 'nothing said to the machine')
  assert.ok(booking.hungUp())
})

test("a person who says they're unavailable is not taken for an answering machine", async () => {
  const r = run(["Joe's Garage. I'm sorry, the manager is not available right now. Can I take a message?"], [
    async () => 'Hi, I wanted to book an oil change. Could you take that?',
    async (h) => {
      await h.call('end_call', { outcome: 'not done', summary: 'The manager was unavailable; they took the request.' })
      return 'Thank you, goodbye.'
    },
  ])
  const result = await r.done
  assert.notEqual(result.outcome, 'voicemail')
  assert.ok(r.call.said.length >= 2, 'Marvin talked to them')
})
