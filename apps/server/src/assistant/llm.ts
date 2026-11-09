// Streaming chat completions from an OpenAI-compatible server: llama.cpp's
// llama-server (the local LLM) or Nous Hermes Agent's API server (the agent,
// with tools). Hermes adds named SSE events for tool progress and approvals.

import { config } from '../config.ts'
import { HERMES_SESSION_KEY, hermesSessionId } from './hermesSession.ts'
import { llmTap, teeBody, traceHeaders } from './llmTap.ts'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type Brain = 'local' | 'hermes'

export interface ChatTarget {
  brain: Brain
  url: string
  model: string
  apiKey?: string
  /**
   * Hermes: the session Jarvis talks in (X-Hermes-Session-Id). Hermes then
   * keeps the conversation and loads its history itself, so only the system
   * prompt and the new message are sent. Needs the API key.
   */
  sessionId?: string
  /** Extra request fields (e.g. llama.cpp's chat_template_kwargs). */
  extra?: Record<string, unknown>
}

export function chatTarget(brain: Brain): ChatTarget {
  if (brain === 'hermes') {
    // Session continuity requires API-key auth on Hermes's side.
    const sessionId = config.hermesApiKey ? hermesSessionId() : undefined
    return { brain, url: config.hermesUrl, model: config.hermesModel, apiKey: config.hermesApiKey, sessionId }
  }
  // Thinking off: for spoken conversation a fast short answer beats a slow considered one (0.3 s vs 1.3 s+ measured).
  return { brain, url: config.llmUrl, model: config.llmModel, extra: { chat_template_kwargs: { enable_thinking: false } } }
}

/** Something the agent is doing, shown (not spoken) while it works. */
export interface AgentEvent {
  kind: 'tool' | 'approval'
  label: string
  emoji?: string
  status?: string
  /** A harness tool call: sent when it starts (status "running") and again when it's done. */
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
  /** Hermes no longer has the session we named (deleted there): start a new one. */
  readonly sessionGone: boolean
  constructor(message: string, unreachable = false, sessionGone = false) {
    super(message)
    this.unreachable = unreachable
    this.sessionGone = sessionGone
  }
}

/**
 * Sends a streaming chat-completions request. Throws an LlmError if the server
 * can't be reached or answers with an error.
 */
export async function postChat(target: ChatTarget, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const name = target.brain === 'hermes' ? 'Hermes' : 'the LLM'
  const url = new URL('/v1/chat/completions', target.url)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
    ...(target.sessionId ? { 'X-Hermes-Session-Id': target.sessionId, 'X-Hermes-Session-Key': HERMES_SESSION_KEY } : {}),
  }
  // max_tokens: a cap, not a target (spoken replies stay short); room for a tool call that writes a file.
  const json = { model: target.model, stream: true, max_tokens: 8192, temperature: 0.7, ...target.extra, ...body }

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
    llmTap.emit('request', { id: traceId, at: new Date().toISOString(), brain: target.brain, model: target.model, method: 'POST', url: url.href, headers: traceHeaders(headers), body: json })
  }

  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(json), signal })
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
    const sessionGone = !!target.sessionId && response.status === 404 && /not_found/.test(detail)
    throw new LlmError(
      `${name} returned HTTP ${response.status}: ${detail}`,
      response.status === 401 || response.status === 403 || response.status === 404,
      sessionGone,
    )
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
        yield { event, data: JSON.parse(data) as Record<string, unknown> }
      } catch {
        // keep-alive or malformed
      }
    }
  }
}

/**
 * Streams a reply, calling `onDelta` with each piece of text as it arrives
 * (and `onEvent` for agent tool progress). Returns the full reply.
 */
export async function streamChat(
  target: ChatTarget,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  onEvent?: (event: AgentEvent) => void,
): Promise<string> {
  const response = await postChat(target, { messages }, signal)
  let full = ''
  for await (const { event, data: parsed } of readSse(response.body!)) {
    if (event === 'hermes.tool.progress') {
      if (parsed.status === 'running') onEvent?.({ kind: 'tool', label: String(parsed.label ?? parsed.tool ?? 'working'), emoji: parsed.emoji as string | undefined, status: 'running' })
      continue
    }
    if (event === 'approval.request') {
      onEvent?.({ kind: 'approval', label: String(parsed.description ?? parsed.command ?? parsed.tool ?? 'an action'), status: 'waiting' })
      continue
    }
    if (event) continue // other named events (status, …)
    const delta = (parsed as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content
    if (delta) {
      full += delta
      onDelta(delta)
    }
  }
  return full
}
