// Timers, alarms, reminders and scheduled tasks: when each goes off, and
// what the LLM is told to do then. Kept in WORKSPACE_DIR/schedules.json
// (readable, editable by hand; changes are picked up).
//
// When one goes off:
//   - alarms and timers ring on screen at once, with their message (no LLM);
//   - then, if it has a prompt, the LLM runs it (run.ts) with its tools: it
//     decides what to say and how to reach the owner (the screen, or any
//     messaging tool a plugin offers);
//   - if that fails, takes too long or reaches nobody, the fixed message is
//     put on screen instead, so a reminder is never lost to a broken model.
// Missed while the server was off: a one-off goes off late (marked so); a
// repeat goes off once if it's within GRACE_MS, otherwise it waits for its
// next time.
// A ringing alarm nobody answers for 2 minutes wakes the LLM again, to try
// another way to reach the owner.

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { Notification, Notifier } from './notifier.ts'
import { describeIn, describeRepeat, describeTime, nextAfter, parseWhen, WhenError, type Repeat, type WhenInput } from './when.ts'

export type ScheduleKind = 'timer' | 'alarm' | 'reminder' | 'task'
export const KINDS: ScheduleKind[] = ['timer', 'alarm', 'reminder', 'task']

export interface Schedule {
  id: string
  title: string
  kind: ScheduleKind
  /** What the LLM is told to do when it goes off ('' = just the message). */
  prompt: string
  /** Said and shown as it is: at once for alarms and timers, and whenever the LLM can't. */
  message: string
  /** The first time (ISO). */
  start: string
  repeat?: Repeat
  /** Unattended runs can't change or delete the owner's things unless this is on. */
  allowChanges?: boolean
  enabled: boolean
  created: string
  /** The next time it goes off (ISO), or null when it's done. */
  next: string | null
  /** Snoozed: goes off again then (before `next`). */
  snoozedUntil?: string | null
  last?: { at: string; result: 'delivered' | 'fallback' | 'failed' | 'skipped'; note?: string }
}

/** What the LLM made of it (run.ts). */
export interface RunOutcome {
  /** Its reply. */
  text: string
  /** It used jarvis__notify. */
  notified: boolean
  /** It sent something through another tool (a messaging plugin). */
  sent: boolean
  /** The tools it used, for the session. */
  tools: { name: string; args: string; result: string }[]
}

export interface RunRequest {
  schedule: Schedule
  reason: 'due' | 'unacknowledged'
  /** When it was due. */
  dueAt: Date
  /** Went off well after it was due (the server was off). */
  late: boolean
  /** The notification ringing for it, if any. */
  ringing?: Notification
  signal: AbortSignal
}

export interface SchedulerOptions {
  notifier: Notifier
  /** Runs the LLM for a schedule. */
  run: (request: RunRequest) => Promise<RunOutcome>
  /** Adds what happened to the active session (so "snooze it" or "what did it say?" make sense). */
  record?: (note: string, outcome: RunOutcome | null) => void
  log?: (message: string, err?: unknown) => void
  now?: () => Date
}

export class ScheduleError extends Error {}

/** A repeat missed by more than this (the server was off) waits for its next time. */
const GRACE_MS = 30 * 60_000
/** The LLM gets this long; then the message goes on screen instead. */
const RUN_TIMEOUT_MS = 45_000
/** Done one-offs are kept this long (to show), then removed. */
const KEEP_DONE_MS = 24 * 3600_000
/** A schedule is followed up (unanswered alarm) at most this often, so its own notifications can't start a loop. */
const FOLLOW_UP_GAP_MS = 15 * 60_000
/** Never sleep longer than this (clock changes, sleep/resume). */
const MAX_SLEEP_MS = 30_000

export interface ScheduleInput extends WhenInput {
  title: string
  kind?: ScheduleKind
  prompt?: string
  message?: string
  allowChanges?: boolean
}

