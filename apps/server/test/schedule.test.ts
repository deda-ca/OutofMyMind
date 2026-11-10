import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { detectAlarmCommand } from '../src/assistant/assistant.ts'
import { classify } from '../src/harness/crud.ts'
import { Notifier } from '../src/schedule/notifier.ts'
import { Scheduler, type RunOutcome, type RunRequest } from '../src/schedule/scheduler.ts'
import { describeRepeat, describeTime, nextAfter, parseDuration, parseTime, parseWhen } from '../src/schedule/when.ts'

// Monday 9 November 2026, 20:15 local.
const MON = new Date(2026, 10, 9, 20, 15)
const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

test('durations and times', () => {
  assert.equal(parseDuration('10m'), 600_000)
  assert.equal(parseDuration('1h30m'), 90 * 60_000)
  assert.equal(parseDuration('1 hour and 30 minutes'), 90 * 60_000)
  assert.equal(parseDuration('90 seconds'), 90_000)
  assert.equal(parseDuration('an hour'), 3_600_000)
  assert.equal(parseDuration('half an hour'), 1_800_000)
  assert.equal(parseDuration('1:30'), 90 * 60_000)
  assert.equal(parseDuration('in 2 hours'), 7_200_000)
  assert.throws(() => parseDuration('soonish'))
  assert.deepEqual(parseTime('06:45'), [6, 45])
  assert.deepEqual(parseTime('7am'), [7, 0])
  assert.deepEqual(parseTime('6:30 p.m.'), [18, 30])
  assert.deepEqual(parseTime('12am'), [0, 0])
  assert.deepEqual(parseTime('noon'), [12, 0])
  assert.throws(() => parseTime('25:00'))
})

test('when: in, at, tomorrow, weekdays, every', () => {
  assert.equal(local(parseWhen({ in: '10m' }, MON).start), '2026-11-09 20:25')
  // 7:00 has passed today: tomorrow.
  assert.equal(local(parseWhen({ time: '07:00' }, MON).start), '2026-11-10 07:00')
  assert.equal(local(parseWhen({ time: '21:00' }, MON).start), '2026-11-09 21:00')
  assert.equal(local(parseWhen({ time: '9am', date: 'friday' }, MON).start), '2026-11-13 09:00')
  assert.throws(() => parseWhen({ time: '07:00', date: '2026-11-09' }, MON), /already passed/)
  const wake = parseWhen({ time: '06:45', repeat: 'weekdays' }, MON)
  assert.equal(local(wake.start), '2026-11-10 06:45')
  assert.equal(describeRepeat(wake.repeat!, wake.start), 'every weekday at 06:45')
  // Friday's 06:45 → next is Monday.
  assert.equal(local(nextAfter(wake.start, wake.repeat, new Date(2026, 10, 13, 7, 0))!), '2026-11-16 06:45')
  const bins = parseWhen({ time: '19:00', days: ['tue', 'thu'] }, MON)
  assert.equal(local(bins.start), '2026-11-10 19:00')
  assert.equal(local(nextAfter(bins.start, bins.repeat, bins.start)!), '2026-11-12 19:00')
  assert.equal(describeRepeat(bins.repeat!, bins.start), 'every Tuesday and Thursday at 19:00')
  const water = parseWhen({ every: '2h' }, MON)
  assert.equal(local(water.start), '2026-11-09 22:15')
  assert.equal(local(nextAfter(water.start, water.repeat, water.start)!), '2026-11-10 00:15')
  const rent = parseWhen({ time: '09:00', date: '2026-12-31', repeat: 'monthly' }, MON)
  // Months without a 31st are skipped.
  assert.equal(local(nextAfter(rent.start, rent.repeat, rent.start)!), '2027-01-31 09:00')
  assert.equal(local(nextAfter(rent.start, rent.repeat, new Date(2027, 0, 31, 10))!), '2027-03-31 09:00')
  assert.equal(describeTime(new Date(2026, 10, 10, 6, 45), MON), 'tomorrow at 06:45')
  assert.throws(() => parseWhen({}, MON), /Say when/)
})

test('repeats keep their wall-clock time across a DST change', () => {
  const start = new Date(2026, 2, 6, 7, 0) // early March, before most DST changes
  const later = nextAfter(start, { every: 'day' }, new Date(2026, 3, 1, 8, 0))!
  assert.equal(later.getHours(), 7)
  assert.equal(later.getMinutes(), 0)
})

