// A service's manifest, WORKSPACE_DIR/services/<id>/service.md (design:
// docs/services.md):
//
//   ---
//   name: Email
//   description: Checks the inbox for new mail
//   runs: every 5 min
//   timeout: 60 s
//   hosts: [imap.gmail.com:993]
//   secrets: [gmail]
//   packages: { imapflow: 2.11.0 }
//   on:
//     email.received:
//       agent: email-triage
//       prompt: |
//         Summarise it in one sentence. …
//       batch: 2 min
//       max_per_hour: 20
//   ---
//   What it does, in plain words.
//
// The frontmatter is a small YAML subset (mappings by indentation, [a, b]
// and {a: b} inline, "- item" lists, "|" blocks, # comments): parsed here,
// with no YAML package. Unknown keys are errors, so a typo never silently
// drops a setting.

export const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/
export const SECRET_NAME = /^[A-Za-z0-9_-]{1,40}$/
const EVENT_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface Trigger {
  /** The agent that handles the event (its tool limits apply). */
  agent: string
  prompt: string
  batchMs: number
  maxPerHour: number
}

export interface Manifest {
  name: string
  description: string
  /** How often it runs. */
  everyMs: number
  timeoutMs: number
  memoryMb: number
  /** "host:port", lower case. */
  hosts: string[]
  secrets: string[]
  /** npm package → exact version. */
  packages: Record<string, string>
  on: Record<string, Trigger>
  /** The text after the frontmatter. */
  about: string
}

export class ManifestError extends Error {}

const MIN = 60_000
export const DEFAULTS = { timeoutMs: 60_000, memoryMb: 256, batchMs: MIN, maxPerHour: 20 }
const LIMITS = { everyMs: [MIN, 24 * 60 * MIN], timeoutMs: [5_000, 10 * MIN], memoryMb: [64, 1024], batchMs: [0, 60 * MIN], maxPerHour: [1, 600] } as const

/** Parses and checks a service.md; throws a ManifestError listing every problem. */
export function parseManifest(text: string): Manifest {
  const { meta, body } = splitFrontmatter(text)
  const problems: string[] = []
  const known = new Set(['name', 'description', 'runs', 'timeout', 'memory', 'hosts', 'secrets', 'packages', 'on'])
  for (const key of Object.keys(meta)) if (!known.has(key)) problems.push(`unknown setting "${key}"`)

  const name = str(meta.name)
  if (!name) problems.push('"name" is needed')
  const description = str(meta.description)

  let everyMs = 0
  const runs = str(meta.runs)
  const every = /^every\s+(.+)$/i.exec(runs)
  if (!runs) problems.push('"runs" is needed, like "every 5 min"')
  else if (!every) problems.push(`"runs: ${runs}": only "every <time>" for now, like "every 5 min" or "every 1 h"`)
  else everyMs = within(duration(every[1]!, problems, 'runs'), 'runs', LIMITS.everyMs, problems, ms)

  const timeoutMs = meta.timeout === undefined ? DEFAULTS.timeoutMs : within(duration(str(meta.timeout), problems, 'timeout'), 'timeout', LIMITS.timeoutMs, problems, ms)
  let memoryMb = DEFAULTS.memoryMb
  if (meta.memory !== undefined) {
    const m = /^(\d+)\s*mb$/i.exec(str(meta.memory))
    if (!m) problems.push('"memory" is like "256 MB"')
    else memoryMb = within(Number(m[1]), 'memory', LIMITS.memoryMb, problems, (v) => `${v} MB`)
  }

  const hosts = list(meta.hosts, 'hosts', problems).map((h) => h.toLowerCase())
  for (const h of hosts) {
    const m = /^(.+):(\d{1,5})$/.exec(h)
    if (!m || !HOST.test(m[1]!) || Number(m[2]) < 1 || Number(m[2]) > 65535) problems.push(`host "${h}" should be a name and port, like imap.gmail.com:993`)
  }
  const secrets = list(meta.secrets, 'secrets', problems)
  for (const s of secrets) if (!SECRET_NAME.test(s)) problems.push(`secret name "${s}": letters, digits, - and _ only`)

  const packages: Record<string, string> = {}
  if (meta.packages !== undefined) {
    if (!isMap(meta.packages)) problems.push('"packages" is a map of name to exact version, like { imapflow: 2.11.0 }')
    else
      for (const [pkg, version] of Object.entries(meta.packages)) {
        const v = str(version)
        if (!PACKAGE.test(pkg)) problems.push(`package "${pkg}" isn't a valid npm name`)
        else if (!EXACT_VERSION.test(v)) problems.push(`package "${pkg}": give an exact version like 2.11.0 (not "${v}")`)
        else packages[pkg] = v
      }
  }

  const on: Record<string, Trigger> = {}
  if (meta.on !== undefined) {
    if (!isMap(meta.on)) problems.push('"on" is a map of event name to what to do with it')
    else
      for (const [event, raw] of Object.entries(meta.on)) {
        if (!EVENT_NAME.test(event)) problems.push(`event "${event}": lower case letters, digits, . - _`)
        if (!isMap(raw)) {
          problems.push(`event "${event}" needs "agent" and "prompt"`)
          continue
        }
        for (const key of Object.keys(raw)) if (!['agent', 'prompt', 'batch', 'max_per_hour'].includes(key)) problems.push(`event "${event}": unknown setting "${key}"`)
        const agent = str(raw.agent)
        const prompt = str(raw.prompt)
        if (!agent) problems.push(`event "${event}" needs "agent" (an agent from the agents folder)`)
        else if (!AGENT_ID.test(agent)) problems.push(`event "${event}": agent "${agent}" isn't an agent id`)
        if (!prompt) problems.push(`event "${event}" needs "prompt"`)
        const batchMs = raw.batch === undefined ? DEFAULTS.batchMs : within(duration(str(raw.batch), problems, `${event} batch`), `${event} batch`, LIMITS.batchMs, problems, ms)
        let maxPerHour = DEFAULTS.maxPerHour
        if (raw.max_per_hour !== undefined) {
          const n = Number(str(raw.max_per_hour))
          if (!Number.isInteger(n)) problems.push(`event "${event}": max_per_hour is a whole number`)
          else maxPerHour = within(n, `${event} max_per_hour`, LIMITS.maxPerHour, problems, String)
        }
        on[event] = { agent, prompt, batchMs, maxPerHour }
      }
  }
  if (problems.length) throw new ManifestError(problems.join('; '))
  return { name, description, everyMs, timeoutMs, memoryMb, hosts: [...new Set(hosts)], secrets: [...new Set(secrets)], packages, on, about: body.trim() }
}

