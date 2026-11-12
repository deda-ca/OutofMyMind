// Jarvis's sessions: one Markdown file each in WORKSPACE_DIR/sessions (see
// format.ts), plus which one is active, in DATA_DIR/sessions.json.
//
// Each session talks with one agent (agents/<id>.md); a new session uses the
// agent chosen for it before its first message (`newAgent`).
//
// The active session is what Jarvis is talking in: every request, answer and
// bit of context is added to it, and the LLM's history is read from it. It's
// shared by every connected device. A new session isn't written until its
// first message, so "New session" never leaves empty files behind.
//
// Files are re-read when they change on disk, so hand edits (or edits by the
// files plugin) are picked up.

import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fromMarkdown, toMarkdown, type Session, type SessionEntry, type SessionMeta } from './format.ts'

export interface SessionSummary extends SessionMeta {
  messages: number
  /** The first request, for sessions without a title. */
  preview: string
}

export class SessionError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const ID = /^[0-9a-z-]{1,64}$/

export class SessionStore extends EventEmitter<{ change: [activeId: string | null] }> {
  readonly dir: string
  private readonly stateFile: string
  private cache = new Map<string, { mtimeMs: number; session: Session }>()
  private active: string | null | undefined
  /** The agent for the next new session. */
  private nextAgent = ''
  /** The model chosen for the next new session ('' = its agent's). */
  private nextModel = ''
  /** The voice chosen for the next new session ('' = its agent's). */
  private nextVoice = ''

  constructor(dir: string, stateFile: string) {
    super()
    this.dir = dir
    this.stateFile = stateFile
  }

