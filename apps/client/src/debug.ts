// The Debug tab: every request to an LLM and its response, as the server sent
// and received them (server: apps/server/src/assistant/llmTap.ts). Kept in
// memory only, newest last, until cleared or the page is reloaded.

import { ref, shallowRef, watch } from 'vue'

export interface LlmRequestTrace {
  id: number
  at: string
  model: string
  method: string
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export interface LlmResponseTrace {
  id: number
  at: string
  status: number
  headers: Record<string, string>
  raw: string
  firstByteMs: number | null
  durationMs: number
  ended?: string
}

export type DebugMessage = ({ type: 'debug.llm.request' } & LlmRequestTrace) | ({ type: 'debug.llm.response' } & LlmResponseTrace)

export interface Exchange {
  id: number
  request: LlmRequestTrace
  response?: LlmResponseTrace
}

/** How many exchanges are kept (each can be tens of KB). */
const MAX_EXCHANGES = 100
const STORAGE_KEY = 'jarvis.debug'

function saved(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

/** Whether the server sends the traffic (this browser remembers the switch, not the traffic). */
export const debugEnabled = ref(saved())
watch(debugEnabled, (on) => {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // private window: fine, it just isn't remembered
  }
})

/** Replaced (not mutated) on every change: the bodies are big, so they're never made deeply reactive. */
export const exchanges = shallowRef<Exchange[]>([])

export function onDebugMessage(message: DebugMessage): void {
  const { type, ...trace } = message
  if (type === 'debug.llm.request') {
    exchanges.value = [...exchanges.value, { id: trace.id, request: trace as LlmRequestTrace }].slice(-MAX_EXCHANGES)
  } else {
    exchanges.value = exchanges.value.map((e) => (e.id === trace.id ? { ...e, response: trace as LlmResponseTrace } : e))
  }
}

export function clearExchanges(): void {
  exchanges.value = []
}

export interface ParsedResponse {
  /** The reply text, put together from the streamed pieces. */
  text: string
  /** Tool calls, put together from the streamed pieces. */
  toolCalls: { name: string; arguments: string }[]
  finishReason?: string
  usage?: Record<string, unknown>
  /** Named server-sent events, if the server sends any. */
  events: string[]
  chunks: number
}

/** What a streamed (SSE) chat-completions response adds up to. */
export function parseSse(raw: string): ParsedResponse {
  const out: ParsedResponse = { text: '', toolCalls: [], events: [], chunks: 0 }
  const calls = new Map<number, { name: string; arguments: string }>()
  let event = ''
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      event = ''
      continue
    }
    if (trimmed.startsWith('event:')) {
      event = trimmed.slice(6).trim()
      continue
    }
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (data === '[DONE]') continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }
    out.chunks++
    if (event) {
      out.events.push(`${event}: ${data}`)
      continue
    }
    const choice = (parsed.choices as { delta?: Record<string, unknown>; finish_reason?: string | null }[] | undefined)?.[0]
    if (parsed.usage) out.usage = parsed.usage as Record<string, unknown>
    if (!choice) continue
    if (choice.finish_reason) out.finishReason = choice.finish_reason
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string') out.text += delta.content
    for (const call of (delta.tool_calls as { index?: number; function?: { name?: string; arguments?: string } }[] | undefined) ?? []) {
      const index = call.index ?? 0
      const entry = calls.get(index) ?? { name: '', arguments: '' }
      if (call.function?.name) entry.name += call.function.name
      if (call.function?.arguments) entry.arguments += call.function.arguments
      calls.set(index, entry)
    }
  }
  out.toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c)
  return out
}
