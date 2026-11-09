// A live copy of every request to an LLM and its response, exactly as sent
// and received over HTTP, for the client's Debug tab. Nothing is stored: a
// connected client with debug on listens, and everything else costs nothing
// (postChat only copies traffic while someone is listening).

import { EventEmitter } from 'node:events'

export interface LlmRequestTrace {
  id: number
  at: string
  brain: string
  model: string
  method: 'POST'
  url: string
  /** API keys are masked. */
  headers: Record<string, string>
  /** The JSON body as sent. */
  body: Record<string, unknown>
}

export interface LlmResponseTrace {
  id: number
  at: string
  /** 0 if the server couldn't be reached. */
  status: number
  headers: Record<string, string>
  /** The body as received: for streaming replies, the raw server-sent events. */
  raw: string
  /** Request sent to first byte of the response body. */
  firstByteMs: number | null
  durationMs: number
  /** How it ended, if not normally: "aborted" (a newer request took over), "cancelled", or a network error. */
  ended?: string
}

class LlmTap extends EventEmitter<{ request: [LlmRequestTrace]; response: [LlmResponseTrace] }> {
  private nextId = 1

  get active(): boolean {
    return this.listenerCount('request') > 0 || this.listenerCount('response') > 0
  }

  id(): number {
    return this.nextId++
  }
}

export const llmTap = new LlmTap()

/** Headers as a plain object, with credentials masked. */
export function traceHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers)
  for (const [key, value] of entries) {
    out[key] = /^(authorization|x-api-key|api-key|cookie)$/i.test(key) ? `${value.slice(0, 10)}… (hidden)` : value
  }
  return out
}

/**
 * Passes a response body through unchanged, keeping a copy of the text.
 * `done` is called once: at the end of the stream, when the reader stops
 * early (the SSE reader returns at "[DONE]"), or on abort.
 */
export function teeBody(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined, done: (raw: string, firstByteAt: number | null, ended?: string) => void): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let raw = ''
  let firstByteAt: number | null = null
  let finished = false
  const finish = (ended?: string) => {
    if (finished) return
    finished = true
    done(raw + decoder.decode(), firstByteAt, ended)
  }
  signal?.addEventListener('abort', () => finish('aborted'), { once: true })
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        firstByteAt ??= performance.now()
        raw += decoder.decode(chunk, { stream: true })
        controller.enqueue(chunk)
        if (/\ndata: \[DONE\]\s*$/.test(raw) || raw.startsWith('data: [DONE]')) finish()
      },
      flush: () => finish(),
      cancel: () => finish('cancelled'),
    }),
  )
}
