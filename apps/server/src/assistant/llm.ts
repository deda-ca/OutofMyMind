// Streaming chat completions from an OpenAI-compatible server: llama.cpp's
// llama-server (the local LLM) or Nous Hermes Agent's API server (the agent,
// with tools). Hermes adds named SSE events for tool progress and approvals.

import { config } from '../config.ts'
import { HERMES_SESSION_KEY, hermesSessionId } from './hermesSession.ts'

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
  const name = target.brain === 'hermes' ? 'Hermes' : 'the LLM'
  let response: Response
  try {
    response = await fetch(new URL('/v1/chat/completions', target.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
        ...(target.sessionId ? { 'X-Hermes-Session-Id': target.sessionId, 'X-Hermes-Session-Key': HERMES_SESSION_KEY } : {}),
      },
      body: JSON.stringify({ model: target.model, messages, stream: true, max_tokens: 1024, temperature: 0.7, ...target.extra }),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new LlmError(`Could not reach ${name} at ${target.url}: ${(err as Error).message}`, true)
  }
  if (!response.ok || !response.body) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    const sessionGone = !!target.sessionId && response.status === 404 && /not_found/.test(detail)
    throw new LlmError(
      `${name} returned HTTP ${response.status}: ${detail}`,
      response.status === 401 || response.status === 403 || response.status === 404,
      sessionGone,
    )
  }

  let full = ''
  let buffer = ''
  let event = ''
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
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
      if (data === '[DONE]') return full
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(data) as Record<string, unknown>
      } catch {
        continue // keep-alive or malformed
      }
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
  }
  return full
}