  /** Every session, pinned first, then most recently updated. */
  list(): SessionSummary[] {
    let names: string[] = []
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.md'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const sessions = names.flatMap((n) => {
      const s = this.get(n.slice(0, -3))
      return s ? [summary(s)] : []
    })
    return sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated.localeCompare(a.updated))
  }

  get(id: string): Session | undefined {
    if (!ID.test(id)) return undefined
    const file = this.file(id)
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      this.cache.delete(id)
      return undefined
    }
    const cached = this.cache.get(id)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.session
    const session = fromMarkdown(id, fs.readFileSync(file, 'utf8'))
    this.cache.set(id, { mtimeMs: stat.mtimeMs, session })
    return session
  }

  /** The session being talked in; null after "New session" until its first message. */
  activeId(): string | null {
    if (this.active === undefined) {
      try {
        const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { activeId?: unknown; newAgent?: unknown; newModel?: unknown; newVoice?: unknown }
        this.active = typeof state.activeId === 'string' && this.get(state.activeId) ? state.activeId : null
        this.nextAgent = typeof state.newAgent === 'string' ? state.newAgent : ''
        this.nextModel = typeof state.newModel === 'string' ? state.newModel : ''
        this.nextVoice = typeof state.newVoice === 'string' ? state.newVoice : ''
      } catch {
        this.active = null
      }
    }
    if (this.active && !this.get(this.active)) this.setActive(null) // deleted by hand
    return this.active
  }

  /** The agent of the active session, or the one chosen for the next new session ('' = default). */
  agentId(): string {
    const id = this.activeId()
    return id ? (this.get(id)?.agent ?? '') : this.nextAgent
  }

  /** The LLM of the active session, or the one chosen for the next new session ('' = its agent's). */
  model(): string {
    const id = this.activeId()
    return id ? (this.get(id)?.model ?? '') : this.nextModel
  }

  /** The voice of the active session, or the one chosen for the next new session ('' = its agent's). */
  voice(): string {
    const id = this.activeId()
    return id ? (this.get(id)?.voice ?? '') : this.nextVoice
  }

  /** The voice chosen for the next new session. */
  newVoice(): string {
    this.activeId()
    return this.nextVoice
  }

  /** Choose the voice for the next new session ('' = its agent's). */
  setNewVoice(voice: string): void {
    this.activeId()
    this.nextVoice = voice
    this.setActive(this.active ?? null)
    this.emit('change', this.active ?? null)
  }

  /** The model chosen for the next new session. */
  newModel(): string {
    this.activeId()
    return this.nextModel
  }

  /** Choose the model for the next new session ('' = its agent's). */
  setNewModel(model: string): void {
    this.activeId()
    this.nextModel = model
    this.setActive(this.active ?? null)
    this.emit('change', this.active ?? null)
  }

  /** The agent chosen for the next new session. */
  newAgent(): string {
    this.activeId() // loads the saved state
    return this.nextAgent
  }

  /** The active session's messages (none for a new one). */
  entries(): SessionEntry[] {
    const id = this.activeId()
    return (id && this.get(id)?.entries) || []
  }

  /** Switch to a saved session. */
  activate(id: string): void {
    if (!this.get(id)) throw new SessionError('No such session', 404)
    this.setActive(id)
    this.emit('change', id)
  }

  /** Start a new session (it's saved with its first message), optionally with another agent. */
  startNew(agent?: string): void {
    this.activeId()
    if (agent !== undefined) this.nextAgent = agent
    // A new session starts on its agent's model and voice.
    this.nextModel = ''
    this.nextVoice = ''
    this.setActive(null)
    this.emit('change', null)
  }

  /** Adds a message to the active session, creating the session if needed. */
  record(entry: SessionEntry): void {
    let session = this.activeId() ? this.get(this.activeId()!) : undefined
    if (!session) {
      session = { id: newId(new Date(entry.at)), title: '', pinned: false, agent: this.nextAgent, ...(this.nextModel ? { model: this.nextModel } : {}), ...(this.nextVoice ? { voice: this.nextVoice } : {}), created: entry.at, updated: entry.at, entries: [] }
      this.setActive(session.id)
    }
    session.entries.push(entry)
    session.updated = entry.at
    this.write(session)
    this.emit('change', session.id)
  }

  /** Choose the agent for the next new session (shown while no session is active). */
  setNewAgent(agent: string): void {
    this.activeId()
    this.nextAgent = agent
    this.setActive(this.active ?? null)
    this.emit('change', this.active ?? null)
  }

  /**
   * `agentName`: the new agent's name, for the note added when a session that
   * already has messages switches agent. Without it the model copies its own
   * earlier answers ("I'm read-only, I can't") and ignores the new agent.
   */
  update(id: string, change: { title?: string; pinned?: boolean; agent?: string; agentName?: string; model?: string; voice?: string }): SessionMeta {
    const session = this.get(id)
    if (!session) throw new SessionError('No such session', 404)
    if (change.agent !== undefined && change.agent !== session.agent && session.entries.length > 0) {
      const at = new Date().toISOString()
      session.entries.push({
        kind: 'note',
        at,
        text: `From here on you are the ${change.agentName ?? (change.agent || 'default')} agent. Follow its instructions and use the tools you have now; what earlier answers said you can or can't do may no longer apply.`,
      })
      session.updated = at
    }
    if (change.title !== undefined) session.title = change.title.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (change.pinned !== undefined) session.pinned = change.pinned
    if (change.agent !== undefined) session.agent = change.agent
    if (change.model !== undefined) {
      if (change.model) session.model = change.model
      else delete session.model
    }
    if (change.voice !== undefined) {
      if (change.voice) session.voice = change.voice
      else delete session.voice
    }
    this.write(session)
    this.emit('change', this.activeId())
    return summary(session)
  }

  delete(id: string): void {
    if (!this.get(id)) throw new SessionError('No such session', 404)
    fs.rmSync(this.file(id))
    this.cache.delete(id)
    if (this.active === id) this.setActive(null)
    this.emit('change', this.activeId())
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.md`)
  }

  private write(session: Session): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const file = this.file(session.id)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, toMarkdown(session))
    fs.renameSync(tmp, file)
    this.cache.set(session.id, { mtimeMs: fs.statSync(file).mtimeMs, session })
  }

  private setActive(id: string | null): void {
    this.active = id
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    fs.writeFileSync(this.stateFile, `${JSON.stringify({ activeId: id, newAgent: this.nextAgent, ...(this.nextModel ? { newModel: this.nextModel } : {}), ...(this.nextVoice ? { newVoice: this.nextVoice } : {}) })}\n`)
  }
}

function summary(s: Session): SessionSummary {
  const first = s.entries.find((e) => e.kind === 'owner')?.text ?? ''
  return { id: s.id, title: s.title, pinned: s.pinned, agent: s.agent, ...(s.model ? { model: s.model } : {}), ...(s.voice ? { voice: s.voice } : {}), created: s.created, updated: s.updated, messages: s.entries.length, preview: first.slice(0, 120) }
}

/** "2026-11-09-1430-a1b2": sorts by time, and never changes when the session is renamed. */
function newId(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}-${randomBytes(2).toString('hex')}`
}