test('voice commands for what is ringing', () => {
  assert.deepEqual(detectAlarmCommand('Stop.'), { action: 'dismiss', minutes: 0 })
  assert.deepEqual(detectAlarmCommand('Jarvis, stop the alarm'), { action: 'dismiss', minutes: 0 })
  assert.deepEqual(detectAlarmCommand("I'm up"), { action: 'dismiss', minutes: 0 })
  assert.deepEqual(detectAlarmCommand('snooze'), { action: 'snooze', minutes: 9 })
  assert.deepEqual(detectAlarmCommand('Snooze for five minutes'), { action: 'snooze', minutes: 5 })
  assert.deepEqual(detectAlarmCommand('snooze it for 10 more minutes please'), { action: 'snooze', minutes: 10 })
  assert.equal(detectAlarmCommand('stop telling me about the weather and add milk'), null)
})

test('sending a message is "create"', () => {
  assert.deepEqual(classify({ name: 'send_message' }).kinds, ['create'])
  assert.deepEqual(classify({ name: 'notify_owner' }).kinds, ['create'])
  assert.deepEqual(classify({ name: 'read_text_file' }).kinds, ['read'])
})

function setup(run: (r: RunRequest) => Promise<RunOutcome>, now: () => Date = () => new Date()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'))
  const notifier = new Notifier(null)
  const events: unknown[] = []
  const disconnect = notifier.connect('test', (e) => events.push(e))
  const notes: string[] = []
  const scheduler = new Scheduler(path.join(dir, 'schedules.json'), { notifier, run, now, log: () => {}, record: (note) => notes.push(note) })
  return { dir, notifier, scheduler, events, notes, disconnect }
}

const said = (events: unknown[]) => events.flatMap((e) => ((e as { type: string }).type === 'notify' ? [(e as { notification: { text: string; ring: boolean } }).notification] : []))
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('a timer rings at once, then the LLM speaks; its reply is the notification', async () => {
  const runs: RunRequest[] = []
  const t = setup(async (r) => {
    runs.push(r)
    return { text: 'Your pasta is ready, sir.', notified: false, sent: false, tools: [] }
  })
  t.scheduler.start()
  const s = t.scheduler.create({ title: 'Pasta', kind: 'timer', in: '1s', prompt: 'Tell the owner the pasta is ready.' })
  assert.equal(s.message, 'The Pasta timer is done.')
  await wait(1400)
  await t.scheduler.idle()
  const out = said(t.events)
  assert.equal(out.length, 2)
  assert.deepEqual([out[0]!.text, out[0]!.ring], ['The Pasta timer is done.', true])
  assert.deepEqual([out[1]!.text, out[1]!.ring], ['Your pasta is ready, sir.', false])
  assert.equal(runs[0]!.reason, 'due')
  assert.equal(t.scheduler.get(s.id)!.next, null)
  assert.equal(t.scheduler.get(s.id)!.last!.result, 'delivered')
  assert.match(t.notes[0]!, /The timer "Pasta" went off/)
  // Saved to the file.
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'schedules.json'), 'utf8')).schedules[0].id, 'pasta')
  t.scheduler.stop()
})

test('a reminder falls back to its message when the LLM fails', async () => {
  const t = setup(async () => {
    throw new Error('llama-server is down')
  })
  t.scheduler.start()
  t.scheduler.create({ title: 'Bins', kind: 'reminder', in: '1s', prompt: 'Remind the owner about the bins.' })
  await wait(1400)
  await t.scheduler.idle()
  assert.deepEqual(said(t.events).map((n) => n.text), ['Reminder: Bins.'])
  assert.equal(t.scheduler.get('bins')!.last!.result, 'failed')
  t.scheduler.stop()
})

test('a message sent another way (e.g. Telegram) is not also put on screen', async () => {
  const t = setup(async () => ({ text: "I've sent it by Telegram.", notified: false, sent: true, tools: [{ name: 'telegram__send_message', args: '{}', result: 'ok' }] }))
  t.scheduler.start()
  t.scheduler.create({ title: 'Timesheet', kind: 'reminder', in: '1s', prompt: 'Send the owner a Telegram message: submit the timesheet.' })
  await wait(1400)
  await t.scheduler.idle()
  assert.deepEqual(said(t.events), [])
  assert.equal(t.scheduler.get('timesheet')!.last!.result, 'delivered')
  t.scheduler.stop()
})

