// Jarvis's sessions (server: apps/server/src/sessions/). The list, which one is
// active, and the active one's saved messages, shared by the session list and
// the Live transcript.

import { reactive } from 'vue'
import type { FileRef } from './uploads'

export interface ToolUse {
  name: string
  args: string
  result: string
}

export type SessionEntry =
  | { kind: 'owner'; at: string; text: string; phraseId?: number }
  | { kind: 'jarvis'; at: string; text: string; tools?: ToolUse[] }
  | { kind: 'context'; at: string; who: string; text: string }
  | { kind: 'earlier'; at: string; text: string }
  | { kind: 'note'; at: string; text: string }
  | { kind: 'files'; at: string; text: string; files: FileRef[] }

export interface SessionSummary {
  id: string
  title: string
  pinned: boolean
  /** Agent id; '' = the default agent. */
  agent: string
  created: string
  updated: string
  messages: number
  preview: string
}

interface Listing {
  activeId: string | null
  /** The agent the next new session will use. */
  newAgent: string
  sessions: SessionSummary[]
}

/** An agent (WORKSPACE_DIR/agents/<id>.md). */
export interface AgentInfo {
  id: string
  name: string
  description: string
  /** Allowed tool patterns; null = every tool. */
  tools: string[] | null
  brain?: 'local' | 'hermes'
  temperature?: number
  /** The instructions as written in its file (comments kept). */
  body: string
  /** Sessions without their own agent use the default one. */
  isDefault: boolean
  /** The fallback agent (jarvis): editable, not deletable. */
  builtIn: boolean
}

export interface AgentListing {
  defaultAgent: string
  agents: AgentInfo[]
}

export const sessions = reactive({
  list: [] as SessionSummary[],
  activeId: null as string | null,
  newAgent: '',
  agents: [] as AgentInfo[],
  /** The default agent's id: sessions with agent '' use it. */
  defaultAgent: 'jarvis',
  /** What each tool does (create / read / …), by function name: for the pills on saved tool calls. */
  toolCrud: {} as Record<string, string[]>,
  /** The session shown in the transcript, and its messages as they were when it was opened. */
  shownId: null as string | null,
  entries: [] as SessionEntry[],
  /** When the shown session became "new" (so a session created after that is this one, not a switch). */
  newSince: Date.now(),
  /** Bumped when the transcript should start over (another session was opened). */
  generation: 0,
  error: '',
})

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

const json = (method: string, body?: unknown): RequestInit =>
  body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }

function apply(listing: Listing): void {
  sessions.list = listing.sessions
  sessions.activeId = listing.activeId
  sessions.newAgent = listing.newAgent ?? ''
}

async function show(id: string | null): Promise<void> {
  if (id === null) {
    sessions.entries = []
    sessions.newSince = Date.now()
  } else {
    sessions.entries = (await api<{ session: { entries: SessionEntry[] } }>(`/api/sessions/${encodeURIComponent(id)}`)).session.entries
  }
  sessions.shownId = id
  sessions.generation++
}

async function attempt(what: () => Promise<void>): Promise<void> {
  sessions.error = ''
  try {
    await what()
  } catch (err) {
    sessions.error = (err as Error).message
  }
}

/** First load (page opened or refreshed): the list, and the active session's messages. */
export function loadSessions(): Promise<void> {
  return attempt(async () => {
    const [listing, agents] = await Promise.all([api<Listing>('/api/sessions'), api<AgentListing>('/api/agents')])
    applyAgents(agents)
    void loadToolCrud()
    apply(listing)
    await show(sessions.activeId)
  })
}

/** What each tool does, from the Tools catalog (best effort: without it, saved calls just have no pills). */
async function loadToolCrud(): Promise<void> {
  try {
    const { plugins } = await api<{ plugins: { name: string; tools: { name: string; crud: string[] }[] }[] }>('/api/tools')
    sessions.toolCrud = Object.fromEntries(plugins.flatMap((p) => p.tools.map((t) => [`${p.name}__${t.name}`, t.crud])))
  } catch {
    // the session still shows
  }
}

/** Re-read the agent files (they're edited by hand in the workspace). */
export const loadAgents = () =>
  attempt(async () => {
    applyAgents(await api<AgentListing>('/api/agents'))
  })

/** The agent of the session on screen (or of the new session about to start); '' = default. */
export function shownAgent(): string {
  if (sessions.shownId === null) return sessions.newAgent
  return sessions.list.find((s) => s.id === sessions.shownId)?.agent ?? ''
}

/** Switch the session on screen (or the new one) to another agent. */
export const setAgent = (agent: string) =>
  attempt(async () => {
    apply(
      sessions.shownId === null
        ? await api<Listing>('/api/sessions/new/agent', json('PUT', { agent }))
        : await api<Listing>(`/api/sessions/${encodeURIComponent(sessions.shownId)}`, json('PATCH', { agent })),
    )
  })

/** An agent's display name ('' or unknown = the default agent). */
/** After the Agents tab (or anything else) changed the agents. */
export function applyAgents(listing: AgentListing): void {
  sessions.agents = listing.agents
  sessions.defaultAgent = listing.defaultAgent
}

export function agentName(id: string): string {
  const resolved = id || sessions.defaultAgent
  return sessions.agents.find((a) => a.id === resolved)?.name ?? resolved
}

/**
 * Something changed on the server (a message was added, or a session was
 * renamed, switched, started or deleted, here or on another device).
 */
export function sessionsChanged(activeId: string | null): Promise<void> {
  return attempt(async () => {
    apply(await api<Listing>('/api/sessions'))
    if (activeId === sessions.shownId) return
    // A new session got its first message: that's the one on screen, keep the live transcript.
    const created = sessions.list.find((s) => s.id === activeId)?.created
    if (sessions.shownId === null && activeId && created && Date.parse(created) >= sessions.newSince - 1000) {
      sessions.shownId = activeId
      return
    }
    await show(activeId)
  })
}

export const openSession = (id: string) =>
  attempt(async () => {
    apply(await api<Listing>(`/api/sessions/${encodeURIComponent(id)}/activate`, json('POST')))
    await show(id)
  })

export const newSession = () =>
  attempt(async () => {
    apply(await api<Listing>('/api/sessions/new', json('POST')))
    await show(null)
  })

export const renameSession = (id: string, title: string) =>
  attempt(async () => apply(await api<Listing>(`/api/sessions/${encodeURIComponent(id)}`, json('PATCH', { title }))))

export const pinSession = (id: string, pinned: boolean) =>
  attempt(async () => apply(await api<Listing>(`/api/sessions/${encodeURIComponent(id)}`, json('PATCH', { pinned }))))

export const deleteSession = (id: string) =>
  attempt(async () => {
    apply(await api<Listing>(`/api/sessions/${encodeURIComponent(id)}`, json('DELETE')))
    if (sessions.shownId === id) await show(sessions.activeId)
  })

/** What a session is called in the list: its title, else its first request. */
export function sessionLabel(s: SessionSummary): string {
  return s.title || s.preview || 'New session'
}