/** What a manifest allows, one line each, in plain words (for approval). */
export function describePermissions(m: Manifest): string[] {
  return [
    `Runs every ${ms(m.everyMs)}, for at most ${ms(m.timeoutMs)} each time, with up to ${m.memoryMb} MB of memory.`,
    m.hosts.length ? `Can connect to: ${m.hosts.join(', ')}.` : 'Can\'t connect to anything on the internet.',
    m.secrets.length ? `Can read the secrets: ${m.secrets.join(', ')}.` : 'Reads no secrets.',
    ...Object.entries(m.packages).map(([p, v]) => `Uses the npm package ${p} ${v} (https://www.npmjs.com/package/${p}/v/${v}).`),
    ...Object.entries(m.on).map(([event, t]) => `On "${event}": the agent "${t.agent}" runs its prompt (at most ${t.maxPerHour} times an hour${t.batchMs ? `, events within ${ms(t.batchMs)} together` : ''}).`),
  ]
}

/** What a new manifest can do that the old one couldn't, in plain words. Empty: nothing more. */
export function widened(before: Manifest | undefined, after: Manifest): string[] {
  if (!before) return describePermissions(after)
  const out: string[] = []
  const added = (a: string[], b: string[]) => b.filter((x) => !a.includes(x))
  for (const h of added(before.hosts, after.hosts)) out.push(`Can now also connect to ${h}.`)
  for (const s of added(before.secrets, after.secrets)) out.push(`Can now also read the secret "${s}".`)
  for (const [p, v] of Object.entries(after.packages)) if (before.packages[p] !== v) out.push(before.packages[p] ? `Package ${p}: ${before.packages[p]} → ${v}.` : `Now uses the npm package ${p} ${v}.`)
  if (after.everyMs < before.everyMs) out.push(`Runs more often: every ${ms(after.everyMs)} (was ${ms(before.everyMs)}).`)
  if (after.timeoutMs > before.timeoutMs) out.push(`May run longer: ${ms(after.timeoutMs)} (was ${ms(before.timeoutMs)}).`)
  if (after.memoryMb > before.memoryMb) out.push(`More memory: ${after.memoryMb} MB (was ${before.memoryMb} MB).`)
  for (const [event, t] of Object.entries(after.on)) {
    const old = before.on[event]
    if (!old) out.push(`New event "${event}": the agent "${t.agent}" runs its prompt.`)
    else {
      if (old.agent !== t.agent) out.push(`"${event}" is now handled by the agent "${t.agent}" (was "${old.agent}").`)
      if (old.prompt !== t.prompt) out.push(`"${event}" has a new prompt.`)
      if (t.maxPerHour > old.maxPerHour) out.push(`"${event}" may run ${t.maxPerHour} times an hour (was ${old.maxPerHour}).`)
    }
  }
  return out
}

/** "90 s", "5 min", "2 h". */
export function ms(value: number): string {
  if (value % 3_600_000 === 0) return `${value / 3_600_000} h`
  if (value % 60_000 === 0) return `${value / 60_000} min`
  return `${Math.round(value / 1000)} s`
}

function duration(text: string, problems: string[], what: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)$/i.exec(text.trim())
  if (!m) {
    problems.push(`"${what}: ${text}" should be a time like "30 s", "5 min" or "2 h"`)
    return NaN
  }
  const unit = m[2]!.toLowerCase()
  return Math.round(Number(m[1]) * (unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1000))
}

