// Streaming chat completions from an OpenAI-compatible server: llama.cpp's
// llama-server (the local LLM), or any service that speaks the same API; and
// Claude through anthropic.ts, which answers in the same streamed form, so
// the tool loop and everything else don't need to know which it is.
// Which connection and model: the agent's (assistant/models.ts).

import { postAnthropic } from './anthropic.ts'
import { contextMonitor } from './context.ts'
import { llmTap, teeBody, traceHeaders } from './llmTap.ts'
import { defaultRef, resolve } from './models.ts'
import { type Price, usageLog } from './usage.ts'
import { attachImages } from './vision.ts'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatTarget {
  url: string
  model: string
  apiKey?: string
  /** Extra request fields (e.g. llama.cpp's chat_template_kwargs). */
  extra?: Record<string, unknown>
  /** openai: an OpenAI-compatible host; anthropic: Claude (anthropic.ts). Default openai. */
  kind?: 'openai' | 'anthropic'
  /** The connection's id (llm.connections). */
  connection?: string
  /** Its models see images: the owner's photos are sent as images (vision.ts). */
  vision?: boolean
  /** A llama.cpp server (token counter, context size, no-thinking flag). */
  llamaCpp?: boolean
  /** anthropic: how hard Claude thinks. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  contextWindow?: number
  /** Its prices and daily budget (usage.ts). */
  prices?: Record<string, Price>
  budget?: number
}

/** The target's API key as an Authorization header (none if it has no key). */
export function authHeader(target: Pick<ChatTarget, 'apiKey'>): Record<string, string> {
  return target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}
}

const warned = new Set<string>()

/** Where to send a request: the agent's "connection/model" (agent.model), or the default. */
export function chatTarget(agent?: { model?: string } | null): ChatTarget {
  let { connection: c, model, note } = resolve(agent?.model)
  // Today's budget on that connection spent: the default model instead (unless that's the one).
  if (c.budget !== undefined && usageLog.spentToday(c.id) >= c.budget) {
    const fallback = resolve(defaultRef())
    if (fallback.connection.id !== c.id) {
      note = `${c.id}'s daily budget (${c.budget} dollars) is spent: using ${fallback.connection.id}/${fallback.model} until tomorrow`
      ;({ connection: c, model } = fallback)
    }
  }
  if (note && !warned.has(note)) {
    warned.add(note)
    console.warn(`llm: ${note}`)
  }
  return {
    kind: c.kind,
    connection: c.id,
    url: c.url,
    model,
    ...(c.apiKey ? { apiKey: c.apiKey } : {}),
    vision: c.vision,
    llamaCpp: c.llamaCpp,
    ...(c.effort ? { effort: c.effort } : {}),
    ...(c.contextWindow ? { contextWindow: c.contextWindow } : {}),
    ...(c.prices ? { prices: c.prices } : {}),
    ...(c.budget !== undefined ? { budget: c.budget } : {}),
    // llama.cpp: thinking off (for spoken conversation a fast short answer beats a slow considered one: 0.3 s vs 1.3 s+ measured).
    extra: { ...(c.llamaCpp ? { chat_template_kwargs: { enable_thinking: false } } : {}), ...c.extra },
  }
}

/** A tool call the agent is making, shown while it works. */
export interface AgentEvent {
  kind: 'tool'
  label: string
  emoji?: string
  status?: string
  /** Sent when it starts (status "running") and again when it's done. */
  call?: ToolCallDetail
}

/** One tool call, for the client's tool-call pills and their details. */
export interface ToolCallDetail {
  /** The LLM's id for the call (matches the running and done events). */
  id: string
  /** The function name, e.g. "files__edit_file". */
  name: string
  /** The arguments, as JSON text. */
  args: string
  /** What it does: create / read / update / delete. */
  crud: string[]
  status: 'running' | 'done'
  /** When done: what came back (cut for length), whether it failed, how long it took. */
  result?: string
  isError?: boolean
  durationMs?: number
}

export class LlmError extends Error {
  /** The server couldn't be reached or refused us (vs. failing mid-answer). */
  readonly unreachable: boolean
  constructor(message: string, unreachable = false) {
    super(message)
    this.unreachable = unreachable
  }
}

/**
 * Sends a streaming chat-completions request. Throws an LlmError if the server
 * can't be reached or answers with an error.
 */
