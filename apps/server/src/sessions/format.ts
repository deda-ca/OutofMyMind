// A session as a Markdown file: YAML-style frontmatter, then one "## Who · time"
// section per message. Readable and editable by hand, and strict enough to be
// read back into the LLM's history:
//
//   ---
//   title: "Shopping and dentist"
//   pinned: false
//   agent: email                (optional; the default agent otherwise)
//   created: 2026-11-09T19:30:12.000Z
//   updated: 2026-11-09T19:41:03.000Z
//   ---
//
//   # Shopping and dentist
//
//   ## Owner · 2026-11-09 14:30:12 · #123
//   Add milk and eggs to my shopping list.
//
//   ## Jarvis · 2026-11-09 14:30:14
//   ```tool files__append_file
//   {"path":"lists/shopping.md","content":"- milk\n- eggs\n"}
//   → Successfully appended
//   ```
//   I've added milk and eggs to your shopping list.
//
//   ## Maria (not to Jarvis) · 2026-11-09 14:31:00
//   Get bread too.
//
// "#123" is the archive phrase the request came from (its audio). Message
// text is never mistaken for structure: a text line that starts with "#", "```"
// or "\" gets a "\" in front, removed again when read. Tool blocks use a fence
// longer than any run of backticks inside them.

export interface ToolUse {
  /** The function name the LLM called, e.g. "files__append_file". */
  name: string
  /** Its arguments, as JSON. */
  args: string
  /** What came back (cut for length). */
  result: string
}

export type SessionEntry =
  /** A request from the owner (spoken or typed). */
  | { kind: 'owner'; at: string; text: string; phraseId?: number }
  /** Jarvis's answer, with the tools it used for it. */
  | { kind: 'jarvis'; at: string; text: string; tools?: ToolUse[] }
  /** Someone else in the room, heard during the conversation: context, not a request. */
  | { kind: 'context'; at: string; who: string; text: string }
  /** What was said in the minutes before Jarvis was called ("Maria: …" lines). */
  | { kind: 'earlier'; at: string; text: string }
  /** A note from Jarvis's software to the model (e.g. the session switched agent). */
  | { kind: 'note'; at: string; text: string }

export interface SessionMeta {
  id: string
  /** Empty until named; the client shows the first request instead. */
  title: string
  pinned: boolean
  /** The agent it talks with (agents/<id>.md); empty: the default agent. */
  agent: string
  created: string
  updated: string
}

export interface Session extends SessionMeta {
  entries: SessionEntry[]
}

const OWNER = 'Owner'
const JARVIS = 'Jarvis'
const EARLIER = 'Earlier (context)'
const NOTE = 'Note'
const NOT_TO_JARVIS = ' (not to Jarvis)'

export function toMarkdown(session: Session): string {
  const out = [
    '---',
    `title: ${JSON.stringify(session.title)}`,
    `pinned: ${session.pinned}`,
    ...(session.agent ? [`agent: ${session.agent}`] : []),
    `created: ${session.created}`,
    `updated: ${session.updated}`,
    '---',
    '',
    `# ${escapeLine(session.title || 'Untitled session')}`,
  ]
  for (const entry of session.entries) {
    out.push('', `## ${heading(entry)}`)
    if (entry.kind === 'jarvis') {
      for (const tool of entry.tools ?? []) {
        const args = oneLineJson(tool.args)
        const fence = '`'.repeat(Math.max(3, longestBacktickRun(`${args}\n${tool.result}`) + 1))
        out.push(`${fence}tool ${tool.name}`, args, `→ ${tool.result}`, fence)
      }
    }
    out.push(...entry.text.split('\n').map(escapeLine))
  }
  return `${out.join('\n')}\n`
}