test('snoozing a ringing alarm makes it go off again; a repeat moves to its next time', async () => {
  let clock = new Date(2026, 10, 10, 6, 44, 59, 500)
  const t = setup(async () => ({ text: '', notified: false, sent: false, tools: [] }), () => clock)
  t.scheduler.start()
  const s = t.scheduler.create({ title: 'Wake-up', kind: 'alarm', time: '06:45', repeat: 'weekdays' })
  assert.equal(local(new Date(s.next!)), '2026-11-10 06:45')
  clock = new Date(2026, 10, 10, 6, 45, 0, 100)
  await wait(700)
  await t.scheduler.idle()
  assert.equal(t.notifier.ringing().length, 1)
  assert.equal(local(new Date(t.scheduler.get(s.id)!.next!)), '2026-11-11 06:45')
  t.notifier.ack(null, 'snooze', 5)
  assert.equal(t.notifier.ringing().length, 0)
  assert.equal(local(new Date(t.scheduler.get(s.id)!.snoozedUntil!)), '2026-11-10 06:50')
  t.scheduler.stop()
})

test('missed while off: a one-off goes off late, an old repeat waits for its next time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'))
  const file = path.join(dir, 'schedules.json')
  const hourAgo = new Date(Date.now() - 3600_000).toISOString()
  fs.writeFileSync(file, JSON.stringify({ schedules: [
    { id: 'call-mum', title: 'Call mum', kind: 'reminder', message: 'Call mum.', start: hourAgo },
    { id: 'standup', title: 'Stand-up', kind: 'reminder', message: 'Stand-up.', start: new Date(Date.now() - 2 * 86_400_000 - 3600_000).toISOString(), repeat: { every: 'day' }, next: hourAgo },
  ] }))
  const notifier = new Notifier(null)
  const events: unknown[] = []
  notifier.connect('test', (e) => events.push(e))
  const scheduler = new Scheduler(file, { notifier, run: async () => ({ text: '', notified: false, sent: false, tools: [] }), log: () => {} })
  scheduler.start()
  await wait(100)
  await scheduler.idle()
  assert.deepEqual(said(events).map((n) => n.text), ['Call mum.'])
  assert.equal(scheduler.get('standup')!.last!.result, 'skipped')
  assert.ok(new Date(scheduler.get('standup')!.next!) > new Date())
  scheduler.stop()
})

test('notifications wait for a screen, and are delivered when one connects', () => {
  const notifier = new Notifier(null)
  notifier.notify({ title: 'Bins', text: 'Take the bins out.', urgency: 'reminder' })
  assert.match(notifier.describePresence(), /No Jarvis screen is open/)
  const events: { type: string; notification?: { text: string; late?: boolean } }[] = []
  notifier.connect('kitchen', (e) => events.push(e as never))
  assert.equal(events[0]!.notification!.text, 'Take the bins out.')
  assert.equal(events[0]!.notification!.late, true)
  assert.match(notifier.describePresence(), /1 Jarvis screen open \(kitchen\)/)
  notifier.close()
})

test('an unanswered alarm is followed up once, without the screen tool', async () => {
  const reasons: string[] = []
  const t = setup(async (r) => {
    reasons.push(r.reason)
    // The follow-up rings again (what Qwen did before the fix): must not start a loop.
    if (r.reason === 'unacknowledged') t.notifier.notify({ title: 'Eggs', text: 'again', ring: true, scheduleId: r.schedule.id })
    return { text: '', notified: false, sent: false, tools: [] }
  })
  t.scheduler.start()
  t.scheduler.create({ title: 'Eggs', kind: 'timer', in: '1s' })
  await wait(1300)
  const ringing = t.notifier.ringing()
  assert.equal(ringing.length, 1)
  t.notifier.emit('unacknowledged', ringing[0]!)
  await t.scheduler.idle()
  t.notifier.emit('unacknowledged', t.notifier.ringing().at(-1)!)
  await t.scheduler.idle()
  assert.deepEqual(reasons, ['unacknowledged'])
  t.scheduler.stop()
  t.notifier.close()
})

test('follow-up runs get presence and the list, not jarvis__notify', async () => {
  const { scheduleTools } = await import('../src/schedule/tools.ts')
  const t = setup(async () => ({ text: '', notified: false, sent: false, tools: [] }))
  const names = (followUp: boolean) => scheduleTools({ scheduler: t.scheduler, notifier: t.notifier, kindOn: () => true, unattended: { scheduleId: 'x', followUp } }).map((b) => b.tool.function.name)
  assert.deepEqual(names(false), ['jarvis__notify', 'jarvis__presence', 'jarvis__list_schedules'])
  assert.deepEqual(names(true), ['jarvis__presence', 'jarvis__list_schedules'])
})