export async function postChat(target: ChatTarget, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const name = 'the LLM'
  const url = new URL('/v1/chat/completions', target.url)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeader(target),
  }
  // max_tokens: a cap, not a target (spoken replies stay short); room for a tool call that writes a file.
  // Only for llama.cpp, with its temperature: OpenAI's newer models refuse both (an agent's temperature still goes).
  const json = {
    model: target.model,
    stream: true,
    ...(target.llamaCpp !== false && target.kind !== 'anthropic' ? { max_tokens: 8192, temperature: 0.7 } : {}),
    // The stream then ends with the token counts (for the context meter).
    stream_options: { include_usage: true },
    ...target.extra,
    ...body,
  }
  contextMonitor.request(target, json)
  if (target.kind === 'anthropic') return owned(await postAnthropic(target, json, signal), target)

  // The Debug tab: a copy of the exchange, only while a client is watching.
  const traceId = llmTap.active ? llmTap.id() : 0
  const sentAt = performance.now()
  const traceResponse = (status: number, responseHeaders: Record<string, string>, raw: string, firstByteAt: number | null, ended?: string) => {
    if (!traceId) return
    const now = performance.now()
    llmTap.emit('response', {
      id: traceId,
      at: new Date().toISOString(),
      status,
      headers: responseHeaders,
      raw,
      firstByteMs: firstByteAt === null ? null : Math.round(firstByteAt - sentAt),
      durationMs: Math.round(now - sentAt),
      ...(ended ? { ended } : {}),
    })
  }
  if (traceId) {
    llmTap.emit('request', { id: traceId, at: new Date().toISOString(), model: target.model, method: 'POST', url: url.href, headers: traceHeaders(headers), body: json })
  }

  let response: Response
  try {
    // Images the owner added go as images (vision.ts); the trace above keeps the readable text.
    // Claude's own reply blocks ("raw", anthropic.ts) stay out: they mean nothing to another provider.
    const given = (json as { messages?: unknown }).messages
    const messages = Array.isArray(given) ? (given as { role: string; content?: unknown; raw?: unknown }[]).map(({ raw: _raw, ...m }) => m) : given
    const plain = Array.isArray(messages) ? { ...json, messages } : json
    const sent = target.vision && Array.isArray(messages) ? { ...json, messages: attachImages(messages) } : plain
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(sent), signal })
  } catch (err) {
    traceResponse(0, {}, '', null, signal?.aborted ? 'aborted' : (err as Error).message)
    if (signal?.aborted) throw err
    throw new LlmError(`Could not reach ${name} at ${target.url}: ${(err as Error).message}`, true)
  }
  if (traceId && response.ok && response.body) {
    const responseHeaders = traceHeaders(response.headers)
    const status = response.status
    response = new Response(
      teeBody(response.body, signal, (raw, firstByteAt, ended) => traceResponse(status, responseHeaders, raw, firstByteAt, ended)),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    )
  }
  if (!response.ok || !response.body) {
    const fullDetail = await response.text().catch(() => '')
    traceResponse(response.status, traceHeaders(response.headers), fullDetail, null)
    const detail = fullDetail.slice(0, 300)
    throw new LlmError(`${name} returned HTTP ${response.status}: ${detail}`, response.status === 401 || response.status === 403 || response.status === 404)
  }
  return owned(response, target)
}

/** Which target a response body came from: its usage is counted for it (readSse). */
const owners = new WeakMap<ReadableStream<Uint8Array>, ChatTarget>()
function owned(response: Response, target: ChatTarget): Response {
  if (response.body) owners.set(response.body, target)
  return response
}

type UsageChunk = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number } }

/** The server-sent events of a streaming response, until `[DONE]`. `event` is '' for plain data lines. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const target = owners.get(body)
  let buffer = ''
  let event = ''
  const decoder = new TextDecoder()
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line === '') {
        event = '' // a blank line ends an SSE event
        continue
      }
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
        continue
      }
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        if (parsed.usage && typeof parsed.usage === 'object') {
          const u = parsed.usage as UsageChunk
          contextMonitor.usage(u)
          if (target) {
            usageLog.record(target, {
              input: u.prompt_tokens ?? 0,
              cached: u.prompt_tokens_details?.cached_tokens ?? 0,
              cacheWrite: u.prompt_tokens_details?.cache_creation_tokens ?? 0,
              output: u.completion_tokens ?? 0,
            })
          }
        }
        yield { event, data: parsed }
      } catch {
        // keep-alive or malformed
      }
    }
  }
}

/** Streams a reply, calling `onDelta` with each piece of text as it arrives. Returns the full reply. */
export async function streamChat(target: ChatTarget, messages: ChatMessage[], onDelta: (text: string) => void, signal?: AbortSignal): Promise<string> {
  const response = await postChat(target, { messages }, signal)
  let full = ''
  for await (const { event, data: parsed } of readSse(response.body!)) {
    if (event) continue // named events: not part of the text
    const delta = (parsed as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content
    if (delta) {
      full += delta
      onDelta(delta)
    }
  }
  return full
}