export class Scheduler extends EventEmitter<{ change: [] }> {
  private schedules: Schedule[] = []
  private timer?: ReturnType<typeof setTimeout>
  private queue: Promise<void> = Promise.resolve()
  private running = new Set<string>()
  /** When each schedule was last followed up (an alarm nobody stopped): at most once per FOLLOW_UP_GAP_MS. */
  private followedUp = new Map<string, number>()
  private lastWritten = 0
  private stopped = false
  private readonly file: string
  private readonly o: SchedulerOptions
  private readonly now: () => Date
  private readonly log: (message: string, err?: unknown) => void

  constructor(file: string, options: SchedulerOptions) {
    super()
    this.file = file
    this.o = options
    this.now = options.now ?? (() => new Date())
    this.log = options.log ?? ((m, e) => (e ? console.warn(m, e) : console.log(m)))
    options.notifier.on('ack', (n, action, minutes) => {
      if (action === 'snooze') this.snoozeNotification(n, minutes)
    })
    options.notifier.on('unacknowledged', (n) => this.unacknowledged(n))
  }

  /** Reads the file and starts the clock (catching up on anything missed). */
  start(): void {
    this.load()
    this.stopped = false
    // Edited by hand (or by the files plugin): picked up.
    fs.watchFile(this.file, { interval: 2000 }, (cur) => {
      if (cur.mtimeMs && Math.abs(cur.mtimeMs - this.lastWritten) > 5) {
        this.load()
        this.changed(false)
      }
    })
    this.tick()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    fs.unwatchFile(this.file)
  }

  /** Waits for runs in progress (tests). */
  idle(): Promise<void> {
    return this.queue
  }

  list(): Schedule[] {
    return [...this.schedules].sort((a, b) => (dueOf(a)?.getTime() ?? Infinity) - (dueOf(b)?.getTime() ?? Infinity))
  }

  get(id: string): Schedule | undefined {
    return this.schedules.find((s) => s.id === id)
  }

  /** By id, or by title (exact, then partial), for the LLM ("cancel the pasta timer"). */
  find(query: string): Schedule[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const byId = this.schedules.filter((s) => s.id === q)
    if (byId.length) return byId
    const exact = this.schedules.filter((s) => s.title.toLowerCase() === q)
    if (exact.length) return exact
    const words = q.replace(/\b(the|my|a|an|timer|alarm|reminder|schedule)\b/g, ' ').trim()
    return this.schedules.filter((s) => s.title.toLowerCase().includes(q) || (words && s.title.toLowerCase().includes(words)))
  }

  create(input: ScheduleInput): Schedule {
    const title = input.title?.trim()
    if (!title) throw new ScheduleError('Give it a title (e.g. "Pasta" or "Wake-up").')
    const kind = input.kind && KINDS.includes(input.kind) ? input.kind : input.in && !input.repeat && !input.every ? 'timer' : 'reminder'
    let when
    try {
      when = parseWhen(input, this.now())
    } catch (err) {
      throw new ScheduleError(err instanceof WhenError ? err.message : String(err))
    }
    const prompt = input.prompt?.trim() ?? ''
    const s: Schedule = {
      id: this.newId(title),
      title: title.slice(0, 80),
      kind,
      prompt: prompt.slice(0, 2000),
      message: (input.message?.trim() || defaultMessage(kind, title)).slice(0, 300),
      start: when.start.toISOString(),
      ...(when.repeat ? { repeat: when.repeat } : {}),
      ...(input.allowChanges ? { allowChanges: true } : {}),
      enabled: true,
      created: this.now().toISOString(),
      next: when.start.toISOString(),
    }
    this.schedules.push(s)
    this.changed()
    return s
  }

