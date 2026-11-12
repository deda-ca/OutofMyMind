// Claude through Anthropic's Messages API, for an "anthropic" connection
// (llm.connections). The rest of Jarvis speaks the OpenAI chat format, so
// this turns the request into Anthropic's and the streamed answer back into
// OpenAI-style chunks: postChat's callers (the tool loop, streamChat) read it
// as they read llama.cpp.
//
//   system messages at the start   → the system prompt; later ones → a note in the user's turn
//   images (data: URLs)            → image blocks
//   tool_calls / tool results      → tool_use / tool_result blocks
//
// Claude's own reply blocks (with its thinking, which must go back unchanged
// while it's using tools) come at the end of the stream as {jarvis_raw}; the
// loop keeps them on the assistant message ("raw") and they're sent back as
// they were, for the same model.

import Anthropic from '@anthropic-ai/sdk'
import type { ChatTarget } from './llm.ts'
import { LlmError } from './llm.ts'
import { llmTap, traceHeaders } from './llmTap.ts'
import { attachImages } from './vision.ts'

/** What's used of the SDK client (a fake in tests). */
export interface ClaudeClient {
  beta: { messages: { stream(params: Record<string, unknown>, options?: { signal?: AbortSignal }): ClaudeStream } }
}
export interface ClaudeStream extends AsyncIterable<Record<string, unknown>> {
  finalMessage(): Promise<ClaudeMessage>
}
export interface ClaudeMessage {
  model?: string
  content: Record<string, unknown>[]
  stop_reason?: string | null
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
}

/** Claude's reply blocks as kept on an assistant message, with the model they're for. */
export interface RawReply {
  model: string
  content: Record<string, unknown>[]
}

const clients = new Map<string, ClaudeClient>()
let makeClient = (target: ChatTarget): ClaudeClient => new Anthropic({ apiKey: target.apiKey ?? null, baseURL: target.url, maxRetries: 2 }) as unknown as ClaudeClient

/** Tests: use this client instead of Anthropic's (null: back to the real one). */
export function setClaudeClient(client: ClaudeClient | null): void {
  clients.clear()
  makeClient = client ? () => client : (target) => new Anthropic({ apiKey: target.apiKey ?? null, baseURL: target.url, maxRetries: 2 }) as unknown as ClaudeClient
}

function client(target: ChatTarget): ClaudeClient {
  const key = `${target.url}\n${target.apiKey ?? ''}`
  let c = clients.get(key)
  if (!c) clients.set(key, (c = makeClient(target)))
  return c
}

/** A cap, not a target: spoken replies stay short, but a tool call may write a whole file. */
const MAX_TOKENS = 32_000
/** Models that can be retried on another model server-side when they decline (server-side fallback). */
const FALLBACK = /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/

type Block = Record<string, unknown>
interface OpenAiMessage {
  role: string
  content?: unknown
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  raw?: RawReply
}

/** The OpenAI-format request as Anthropic's (exported for tests). */
export function toClaude(target: ChatTarget, body: Record<string, unknown>): Record<string, unknown> {
  const tools = Array.isArray(body.tools) ? (body.tools as { function: { name: string; description?: string; parameters?: Record<string, unknown> } }[]) : []
  const all = (Array.isArray(body.messages) ? body.messages : []) as OpenAiMessage[]
  const messages = target.vision ? attachImages(all) : all
  // A request without tools can't carry tool_use blocks: then they go as text.
  const asText = tools.length === 0
  const system: string[] = []
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = []
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) return
    const last = out.at(-1)
    if (last?.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  const names = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'system') {
      const text = textOf(m.content)
      if (!text) continue
      if (out.length === 0) system.push(text)
      else push('user', [{ type: 'text', text: `(Note from the system: ${text})` }])
    } else if (m.role === 'user') {
      push('user', userBlocks(m.content))
    } else if (m.role === 'assistant') {
      for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name)
      const raw = m.raw && m.raw.model === target.model && !asText ? m.raw.content : null
      if (raw) {
        push('assistant', raw.map((b) => ({ ...b })))
        continue
      }
      const blocks: Block[] = []
      const text = textOf(m.content)
      if (text.trim()) blocks.push({ type: 'text', text })
      for (const c of m.tool_calls ?? []) {
        if (asText) blocks.push({ type: 'text', text: `[called ${c.function.name} with ${c.function.arguments || '{}'}]` })
        else blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) })
      }
      push('assistant', blocks)
    } else if (m.role === 'tool') {
      const text = textOf(m.content)
      const isError = text.startsWith('Error: ')
      if (asText) push('user', [{ type: 'text', text: `[${names.get(m.tool_call_id ?? '') ?? 'tool'} result: ${text}]` }])
      else push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: text || '(no output)', ...(isError ? { is_error: true } : {}) }])
    }
  }
  // Claude's turn comes after the owner's: a conversation can't start with its own words.
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(The conversation so far.)' }] })

  const choice = body.tool_choice
  return {
    model: target.model,
    max_tokens: MAX_TOKENS,
    ...(system.length ? { system: system.join('\n\n') } : {}),
    messages: out,
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            name: t.function.name,
            description: t.function.description ?? '',
            input_schema: { type: 'object', ...(t.function.parameters ?? {}) },
            // Long arguments (a whole file) stream as they're written, not in one burst at the end.
            eager_input_streaming: true,
          })),
          ...(choice === 'none' ? { tool_choice: { type: 'none' } } : {}),
        }
      : {}),
    // The system prompt, tools and history so far are cached: each turn pays only for what's new.
    cache_control: { type: 'ephemeral' },
    ...(target.effort ? { output_config: { effort: target.effort } } : {}),
    ...(FALLBACK.test(target.model) ? { fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] } : {}),
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: 'text'; text: string } => (p as { type?: string }).type === 'text')
      .map((p) => p.text)
      .join('\n')
  }
  return ''
}

function userBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks: Block[] = []
  for (const p of content as { type?: string; text?: string; image_url?: { url?: string } }[]) {
    if (p.type === 'text' && p.text?.trim()) blocks.push({ type: 'text', text: p.text })
    if (p.type === 'image_url' && p.image_url?.url) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url.url)
      blocks.push(m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'url', url: p.image_url.url } })
    }
  }
  return blocks
}

function parseArgs(text: string): Record<string, unknown> {
  try {
    const v = text.trim() ? (JSON.parse(text) as unknown) : {}
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Without images' data, for the Debug tab. */
function readable(params: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(params, (k, v) => (k === 'data' && typeof v === 'string' && v.length > 200 ? `(${v.length} characters of image)` : v))) as Record<string, unknown>
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof Anthropic.APIConnectionError) return new LlmError(`Could not reach Claude: ${err.message}`, true)
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0
    return new LlmError(`Claude returned HTTP ${status}: ${err.message.slice(0, 300)}`, status === 401 || status === 403 || status === 404)
  }
  return err instanceof LlmError ? err : new LlmError(`Claude: ${(err as Error).message}`)
}

/** Sends the request to Claude; the answer streams back as OpenAI-style server-sent events. */
export async function postAnthropic(target: ChatTarget, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  if (!target.apiKey) throw new LlmError(`The connection "${target.connection ?? 'anthropic'}" has no apiKey (llm.connections in config.jsonc)`, true)
  const params = toClaude(target, body)
  const traceId = llmTap.active ? llmTap.id() : 0
  const sentAt = performance.now()
  let firstAt: number | null = null
  let sse = ''
  const trace = (status: number, ended?: string) => {
    if (!traceId) return
    llmTap.emit('response', {
      id: traceId,
      at: new Date().toISOString(),
      status,
      headers: {},
      raw: sse,
      firstByteMs: firstAt === null ? null : Math.round(firstAt - sentAt),
      durationMs: Math.round(performance.now() - sentAt),
      ...(ended ? { ended } : {}),
    })
  }
  if (traceId) {
    const url = new URL('/v1/messages', target.url).href
    llmTap.emit('request', { id: traceId, at: new Date().toISOString(), model: target.model, method: 'POST', url, headers: traceHeaders({ 'x-api-key': target.apiKey }), body: readable(params) })
  }

  const stream = client(target).beta.messages.stream(params, { signal })
  const events = stream[Symbol.asyncIterator]()
  // The first event: so an unreachable server or a refused key is an error here, as with postChat.
  let first: IteratorResult<Record<string, unknown>>
  try {
    first = await events.next()
  } catch (err) {
    sse = String((err as Error).message ?? err)
    trace(0, signal?.aborted ? 'aborted' : sse)
    if (signal?.aborted) throw err
    throw toLlmError(err)
  }
  firstAt = performance.now()

  const encoder = new TextEncoder()
  const body$ = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (data: unknown) => {
        const line = `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
        if (traceId) sse += line
        controller.enqueue(encoder.encode(line))
      }
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => send({ choices: [{ index: 0, delta, finish_reason: finish }] })
      const toolIndex = new Map<number, number>()
      let said = false
      try {
        for (let r = first; !r.done; r = await events.next()) {
          const e = r.value
          if (e.type === 'content_block_start') {
            const block = e.content_block as Block
            if (block.type === 'tool_use') {
              const i = toolIndex.size
              toolIndex.set(e.index as number, i)
              chunk({ tool_calls: [{ index: i, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] })
            }
          } else if (e.type === 'content_block_delta') {
            const d = e.delta as Block
            if (d.type === 'text_delta' && d.text) {
              said = true
              chunk({ content: d.text })
            } else if (d.type === 'input_json_delta' && d.partial_json) {
              const i = toolIndex.get(e.index as number)
              if (i !== undefined) chunk({ tool_calls: [{ index: i, function: { arguments: d.partial_json } }] })
            }
          }
        }
        const final = await stream.finalMessage()
        if (final.stop_reason === 'refusal' && !said) chunk({ content: "Sorry, I can't help with that one." })
        const finish = final.stop_reason === 'tool_use' ? 'tool_calls' : final.stop_reason === 'max_tokens' ? 'length' : 'stop'
        chunk({}, finish)
        const u = final.usage ?? {}
        const cached = u.cache_read_input_tokens ?? 0
        const prompt = (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0)
        send({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: u.output_tokens ?? 0, total_tokens: prompt + (u.output_tokens ?? 0), prompt_tokens_details: { cached_tokens: cached } } })
        // Claude's own blocks (thinking included), to go back unchanged on the next step.
        send({ jarvis_raw: { model: target.model, content: final.content } satisfies RawReply })
        send('[DONE]')
        trace(200)
        controller.close()
      } catch (err) {
        trace(200, signal?.aborted ? 'aborted' : (err as Error).message)
        controller.error(signal?.aborted ? err : toLlmError(err))
      }
    },
  })
  return new Response(body$, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
