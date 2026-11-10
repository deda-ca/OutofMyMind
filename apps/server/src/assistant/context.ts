// How full the local model's context is, and with what: each request to it is
// broken into sections (the system prompt's parts, the tool definitions, the
// conversation, tool calls and results, the room and skill notes, the latest
// message), each counted exactly with llama-server's tokenizer. The server's
// own count of the prompt (usage.prompt_tokens) is the total; what the
// sections don't account for is the chat template's formatting.
//
// Updated after every request (each step of the tool loop is one); the client
// shows it as a meter (GET /api/context, and { type: "context" } on /api/stream).

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ChatTarget } from './llm.ts'

export interface ContextSection {
  key: string
  label: string
  tokens: number
  /** What it's made of (e.g. the system prompt's parts, the tools per plugin). */
  items?: { label: string; tokens: number }[]
}

export interface ContextStats {
  at: string
  model: string
  /** The model's context window (0 if unknown). */
  limit: number
  /** Tokens in the last prompt (the server's count when it gave one, else the sections' sum). */
  used: number
  /** Of those, reused from llama-server's cache (not processed again). */
  cached: number | null
  /** Tokens in the reply to it. */
  reply: number | null
  sections: ContextSection[]
}

interface Message {
  role: string
  content?: string | null
  tool_calls?: { function?: { name?: string; arguments?: string } }[]
}

type Part = { label: string; text: string }

