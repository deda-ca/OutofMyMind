// What Jarvis says while it works on an answer, instead of silence: what it's
// doing ("Searching the web for bus fares.", "Opening nhl.com."), or if it
// isn't using a tool, something like "One moment." If it goes on, every few
// seconds of silence another line: what it's doing now if that changed, else
// "Still on it." and the like. Picked at random, never the same twice in a
// row, at most a few per answer. Spoken only (the screen shows the tools).
// The owner can turn it off (the "Say what I'm doing" setting).

import type { AgentEvent } from './llm.ts'

/** Before anything's said: no tool running yet. */
export const GENERIC = ['One moment.', 'Let me check.', 'Working on it.', 'Just a second.', 'On it.']
/** Still going, nothing new to say about it. */
export const STILL = ['Still working on it.', 'Still on it.', 'Almost there.', 'This is taking a little longer.', 'Bear with me.']

export interface ProgressOptions {
  /** Speak a line (queued after any sentences of the answer already said). */
  say: (line: string) => void
  /** Silence before the first line (shorter for Hermes, which nearly always uses tools). */
  firstAfterMs: number
  /** Silence before each line after that. */
  againAfterMs?: number
  /** Most lines in one answer. */
  max?: number
  random?: () => number
  now?: () => number
  /** How often to check (0: never by itself; tests call tick()). */
  tickMs?: number
}

export class ProgressSpeaker {
  private readonly o: Required<Omit<ProgressOptions, 'tickMs'>>
  /** When something was last said: the answer's text, or a line from here. */
  private lastSound: number
  private answering = false
  private toolRunning = false
  /** What it's doing, and whether that's been said. */
  private activity?: { line: string; said: boolean }
  private count = 0
  private last = ''
  private readonly timer?: ReturnType<typeof setInterval>

  constructor(options: ProgressOptions) {
    this.o = { againAfterMs: 8000, max: 4, random: Math.random, now: Date.now, ...options }
    this.lastSound = this.o.now()
    const tickMs = options.tickMs ?? 250
    if (tickMs > 0) this.timer = setInterval(() => this.tick(), tickMs)
  }

  /** Some of the answer arrived (it's being said). */
  text(): void {
    this.answering = true
    this.toolRunning = false
    this.lastSound = this.o.now()
  }

  /** A tool started or finished, or Hermes asks for approval. */
  event(event: AgentEvent): void {
    if (event.kind === 'approval') {
      this.speak('Hermes needs your approval for that.')
      return
    }
    if (event.call?.status === 'done') {
      this.toolRunning = false
      return
    }
    this.toolRunning = true
    const line = describeActivity(event)
    if (this.activity?.line !== line) this.activity = { line, said: false }
  }

  tick(): void {
    if (this.count >= this.o.max) return
    // The answer is being said and no tool is running: nothing to add.
    if (this.answering && !this.toolRunning) return
    const due = this.count === 0 ? this.o.firstAfterMs : this.o.againAfterMs
    if (this.o.now() - this.lastSound < due) return
    if (this.activity && !this.activity.said) {
      this.activity.said = true
      this.speak(this.activity.line)
    } else {
      this.speak(this.pick(this.count === 0 ? GENERIC : STILL))
    }
  }

  stop(): void {
    clearInterval(this.timer)
  }

  private speak(line: string): void {
    this.count++
    this.last = line
    this.lastSound = this.o.now()
    this.o.say(line)
  }

  private pick(lines: string[]): string {
    const choices = lines.filter((l) => l !== this.last)
    return choices[Math.floor(this.o.random() * choices.length)] ?? lines[0]!
  }
}

/** What a tool call (or a Hermes progress label) is doing, as Jarvis would say it. */
export function describeActivity(event: AgentEvent): string {
  if (event.call) return describeCall(event.call.name, parseArgs(event.call.args), event.call.crud)
  return describeLabel(event.label)
}

function parseArgs(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** "https://www.nhl.com/senators" → "nhl.com". */
function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** A workspace file as the owner thinks of it: "your to-do list", "your shopping list", "trip-plan". */
function thing(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const name = (parts.pop() ?? '').replace(/\.[a-z0-9]+$/i, '')
  const folder = parts.pop() ?? ''
  if (/^to-?do$/i.test(name)) return 'your to-do list'
  if (folder === 'lists') return `your ${name.replace(/[-_]+/g, ' ')} list`
  if (folder === 'logs') return `your ${name.replace(/[-_]+/g, ' ')} log`
  if (folder === 'notes' || folder === '') return name ? `your note ${name.replace(/[-_]+/g, ' ')}` : 'your notes'
  return name.replace(/[-_]+/g, ' ') || 'your files'
}

function describeCall(name: string, args: Record<string, unknown>, crud: string[]): string {
  const [plugin = '', tool = ''] = name.split('__')
  const path = str(args.path) || str(args.source) || str(args.file)
  switch (plugin) {
    case 'web': {
      if (tool === 'search') {
        const query = str(args.query)
        return query && query.length <= 50 ? `Searching the web for ${query.replace(/[.?!]+$/, '')}.` : 'Searching the web.'
      }
      const site = host(str(args.url))
      return site ? `Reading a page on ${site}.` : 'Reading a web page.'
    }
    case 'browser': {
      if (tool === 'browser_navigate') {
        const site = host(str(args.url))
        return site ? `Opening ${site}.` : 'Opening a page in the browser.'
      }
      if (/snapshot|find|screenshot/.test(tool)) return 'Looking at the page.'
      if (/type|fill|select|press/.test(tool)) return 'Filling in the page.'
      return 'Working in the browser.'
    }
    case 'notes':
      return crud.some((k) => k !== 'read') ? 'Updating your notes.' : 'Checking your notes.'
    case 'weather': {
      const where = str(args.location)
      return where ? `Checking the weather in ${where}.` : 'Checking the weather.'
    }
    case 'scripts':
      return 'Working that out.'
    case 'files':
      if (/director|tree|list/.test(tool)) return 'Looking through your files.'
      if (/search/.test(tool)) return 'Searching your files.'
      if (crud.some((k) => k !== 'read')) return path ? `Updating ${thing(path)}.` : 'Updating your files.'
      return path ? `Reading ${thing(path)}.` : 'Reading your files.'
    case 'jarvis':
      if (/schedule|alarm/.test(tool)) return /list/.test(tool) ? 'Checking your schedule.' : 'Setting that up.'
      if (/show_file/.test(tool)) return 'Putting it on the screen.'
      if (/skill/.test(tool)) return 'Checking how you like that done.'
      return 'Working on it.'
    default:
      return crud.length && crud.every((k) => k === 'read') ? 'Looking that up.' : 'Working on it.'
  }
}

/** Hermes says only a label for each step ("web_search", "terminal: ls", …). */
function describeLabel(label: string): string {
  const l = label.toLowerCase()
  if (/search/.test(l)) return 'Searching the web.'
  if (/browser|navigate|click/.test(l)) return 'Working in the browser.'
  if (/extract|fetch|scrape|crawl|url|web/.test(l)) return 'Reading a web page.'
  if (/terminal|shell|command|exec|bash|run/.test(l)) return 'Running a command.'
  if (/memory|remember|recall/.test(l)) return 'Checking what I remember.'
  if (/file|read|write|patch|edit/.test(l)) return 'Working with files.'
  return 'Working on it.'
}
