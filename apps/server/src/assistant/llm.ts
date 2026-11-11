// Streaming chat completions from an OpenAI-compatible server: llama.cpp's
// llama-server (the local LLM), or any service that speaks the same API.

import { config } from '../config.ts'
import { contextMonitor } from './context.ts'
import { llmTap, teeBody, traceHeaders } from './llmTap.ts'
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
}

/** The target's API key as an Authorization header (none if it has no key). */
export function authHeader(target: Pick<ChatTarget, 'apiKey'>): Record<string, string> {
  return target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}
}

/** The LLM Jarvis answers with (LLM_URL, LLM_MODEL, LLM_API_KEY). */
export function chatTarget(): ChatTarget {
  // Thinking off: for spoken conversation a fast short answer beats a slow considered one (0.3 s vs 1.3 s+ measured).
  return { url: config.llmUrl, model: config.llmModel, apiKey: config.llmApiKey, extra: { chat_template_kwargs: { enable_thinking: false } } }
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
  const json = {
    model: target.model,
    stream: true,
    max_tokens: 8192,
    temperature: 0.7,
    // llama-server then ends the stream with its token counts (for the context meter).
    stream_options: { include_usage: true },
    ...target.extra,
    ...body,
  }
  contextMonitor.request(target, json)

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
    const messages = (json as { messages?: unknown }).messages
    const sent = config.llmVision && Array.isArray(messages) ? { ...json, messages: attachImages(messages as { role: string; content?: unknown }[]) } : json
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
  return response
}

/** The server-sent events of a streaming response, until `[DONE]`. `event` is '' for plain data lines. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
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
        if (parsed.usage && typeof parsed.usage === 'object') contextMonitor.usage(parsed.usage as Parameters<typeof contextMonitor.usage>[0])
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