const ROOM_NOTE = /^\((Room note|This request is about)/

class ContextMonitor extends EventEmitter<{ update: [ContextStats] }> {
  private last?: { target: ChatTarget; body: Record<string, unknown>; at: string; usage?: { prompt: number; cached: number | null; reply: number } }
  private stats?: ContextStats
  /** The system prompt's labelled parts, by its text (the assistant registers them as it builds it). */
  private systemParts = new Map<string, Part[]>()
  private tokenCache = new Map<string, number>()
  private limits = new Map<string, { limit: number; at: number }>()
  private pending?: Promise<void>

  /** The assistant says what the system prompt it just built is made of. */
  labelSystem(text: string, parts: Part[]): void {
    this.systemParts.set(text, parts)
    if (this.systemParts.size > 8) this.systemParts.delete(this.systemParts.keys().next().value!)
  }

  /** A request to the local model is about to be sent. */
  request(target: ChatTarget, body: Record<string, unknown>): void {
    if (target.brain !== 'local') return
    this.last = { target, body, at: new Date().toISOString() }
  }

  /** The end of its streamed reply: the server's own token counts. */
  usage(usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }): void {
    const last = this.last
    if (!last || typeof usage.prompt_tokens !== 'number') return
    last.usage = { prompt: usage.prompt_tokens, cached: usage.prompt_tokens_details?.cached_tokens ?? null, reply: usage.completion_tokens ?? 0 }
    // One analysis at a time; the latest request wins.
    this.pending = (this.pending ?? Promise.resolve()).then(() => this.analyze(last)).catch(() => {})
  }

  latest(): ContextStats | undefined {
    return this.stats
  }

  private async analyze(last: NonNullable<ContextMonitor['last']>): Promise<void> {
    if (last !== this.last) return // a newer request came in meanwhile
    const { target, body } = last
    const messages = (body.messages as Message[] | undefined) ?? []
    const tools = (body.tools as { function?: { name?: string } }[] | undefined) ?? []
    const count = (text: string) => this.count(target, text)

    const sections: ContextSection[] = []
    // The system prompt, by part when the assistant labelled it.
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    if (system) {
      const parts = this.systemParts.get(system) ?? [{ label: 'System prompt', text: system }]
      const items = await Promise.all(parts.map(async (p) => ({ label: p.label, tokens: await count(p.text) })))
      sections.push({ key: 'system', label: 'System prompt', tokens: sum(items), items })
    }
    // Tool definitions, per plugin ("files__read_text_file" → files).
    if (tools.length) {
      const byPlugin = new Map<string, unknown[]>()
      for (const t of tools) {
        const plugin = t.function?.name?.split('__')[0] ?? 'other'
        byPlugin.set(plugin, [...(byPlugin.get(plugin) ?? []), t])
      }
      const items = await Promise.all(
        [...byPlugin].map(async ([plugin, list]) => ({ label: `${plugin === 'jarvis' ? "Jarvis's own" : plugin} (${list.length})`, tokens: await count(JSON.stringify(list)) })),
      )
      sections.push({ key: 'tools', label: `Tool definitions (${tools.length})`, tokens: sum(items), items: items.sort((a, b) => b.tokens - a.tokens) })
    }
    // The conversation: history, tool calls and results, the notes, the latest message.
    const rest = messages.filter((m) => m.role !== 'system')
    const lastUser = rest.map((m) => m.role).lastIndexOf('user')
    const groups = { history: [] as string[], tools: [] as string[], notes: [] as string[], latest: [] as string[] }
    let historyMessages = 0
    let toolMessages = 0
    rest.forEach((m, i) => {
      const text = m.content ?? ''
      if (m.role === 'tool' || m.tool_calls?.length) {
        toolMessages++
        groups.tools.push(text, ...(m.tool_calls ?? []).map((c) => `${c.function?.name ?? ''} ${c.function?.arguments ?? ''}`))
      } else if (m.role === 'user' && ROOM_NOTE.test(text)) groups.notes.push(text)
      else if (i === lastUser) groups.latest.push(text)
      else {
        historyMessages++
        groups.history.push(text)
      }
    })
    const add = async (key: string, label: string, texts: string[]) => {
      if (texts.length) sections.push({ key, label, tokens: await count(texts.join('\n')) })
    }
    await add('history', `Conversation (${historyMessages} messages)`, groups.history)
    await add('toolcalls', `Tool calls & results (${toolMessages} messages)`, groups.tools)
    await add('notes', 'Room & skill notes', groups.notes)
    await add('latest', 'Latest message', groups.latest)

    const counted = sum(sections)
    const used = last.usage?.prompt ?? counted
    // The chat template's markup around every message and tool (and rounding between separate counts).
    if (used > counted) sections.push({ key: 'format', label: 'Chat formatting', tokens: used - counted })

    this.stats = {
      at: last.at,
      model: target.model,
      limit: await this.limit(target),
      used,
      cached: last.usage?.cached ?? null,
      reply: last.usage?.reply ?? null,
      sections,
    }
    this.emit('update', this.stats)
  }

  /** Tokens in a text, from llama-server's tokenizer (an estimate if it can't be reached). */
  private async count(target: ChatTarget, text: string): Promise<number> {
    if (!text) return 0
    const key = createHash('sha1').update(text).digest('hex')
    const cached = this.tokenCache.get(key)
    if (cached !== undefined) return cached
    let tokens: number
    try {
      const response = await fetch(new URL('/tokenize', target.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth(target) },
        body: JSON.stringify({ model: target.model, content: text }),
        signal: AbortSignal.timeout(5000),
      })
      tokens = ((await response.json()) as { tokens: unknown[] }).tokens.length
    } catch {
      tokens = Math.ceil(text.length / 3.5)
    }
    this.tokenCache.set(key, tokens)
    if (this.tokenCache.size > 500) this.tokenCache.delete(this.tokenCache.keys().next().value!)
    return tokens
  }

  /** The model's context window, from llama-server (/props, per model in router mode); re-read every 5 minutes. */
  async limit(target: ChatTarget): Promise<number> {
    const known = this.limits.get(target.model)
    if (known && Date.now() - known.at < 5 * 60_000) return known.limit
    let limit = known?.limit ?? 0
    try {
      const response = await fetch(new URL(`/props?model=${encodeURIComponent(target.model)}`, target.url), { headers: auth(target), signal: AbortSignal.timeout(5000) })
      const n = ((await response.json()) as { default_generation_settings?: { n_ctx?: number } }).default_generation_settings?.n_ctx
      if (typeof n === 'number' && n > 0) limit = n
    } catch {
      // keep what we had
    }
    this.limits.set(target.model, { limit, at: Date.now() })
    return limit
  }
}

/** The LLM server's API key, if it has one (llama-server --api-key also guards /tokenize and /props). */
function auth(target: ChatTarget): Record<string, string> {
  return target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}
}

function sum(items: { tokens: number }[]): number {
  return items.reduce((n, i) => n + i.tokens, 0)
}

export const contextMonitor = new ContextMonitor()
