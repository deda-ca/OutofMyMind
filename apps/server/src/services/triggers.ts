// What happens to a service's events (docs/services.md): each (service, event)
// has a queue. Events are de-duplicated by payload.id, gathered for the
// trigger's batch window, and handed to one unattended LLM turn at a time (for
// all services together), within the trigger's turns-per-hour and the daily
// budget for all services. Over a limit, events wait (up to a point) and the
// owner is told once.

import fs from 'node:fs'
import path from 'node:path'
import type { Trigger } from './manifest.ts'

export interface TurnRequest {
  serviceId: string
  serviceName: string
  event: string
  trigger: Trigger
  payloads: unknown[]
}

export interface TriggerOptions {
  /** DATA_DIR/services: seen ids and the day's count are kept here. */
  dir: string
  dailyTurns: number
  /** Runs the turn. */
  run: (turn: TurnRequest) => Promise<void>
  /** Tells the owner something (a notification). */
  tell: (title: string, text: string) => void
  log: (serviceId: string, line: string) => void
  now?: () => number
}

/** Events in one turn, at most. */
const PER_TURN = 20
/** Waiting events per trigger, at most (beyond: refused). */
const MAX_WAITING = 200
const SEEN_DAYS = 7
const SEEN_MAX = 5000
const HOUR = 3_600_000

interface Queue {
  serviceName: string
  trigger: Trigger
  items: unknown[]
  timer?: ReturnType<typeof setTimeout>
  /** When this trigger's recent turns ran (for max_per_hour). */
  turns: number[]
  /** The owner was told it's over a limit (once until it's under again). */
  told?: boolean
}

export class Triggers {
  private readonly o: Required<TriggerOptions>
  private readonly queues = new Map<string, Queue>()
  private readonly seen = new Map<string, Map<string, number>>()
  private chain: Promise<void> = Promise.resolve()
  private day: { date: string; turns: number; told?: boolean }
  private stopped = false

  constructor(o: TriggerOptions) {
    this.o = { now: Date.now, ...o }
    this.day = this.readJson('budget.json', { date: '', turns: 0 })
  }

  /** An event from a service's gate. */
  accept(serviceId: string, serviceName: string, trigger: Trigger | undefined, event: string, payload: unknown): { status: number; message: string } {
    if (this.stopped) return { status: 503, message: 'Services are stopping.' }
    if (!trigger) {
      this.o.log(serviceId, `event "${event}" dropped: it isn't under "on:" in service.md`)
      return { status: 403, message: `"${event}" isn't one of this service's events (add it under "on:" in service.md).` }
    }
    const id = payload && typeof payload === 'object' && 'id' in payload ? String((payload as { id: unknown }).id ?? '') : ''
    if (id) {
      const seen = this.seenFor(serviceId)
      if (seen.has(`${event}\0${id}`)) return { status: 200, message: 'Already handled (same id).' }
      seen.set(`${event}\0${id}`, this.o.now())
      this.saveSeen(serviceId)
    }
    const key = `${serviceId}\0${event}`
    let q = this.queues.get(key)
    if (!q) {
      q = { serviceName, trigger, items: [], turns: [] }
      this.queues.set(key, q)
    }
    q.serviceName = serviceName
    q.trigger = trigger
    if (q.items.length >= MAX_WAITING) {
      this.o.log(serviceId, `event "${event}" refused: ${MAX_WAITING} are already waiting`)
      return { status: 429, message: `Too many "${event}" events waiting (${MAX_WAITING}); try again later.` }
    }
    q.items.push(payload)
    if (!q.timer) q.timer = setTimeout(() => this.flush(serviceId, event), trigger.batchMs)
    return { status: 202, message: 'Taken.' }
  }

  /** Drops what's waiting for a service (paused, deleted), or for all. */
  clear(serviceId?: string): void {
    for (const [key, q] of this.queues) {
      if (serviceId && !key.startsWith(`${serviceId}\0`)) continue
      clearTimeout(q.timer)
      this.queues.delete(key)
    }
  }