  /** Changes a schedule (the Schedule tab): title, prompt, message, kind, enabled, allowChanges, or a new time. */
  update(id: string, patch: Partial<ScheduleInput> & { enabled?: boolean }): Schedule {
    const s = this.get(id)
    if (!s) throw new ScheduleError(`There is no schedule "${id}".`)
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new ScheduleError('The title can\'t be empty.')
      s.title = patch.title.trim().slice(0, 80)
    }
    if (patch.kind !== undefined) {
      if (!KINDS.includes(patch.kind)) throw new ScheduleError(`The kind is one of ${KINDS.join(', ')}.`)
      s.kind = patch.kind
    }
    if (patch.prompt !== undefined) s.prompt = patch.prompt.trim().slice(0, 2000)
    if (patch.message !== undefined) s.message = patch.message.trim().slice(0, 300) || defaultMessage(s.kind, s.title)
    if (patch.allowChanges !== undefined) s.allowChanges = patch.allowChanges || undefined
    if (patch.in || patch.time || patch.every || patch.repeat !== undefined || patch.days) {
      try {
        const when = parseWhen(patch, this.now())
        s.start = when.start.toISOString()
        if (when.repeat) s.repeat = when.repeat
        else delete s.repeat
        s.next = s.start
        s.snoozedUntil = null
      } catch (err) {
        throw new ScheduleError(err instanceof WhenError ? err.message : String(err))
      }
    }
    if (patch.enabled !== undefined) {
      s.enabled = patch.enabled
      // Switched back on: from now on (not everything it missed while off).
      if (s.enabled && s.repeat) s.next = nextAfter(new Date(s.start), s.repeat, this.now())?.toISOString() ?? null
    }
    this.changed()
    return s
  }

  /** Removes it. */
  remove(id: string): Schedule {
    const s = this.get(id)
    if (!s) throw new ScheduleError(`There is no schedule "${id}".`)
    this.schedules = this.schedules.filter((x) => x !== s)
    this.changed()
    return s
  }

  /** A repeat skips its next time (and goes on after). */
  skipNext(id: string): Schedule {
    const s = this.get(id)
    if (!s) throw new ScheduleError(`There is no schedule "${id}".`)
    if (!s.repeat || !s.next) throw new ScheduleError(`"${s.title}" doesn't repeat; cancel it instead.`)
    s.next = nextAfter(new Date(s.start), s.repeat, new Date(s.next))?.toISOString() ?? null
    this.changed()
    return s
  }

  /** Goes off now, as if it were due (the Schedule tab's "Run now"). */
  runNow(id: string): void {
    const s = this.get(id)
    if (!s) throw new ScheduleError(`There is no schedule "${id}".`)
    this.enqueue(s, this.now(), false, { manual: true })
  }

  /** In words, for the LLM and the Schedule tab. */
  describe(s: Schedule): string {
    const now = this.now()
    const due = dueOf(s)
    const when = !s.enabled
      ? 'paused'
      : !due
        ? 'done'
        : `${describeTime(due, now)} (${describeIn(due.getTime() - now.getTime())})${s.snoozedUntil ? ', snoozed' : ''}`
    const repeat = s.repeat ? `, ${describeRepeat(s.repeat, new Date(s.start))}` : ''
    return `${s.kind} "${s.title}" [${s.id}]: ${when}${repeat}`
  }

  // ------------------------------------------------------------------ the clock

  private tick(): void {
    clearTimeout(this.timer)
    if (this.stopped) return
    const now = this.now()
    let soonest = Infinity
    for (const s of this.schedules) {
      if (!s.enabled || this.running.has(s.id)) continue
      const due = dueOf(s)
      if (!due) continue
      if (due.getTime() <= now.getTime() + 250) this.fire(s, due, now)
      else soonest = Math.min(soonest, due.getTime() - now.getTime())
    }
    this.prune(now)
    this.timer = setTimeout(() => this.tick(), Math.max(50, Math.min(soonest, MAX_SLEEP_MS)))
    this.timer.unref?.()
  }

  private fire(s: Schedule, due: Date, now: Date): void {
    const lateBy = now.getTime() - due.getTime()
    const snoozed = !!s.snoozedUntil && new Date(s.snoozedUntil).getTime() <= due.getTime() + 1
    // Move it on first, so a crash in the run can't make it go off again and again.
    if (snoozed) s.snoozedUntil = null
    else s.next = s.repeat ? (nextAfter(new Date(s.start), s.repeat, new Date(Math.max(due.getTime(), now.getTime())))?.toISOString() ?? null) : null
    if (s.repeat && !snoozed && lateBy > GRACE_MS) {
      s.last = { at: now.toISOString(), result: 'skipped', note: `missed at ${describeTime(due, now)} (Jarvis was off)` }
      this.changed()
      return
    }
    this.changed()
    this.enqueue(s, due, lateBy > 60_000)
  }

  private enqueue(s: Schedule, due: Date, late: boolean, extra: { manual?: boolean } = {}): void {
    this.running.add(s.id)
    // Ringing starts at once; the LLM's part waits its turn (one run at a time).
    const ringing = s.kind === 'alarm' || s.kind === 'timer' ? this.o.notifier.notify({ title: s.title, text: s.message, urgency: 'alarm', ring: true, scheduleId: s.id }).notification : undefined
    this.queue = this.queue
      .then(() => this.deliver(s, due, late, ringing, extra.manual ?? false))
      .catch((err: unknown) => this.log(`scheduler: "${s.title}" failed`, err))
      .finally(() => {
        this.running.delete(s.id)
        this.tick()
      })
  }

  private async deliver(s: Schedule, due: Date, late: boolean, ringing: Notification | undefined, manual: boolean): Promise<void> {
    const now = this.now()
    const what = `The ${s.kind} "${s.title}" went off${manual ? ' (run by hand)' : ''}${late ? `, late: it was due ${describeTime(due, now)}, while Jarvis was off` : ''}.`
    if (!s.prompt) {
      if (!ringing) this.o.notifier.notify({ title: s.title, text: s.message, urgency: 'reminder', scheduleId: s.id })
      this.finish(s, 'delivered', what, null)
      return
    }
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS)
    let outcome: RunOutcome | null = null
    try {
      outcome = await this.o.run({ schedule: s, reason: 'due', dueAt: due, late, ringing, signal: abort.signal })
    } catch (err) {
      this.log(`scheduler: the LLM couldn't run "${s.title}": ${(err as Error).message}`)
    } finally {
      clearTimeout(timeout)
    }
    const reply = outcome?.text.trim() ?? ''
    if (outcome && !outcome.notified && !outcome.sent && reply) {
      // Its reply is what the owner hears.
      this.o.notifier.notify({ title: s.title, text: reply, urgency: ringing ? 'info' : 'reminder', scheduleId: s.id })
    }
    const reached = !!outcome && (outcome.notified || outcome.sent || !!reply)
    if (!reached && !ringing) this.o.notifier.notify({ title: s.title, text: s.message, urgency: 'reminder', scheduleId: s.id })
    this.finish(s, reached ? 'delivered' : outcome ? 'fallback' : 'failed', what, outcome)
  }

  private finish(s: Schedule, result: NonNullable<Schedule['last']>['result'], what: string, outcome: RunOutcome | null): void {
    s.last = { at: this.now().toISOString(), result, ...(result === 'delivered' ? {} : { note: result === 'failed' ? 'the LLM failed; the message was shown instead' : 'the LLM reached nobody; the message was shown instead' }) }
    if (this.get(s.id)) this.changed()
    try {
      this.o.record?.(`${what} ${s.prompt ? `Its instructions: ${s.prompt}` : `Its message: ${s.message}`}`, outcome)
    } catch (err) {
      this.log('scheduler: could not add it to the session', err)
    }
  }

  /** Snoozed on screen, by voice or by the LLM: the schedule goes off again (an ad hoc alarm becomes a one-off timer). */
  private snoozeNotification(n: Notification, minutes: number): void {
    const mins = Math.min(Math.max(1, Math.round(minutes)), 24 * 60)
    const at = new Date(this.now().getTime() + mins * 60_000).toISOString()
    const s = n.scheduleId ? this.get(n.scheduleId) : undefined
    if (s) {
      s.snoozedUntil = at
      this.changed()
      return
    }
    this.create({ title: n.title, kind: 'alarm', message: n.text, in: `${mins}m` })
  }

  private unacknowledged(n: Notification): void {
    const s = n.scheduleId ? this.get(n.scheduleId) : undefined
    if (!s) return
    const last = this.followedUp.get(s.id) ?? 0
    if (this.now().getTime() - last < FOLLOW_UP_GAP_MS) return
    this.followedUp.set(s.id, this.now().getTime())
    this.queue = this.queue
      .then(async () => {
        const abort = new AbortController()
        const timeout = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS)
        try {
          const outcome = await this.o.run({ schedule: s, reason: 'unacknowledged', dueAt: new Date(n.at), late: false, ringing: n, signal: abort.signal })
          this.o.record?.(`The ${s.kind} "${s.title}" rang for 2 minutes without being dismissed.`, outcome)
        } finally {
          clearTimeout(timeout)
        }
      })
      .catch((err: unknown) => this.log(`scheduler: follow-up for "${s.title}" failed`, err))
  }

  // ------------------------------------------------------------------ the file

  private prune(now: Date): void {
    const before = this.schedules.length
    this.schedules = this.schedules.filter((s) => s.repeat || s.next || s.snoozedUntil || this.running.has(s.id) || now.getTime() - new Date(s.last?.at ?? s.created).getTime() < KEEP_DONE_MS)
    if (this.schedules.length !== before) this.changed()
  }

  private newId(title: string): string {
    const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'schedule'
    if (!this.get(base)) return base
    for (let i = 2; i < 1000; i++) if (!this.get(`${base}-${i}`)) return `${base}-${i}`
    return `${base}-${randomUUID().slice(0, 8)}`
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { schedules?: unknown }
      const list = Array.isArray(raw.schedules) ? raw.schedules : []
      // Written by hand: the missing parts filled in.
      this.schedules = list.filter(valid).map((s) => ({ ...s, prompt: s.prompt ?? '', enabled: s.enabled !== false, created: s.created ?? this.now().toISOString(), next: s.next === undefined ? s.start : s.next }))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`scheduler: could not read ${this.file}, keeping what was loaded: ${(err as Error).message}`)
    }
  }

  private changed(save = true): void {
    if (save) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp`
        fs.writeFileSync(tmp, `${JSON.stringify({ schedules: this.schedules }, null, 2)}\n`)
        fs.renameSync(tmp, this.file)
        this.lastWritten = fs.statSync(this.file).mtimeMs
      } catch (err) {
        this.log(`scheduler: could not save ${this.file}`, err)
      }
    }
    this.emit('change')
    if (!this.stopped) {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.tick(), 0)
      this.timer.unref?.()
    }
  }
}

/** When it goes off next: the snooze, or its next time. */
export function dueOf(s: Schedule): Date | null {
  const times = [s.snoozedUntil, s.next].filter((t): t is string => !!t).map((t) => new Date(t))
  return times.length ? new Date(Math.min(...times.map((t) => t.getTime()))) : null
}

function defaultMessage(kind: ScheduleKind, title: string): string {
  if (kind === 'timer') return /timer$/i.test(title) ? `The ${title} is done.` : `The ${title} timer is done.`
  if (kind === 'alarm') return `${title}.`
  return `Reminder: ${title}.`
}

function valid(s: unknown): s is Schedule {
  if (!s || typeof s !== 'object') return false
  const x = s as Record<string, unknown>
  return typeof x.id === 'string' && typeof x.title === 'string' && typeof x.start === 'string' && !Number.isNaN(Date.parse(x.start)) && KINDS.includes(x.kind as ScheduleKind) && typeof x.message === 'string'
}
