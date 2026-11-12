// What the LLMs cost: every response's token counts (the usage chunk at the end
// of the stream, read in llm.ts readSse), priced and added up by day, by
// "connection/model", by source (chat, telegram, a plugin, a service, the
// scheduler) and by session. Kept in DATA_DIR/usage.json.
//
// Prices are per million tokens: Claude's are built in (below), llama.cpp is
// free, and any connection can give its own (llm.connections[].prices). A
// model without a price is counted in tokens only.
//
// A connection's daily budget (llm.connections[].budget, in dollars): once
// today's spending on it reaches it, new turns go to the default model
// instead (chatTarget), and the owner is told once that day.

import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

/** Dollars per million tokens. */
export interface Price {
  input: number
  output: number
  /** Cache reads (default: the input price). */
  cacheRead?: number
  /** Cache writes (default: the input price; Claude: 1.25× it). */
  cacheWrite?: number
}

/** One response's tokens. `input` counts every prompt token, cached or not. */
export interface Tokens {
  input: number
  cached: number
  cacheWrite: number
  output: number
}

export interface Totals extends Tokens {
  requests: number
  /** Dollars, for the requests that had a price. */
  cost: number
  /** Requests without a price (their tokens are counted, not their cost). */
  unpriced: number
}

/** Claude's prices (Anthropic's list, November 2026): input, output, cache read. Cache writes: 1.25× input (5-minute cache). */
const CLAUDE: [RegExp, Price][] = [
  [/^claude-(fable|mythos)-5-2/, { input: 8, output: 40, cacheRead: 0.2 }],
  [/^claude-(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/^claude-(fable|mythos)-5(\b|-\d{8}|$)/, { input: 10, output: 50, cacheRead: 1 }],
  [/^claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/^claude-opus-5(\b|-\d{8}|$)/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/^claude-opus-4-[5-8]/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/^claude-sonnet-5-5/, { input: 2, output: 10, cacheRead: 0.1 }],
  [/^claude-sonnet-(5|4)/, { input: 2, output: 10, cacheRead: 0.2 }],
  // Haiku 5.5: $0.10 / $0.50 up to 100K prompt tokens (above: 5×, see costOf).
  [/^claude-haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/^claude-haiku-4-5/, { input: 1, output: 5, cacheRead: 0.1 }],
]

const FREE: Price = { input: 0, output: 0 }

/** What a model costs on a connection: its own prices, else free for llama.cpp, else Claude's list. null: unknown. */
export function priceOf(c: { kind?: string; llamaCpp?: boolean; prices?: Record<string, Price> }, model: string): Price | null {
  const own = c.prices?.[model] ?? c.prices?.['*']
  if (own) return own
  if (c.llamaCpp) return FREE
  if (c.kind === 'anthropic') {
    const hit = CLAUDE.find(([re]) => re.test(model))
    if (hit) return { ...hit[1], cacheWrite: hit[1].input * 1.25 }
  }
  return null
}

/** Dollars for one response's tokens. */
export function costOf(t: Tokens, p: Price, model = ''): number {
  // Haiku 5.5 costs 5× for prompts over 100K tokens.
  const k = /^claude-haiku-5-5/.test(model) && t.input > 100_000 ? 5 : 1
  const fresh = Math.max(0, t.input - t.cached - t.cacheWrite)
  return (k * (fresh * p.input + t.cached * (p.cacheRead ?? p.input) + t.cacheWrite * (p.cacheWrite ?? p.input) + t.output * p.output)) / 1_000_000
}

const zero = (): Totals => ({ requests: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, cost: 0, unpriced: 0 })
function add(into: Totals, t: Tokens, cost: number | null): void {
  into.requests++
  into.input += t.input
  into.cached += t.cached
  into.cacheWrite += t.cacheWrite
  into.output += t.output
  if (cost === null) into.unpriced++
  else into.cost += cost
}

/** Where a request comes from, set around a turn (withUsage); its totals add up there too. */
export interface UsageScope {
  /** chat, telegram, plugin:email, service:x, schedule, … */
  source: string
  /** The session it belongs to (asked when the response ends: a new session gets its id with its first message). */
  session?: () => string | null | undefined
  /** This turn's totals so far. */
  turn: Totals & { model?: string }
}

const scopes = new AsyncLocalStorage<UsageScope>()

/** Runs a turn with its requests counted under `source` (and `session`); returns what it returned and the turn's totals. */
export async function withUsage<T>(source: string, session: UsageScope['session'], fn: () => Promise<T>): Promise<{ result: T; turn: UsageScope['turn'] }> {
  const scope: UsageScope = { source, ...(session ? { session } : {}), turn: zero() }
  const result = await scopes.run(scope, fn)
  return { result, turn: scope.turn }
}

/** The turn's totals so far (inside withUsage). */
export const currentTurn = () => scopes.getStore()?.turn

interface Day {
  total: Totals
  /** By "connection/model". */
  models: Record<string, Totals>
  sources: Record<string, Totals>
  /** Dollars by connection (for budgets). */
  connections: Record<string, number>
}

interface Stored {
  days: Record<string, Day>
  sessions: Record<string, Totals>
}

/** Local date, "2026-11-11". */
const dayOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export class UsageLog extends EventEmitter<{ change: []; budget: [connection: string, budget: number, spent: number] }> {
  private data: Stored = { days: {}, sessions: {} }
  private file: string | null = null
  private saveTimer: NodeJS.Timeout | undefined
  private told = new Set<string>()

  /** Where it's kept (DATA_DIR/usage.json); without it (tests), in memory. */
  open(dataDir: string): void {
    this.file = path.join(dataDir, 'usage.json')
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Stored>
      this.data = { days: raw.days ?? {}, sessions: raw.sessions ?? {} }
    } catch {
      // none yet
    }
  }

  /** One response: priced, added to today, its source, its session and the turn. */
  record(target: { connection?: string; model: string; kind?: string; llamaCpp?: boolean; prices?: Record<string, Price>; budget?: number }, t: Tokens): void {
    const price = priceOf(target, target.model)
    const cost = price ? costOf(t, price, target.model) : null
    const scope = scopes.getStore()
    const day = (this.data.days[dayOf()] ??= { total: zero(), models: {}, sources: {}, connections: {} })
    const ref = `${target.connection ?? 'local'}/${target.model}`
    add(day.total, t, cost)
    add((day.models[ref] ??= zero()), t, cost)
    add((day.sources[scope?.source ?? 'other'] ??= zero()), t, cost)
    if (cost !== null && target.connection) day.connections[target.connection] = (day.connections[target.connection] ?? 0) + cost
    const session = scope?.session?.()
    if (session) add((this.data.sessions[session] ??= zero()), t, cost)
    if (scope) {
      add(scope.turn, t, cost)
      scope.turn.model = ref
    }
    if (target.connection && target.budget && cost) {
      const spent = day.connections[target.connection]!
      const key = `${dayOf()}|${target.connection}`
      if (spent >= target.budget && !this.told.has(key)) {
        this.told.add(key)
        this.emit('budget', target.connection, target.budget, spent)
      }
    }
    this.save()
    this.emit('change')
  }

  /** Dollars spent today on a connection. */
  spentToday(connection: string): number {
    return this.data.days[dayOf()]?.connections[connection] ?? 0
  }

  /** Today, this month, and a session (for the client). */
  summary(session?: string | null): { today: Day | null; month: Totals; session: Totals | null; date: string } {
    const date = dayOf()
    const month = zero()
    for (const [d, day] of Object.entries(this.data.days)) {
      if (!d.startsWith(date.slice(0, 7))) continue
      for (const k of ['requests', 'input', 'cached', 'cacheWrite', 'output', 'cost', 'unpriced'] as const) month[k] += day.total[k]
    }
    return { today: this.data.days[date] ?? null, month, session: (session && this.data.sessions[session]) || null, date }
  }

  private save(): void {
    if (!this.file || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      // A year of days is plenty.
      const days = Object.keys(this.data.days).sort()
      for (const d of days.slice(0, Math.max(0, days.length - 400))) delete this.data.days[d]
      try {
        fs.mkdirSync(path.dirname(this.file!), { recursive: true })
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data))
        fs.renameSync(`${this.file}.tmp`, this.file!)
      } catch (err) {
        console.warn(`usage: couldn't save: ${(err as Error).message}`)
      }
    }, 2000)
    this.saveTimer.unref()
  }

  /** Writes now (on shutdown). */
  flush(): void {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    if (!this.file) return
    fs.writeFileSync(this.file, JSON.stringify(this.data))
  }
}

export const usageLog = new UsageLog()