  /** Stops everything; waits for a turn under way. */
  async stop(): Promise<void> {
    this.stopped = true
    this.clear()
    await this.chain
  }

  /** How many turns services have had today, and the budget. */
  budget(): { turns: number; limit: number } {
    this.rollDay()
    return { turns: this.day.turns, limit: this.o.dailyTurns }
  }

  waiting(serviceId: string): number {
    let n = 0
    for (const [key, q] of this.queues) if (key.startsWith(`${serviceId}\0`)) n += q.items.length
    return n
  }

  private flush(serviceId: string, event: string): void {
    const key = `${serviceId}\0${event}`
    const q = this.queues.get(key)
    if (!q || this.stopped) return
    q.timer = undefined
    if (!q.items.length) return
    const now = this.o.now()
    q.turns = q.turns.filter((t) => now - t < HOUR)
    this.rollDay()
    if (this.day.turns >= this.o.dailyTurns) {
      if (!this.day.told) {
        this.day.told = true
        this.saveDay()
        this.o.tell('Services: daily limit reached', `Services have had ${this.day.turns} turns today, the most allowed (SERVICES_DAILY_TURNS). Events wait until tomorrow.`)
      }
      q.timer = setTimeout(() => this.flush(serviceId, event), msToMidnight(now))
      return
    }
    if (q.turns.length >= q.trigger.maxPerHour) {
      if (!q.told) {
        q.told = true
        this.o.tell(`${q.serviceName}: paused for now`, `"${event}" has had ${q.turns.length} turns this hour, its limit (max_per_hour). ${q.items.length} event${q.items.length === 1 ? '' : 's'} waiting; they'll be handled when the hour allows.`)
      }
      q.timer = setTimeout(() => this.flush(serviceId, event), HOUR - (now - q.turns[0]!) + 1000)
      return
    }
    q.told = false
    const payloads = q.items.splice(0, PER_TURN)
    q.turns.push(now)
    this.day.turns++
    this.saveDay()
    const turn: TurnRequest = { serviceId, serviceName: q.serviceName, event, trigger: q.trigger, payloads }
    this.chain = this.chain
      .then(() => (this.stopped ? undefined : this.o.run(turn)))
      .catch((err: unknown) => this.o.log(serviceId, `the turn for "${event}" failed: ${(err as Error).message}`))
    if (q.items.length) q.timer = setTimeout(() => this.flush(serviceId, event), q.trigger.batchMs)
  }

  private rollDay(): void {
    const date = localDate(this.o.now())
    if (this.day.date !== date) this.day = { date, turns: 0 }
  }

  private seenFor(serviceId: string): Map<string, number> {
    let seen = this.seen.get(serviceId)
    if (!seen) {
      const saved = this.readJson<Record<string, number>>(path.join(serviceId, 'seen.json'), {})
      const cutoff = this.o.now() - SEEN_DAYS * 24 * HOUR
      seen = new Map(Object.entries(saved).filter(([, at]) => at >= cutoff))
      this.seen.set(serviceId, seen)
    }
    return seen
  }

  private saveSeen(serviceId: string): void {
    const seen = this.seen.get(serviceId)!
    while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!)
    this.writeJson(path.join(serviceId, 'seen.json'), Object.fromEntries(seen))
  }

  private saveDay(): void {
    this.writeJson('budget.json', this.day)
  }

  private readJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.o.dir, name), 'utf8')) as T
    } catch {
      return fallback
    }
  }

  private writeJson(name: string, value: unknown): void {
    const file = path.join(this.o.dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value))
    fs.renameSync(`${file}.tmp`, file)
  }
}

function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function msToMidnight(ms: number): number {
  const d = new Date(ms)
  d.setHours(24, 0, 5, 0)
  return d.getTime() - ms
}