/** Reads a session file. Unknown or malformed parts are skipped, never thrown on (the owner may have edited it). */
export function fromMarkdown(id: string, markdown: string): Session {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const session: Session = { id, title: '', pinned: false, agent: '', created: '', updated: '', entries: [] }

  let i = 0
  if (lines[0] === '---') {
    for (i = 1; i < lines.length && lines[i] !== '---'; i++) {
      const match = /^(\w+):\s*(.*)$/.exec(lines[i]!)
      if (!match) continue
      const [, key, raw] = match as unknown as [string, string, string]
      if (key === 'title') session.title = parseString(raw)
      else if (key === 'pinned') session.pinned = raw.trim() === 'true'
      else if (key === 'agent') session.agent = /^[A-Za-z0-9_-]{1,64}$/.test(raw.trim()) ? raw.trim() : ''
      else if (key === 'created') session.created = raw.trim()
      else if (key === 'updated') session.updated = raw.trim()
    }
    i++
  }

  let current: { entry: SessionEntry; text: string[] } | undefined
  const finish = () => {
    if (!current) return
    current.entry.text = trimBlank(current.text).join('\n')
    session.entries.push(current.entry)
    current = undefined
  }

  for (; i < lines.length; i++) {
    const line = lines[i]!
    const entry = parseHeading(line)
    if (entry) {
      finish()
      current = { entry, text: [] }
      continue
    }
    if (!current) continue // the "# Title" line, or anything before the first message
    const fence = /^(`{3,})tool (\S+)\s*$/.exec(line)
    if (fence && current.entry.kind === 'jarvis') {
      const [, ticks, name] = fence as unknown as [string, string, string]
      const body: string[] = []
      for (i++; i < lines.length && lines[i] !== ticks; i++) body.push(lines[i]!)
      const [args = '{}', ...result] = body
      if (result[0]?.startsWith('→ ')) result[0] = result[0].slice(2)
      ;(current.entry.tools ??= []).push({ name, args, result: result.join('\n') })
      continue
    }
    current.text.push(unescapeLine(line))
  }
  finish()

  // Hand-made files may lack dates: fall back to the messages'.
  session.created ||= session.entries[0]?.at ?? new Date(0).toISOString()
  session.updated ||= session.entries.at(-1)?.at ?? session.created
  return session
}

function heading(entry: SessionEntry): string {
  const who =
    entry.kind === 'owner' ? OWNER : entry.kind === 'jarvis' ? JARVIS : entry.kind === 'earlier' ? EARLIER : entry.kind === 'note' ? NOTE : `${oneLine(entry.who)}${NOT_TO_JARVIS}`
  const phrase = entry.kind === 'owner' && entry.phraseId ? ` · #${entry.phraseId}` : ''
  return `${who} · ${localStamp(entry.at)}${phrase}`
}

function parseHeading(line: string): SessionEntry | null {
  const match = /^## (.+?) · (\d{4}-\d\d-\d\d) (\d\d:\d\d(?::\d\d)?)(?: · #(\d+))?\s*$/.exec(line)
  if (!match) return null
  const [, who, date, time, phrase] = match as unknown as [string, string, string, string, string | undefined]
  const parsed = new Date(`${date}T${time}`) // local time, as written
  const at = Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
  if (who === OWNER) return { kind: 'owner', at, text: '', ...(phrase ? { phraseId: Number(phrase) } : {}) }
  if (who === JARVIS) return { kind: 'jarvis', at, text: '' }
  if (who === EARLIER) return { kind: 'earlier', at, text: '' }
  if (who === NOTE) return { kind: 'note', at, text: '' }
  if (who.endsWith(NOT_TO_JARVIS)) return { kind: 'context', at, who: who.slice(0, -NOT_TO_JARVIS.length), text: '' }
  return null
}

/** "2026-11-09 14:30:12" in the server's local time (what the owner reads). */
function localStamp(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function escapeLine(line: string): string {
  return /^(\\|#|```)/.test(line) ? `\\${line}` : line
}

function unescapeLine(line: string): string {
  return line.startsWith('\\') ? line.slice(1) : line
}

function parseString(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value))
    } catch {
      return value.slice(1, -1)
    }
  }
  return value
}

function oneLineJson(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args))
  } catch {
    return oneLine(args)
  }
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ')
}

function longestBacktickRun(text: string): number {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return longest
}

function trimBlank(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]!.trim() === '') start++
  while (end > start && lines[end - 1]!.trim() === '') end--
  return lines.slice(start, end)
}
