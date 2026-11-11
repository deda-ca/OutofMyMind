// Plugin events kept for the plugins that subscribe to them (docs/plugins.md):
// a plugin that wasn't running when an event happened (started later,
// restarted, crashed) is sent what it missed when it connects, in order, then
// new ones as they come. Each subscriber's place is kept, so nothing is sent
// twice across restarts. Bounded: the newest MAX events.

import fs from 'node:fs'
import path from 'node:path'

export interface LoggedEvent {
  seq: number
  from: string
  type: string
  payload: Record<string, unknown>
}

const MAX = 20_000

export class EventLog {
  private readonly file: string
  private readonly cursorsFile: string
  private events: LoggedEvent[] = []
  private cursors: Record<string, number> = {}
  private next = 1
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'events.jsonl')
    this.cursorsFile = path.join(dir, 'cursors.json')
    try {
      this.events = fs
        .readFileSync(this.file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LoggedEvent)
    } catch {
      // none yet
    }
    try {
      this.cursors = JSON.parse(fs.readFileSync(this.cursorsFile, 'utf8')) as Record<string, number>
    } catch {
      // none yet
    }
    this.next = (this.events.at(-1)?.seq ?? 0) + 1
  }

  append(from: string, type: string, payload: Record<string, unknown>): LoggedEvent {
    const e = { seq: this.next++, from, type, payload }
    this.events.push(e)
    fs.appendFileSync(this.file, `${JSON.stringify(e)}\n`)
    if (this.events.length > MAX * 1.25) {
      this.events = this.events.slice(-MAX)
      fs.writeFileSync(this.file, this.events.map((x) => JSON.stringify(x)).join('\n') + '\n')
    }
    return e
  }

  /** What `subscriber` hasn't been sent yet, of these types. */
  missed(subscriber: string, types: string[]): LoggedEvent[] {
    const after = this.cursors[subscriber] ?? 0
    return this.events.filter((e) => e.seq > after && types.includes(e.type) && e.from !== subscriber)
  }

  /** `subscriber` has been sent everything up to `seq`. */
  sent(subscriber: string, seq: number): void {
    if ((this.cursors[subscriber] ?? 0) >= seq) return
    this.cursors[subscriber] = seq
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null
      fs.writeFileSync(this.cursorsFile, JSON.stringify(this.cursors))
    }, 1000)
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    fs.writeFileSync(this.cursorsFile, JSON.stringify(this.cursors))
  }
}