function within(value: number, what: string, [lo, hi]: readonly [number, number], problems: string[], fmt: (v: number) => string): number {
  if (Number.isNaN(value)) return lo
  if (value < lo || value > hi) problems.push(`"${what}" must be from ${fmt(lo)} to ${fmt(hi)}`)
  return Math.min(hi, Math.max(lo, value))
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function list(v: unknown, what: string, problems: string[]): string[] {
  if (v === undefined || v === '') return []
  if (Array.isArray(v)) return v.map(str).filter(Boolean)
  if (typeof v === 'string') return [v.trim()]
  problems.push(`"${what}" is a list, like [a, b]`)
  return []
}

// ── The frontmatter ──────────────────────────────────────────────────────────

type Value = string | Value[] | { [key: string]: Value }

export function splitFrontmatter(text: string): { meta: Record<string, Value>; body: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') throw new ManifestError('service.md must start with a "---" frontmatter block')
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end === -1) throw new ManifestError('the frontmatter has no closing "---"')
  const meta = parseBlock(lines.slice(1, end), { i: 0 }, 0)
  if (!isMap(meta)) throw new ManifestError('the frontmatter should be "key: value" lines')
  return { meta: meta as Record<string, Value>, body: lines.slice(end + 1).join('\n') }
}

const indentOf = (line: string) => line.length - line.trimStart().length
const blank = (line: string) => line.trim() === '' || line.trimStart().startsWith('#')

/** The lines from at.i with indentation >= indent: a mapping or a "- " list. */
function parseBlock(lines: string[], at: { i: number }, indent: number): Value {
  while (at.i < lines.length && blank(lines[at.i]!)) at.i++
  if (at.i >= lines.length) return ''
  const first = lines[at.i]!
  const own = indentOf(first)
  if (own < indent) return ''
  if (first.trimStart().startsWith('- ') || first.trim() === '-') {
    const items: Value[] = []
    while (at.i < lines.length) {
      const line = lines[at.i]!
      if (blank(line)) {
        at.i++
        continue
      }
      if (indentOf(line) !== own || !line.trimStart().startsWith('-')) break
      items.push(scalar(line.trimStart().slice(1).trim()))
      at.i++
    }
    return items
  }
  const map: Record<string, Value> = {}
  while (at.i < lines.length) {
    const line = lines[at.i]!
    if (blank(line)) {
      at.i++
      continue
    }
    const ind = indentOf(line)
    if (ind < own) break
    if (ind > own) throw new ManifestError(`unexpected indentation: "${line.trim()}"`)
    const m = /^("[^"]*"|'[^']*'|[^:#]+?)\s*:(?:\s+(.*))?$/.exec(line.trim())
    if (!m) throw new ManifestError(`expected "key: value": "${line.trim()}"`)
    const key = unquote(m[1]!)
    const rest = (m[2] ?? '').trim()
    at.i++
    if (rest === '|' || rest === '|-' || rest === '>') {
      const block: string[] = []
      while (at.i < lines.length && (lines[at.i]!.trim() === '' || indentOf(lines[at.i]!) > own)) block.push(lines[at.i++]!)
      while (block.length && block[block.length - 1]!.trim() === '') block.pop()
      const cut = Math.min(...block.filter((l) => l.trim()).map(indentOf))
      const textLines = block.map((l) => l.slice(Number.isFinite(cut) ? cut : 0))
      map[key] = rest === '>' ? textLines.join(' ').replace(/\s+/g, ' ').trim() : textLines.join('\n')
    } else if (rest === '' || rest.startsWith('#')) {
      map[key] = parseBlock(lines, at, own + 1)
    } else {
      map[key] = scalar(rest)
    }
  }
  return map
}

function scalar(raw: string): Value {
  const text = raw.trim()
  if (text.startsWith('"') || text.startsWith("'")) {
    const q = text[0]!
    const close = text.indexOf(q, 1)
    return close === -1 ? text : unquote(text.slice(0, close + 1))
  }
  if (text.startsWith('[')) {
    const close = text.lastIndexOf(']')
    return splitTop(text.slice(1, close === -1 ? undefined : close)).map(scalar).filter((v) => v !== '')
  }
  if (text.startsWith('{')) {
    const close = text.lastIndexOf('}')
    const map: Record<string, Value> = {}
    for (const part of splitTop(text.slice(1, close === -1 ? undefined : close))) {
      const at = part.indexOf(':')
      if (at === -1) throw new ManifestError(`expected "key: value" in { … }: "${part}"`)
      map[unquote(part.slice(0, at).trim())] = scalar(part.slice(at + 1))
    }
    return map
  }
  return text.replace(/\s+#.*$/, '').trim()
}

/** Splits "a, b, [c, d]" at top-level commas. */
function splitTop(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    if (v.startsWith('"')) {
      try {
        return String(JSON.parse(v))
      } catch {
        // fall through
      }
    }
    return v.slice(1, -1)
  }
  return v
}
