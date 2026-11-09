// The harness loop: ask the LLM, run the tools it calls (through MCP plugins),
// give it the results, and repeat until it answers in words.
//
// Text is streamed as it comes (so Jarvis can start speaking "Let me check."
// while a tool runs). The last allowed step is sent without tools, so the
// loop always ends with an answer.

import { postChat, readSse, type AgentEvent, type ChatMessage, type ChatTarget } from '../assistant/llm.ts'
import type { FunctionTool, ToolOutcome } from './mcp.ts'

/** What the loop needs from the plugins (McpHub, or a fake in tests). */
export interface ToolHost {
  tools(): FunctionTool[]
  label(name: string): string
  /** What a tool does (create / read / update / delete), for the client. */
  crud?(name: string): string[]
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome>
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type LoopMessage =
  | ChatMessage
  | { role: 'assistant'; content: string | null; tool_calls: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface LoopOptions {
  /** Most LLM calls per request (tool rounds + the final answer). */
  maxSteps?: number
  signal?: AbortSignal
  onDelta: (text: string) => void
  onEvent?: (event: AgentEvent) => void
}

export interface LoopResult {
  /** Everything the assistant said, across all steps. */
  text: string
  /**
   * The tool calls and their results, in order (without the final answer).
   * Kept in the conversation history, so the model can see next turn what it
   * really did; otherwise it sees only its own "I've saved it" and learns to
   * claim actions without calling the tools.
   */
  steps: LoopMessage[]
}

export const DEFAULT_MAX_STEPS = 6
/** Longest tool result sent to the client with a tool-call event. */
const EVENT_RESULT_CHARS = 4000

export async function runLoop(target: ChatTarget, messages: LoopMessage[], host: ToolHost, options: LoopOptions): Promise<LoopResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const transcript: LoopMessage[] = [...messages]
  let said = ''
  let stepText = ''
  // Text from separate steps is joined with a space ("Let me look." + "You have two notes.").
  const onDelta = (delta: string) => {
    if (said !== '' && stepText === '' && !/\s$/.test(said) && !/^\s/.test(delta)) {
      said += ' '
      options.onDelta(' ')
    }
    stepText += delta
    said += delta
    options.onDelta(delta)
  }
  for (let step = 1; step <= maxSteps; step++) {
    stepText = ''
    const tools = step < maxSteps ? host.tools() : []
    const calls = await streamStep(target, transcript, tools, onDelta, options.signal)
    if (calls.length === 0) break
    transcript.push({ role: 'assistant', content: stepText || null, tool_calls: calls })
    for (const call of calls) {
      const label = host.label(call.function.name)
      const detail = { id: call.id, name: call.function.name, args: call.function.arguments, crud: host.crud?.(call.function.name) ?? [] }
      options.onEvent?.({ kind: 'tool', label, emoji: '🔧', status: 'running', call: { ...detail, status: 'running' } })
      const started = performance.now()
      const outcome = await runCall(host, call, options.signal)
      options.onEvent?.({
        kind: 'tool',
        label,
        emoji: '🔧',
        status: 'done',
        call: {
          ...detail,
          status: 'done',
          result: outcome.text.length > EVENT_RESULT_CHARS ? `${outcome.text.slice(0, EVENT_RESULT_CHARS)}\n… (cut)` : outcome.text,
          isError: outcome.isError,
          durationMs: Math.round(performance.now() - started),
        },
      })
      transcript.push({ role: 'tool', tool_call_id: call.id, content: outcome.isError ? `Error: ${outcome.text}` : outcome.text })
    }
  }
  return { text: said, steps: transcript.slice(messages.length) }
}

async function runCall(host: ToolHost, call: ToolCall, signal?: AbortSignal): Promise<ToolOutcome> {
  let args: unknown
  try {
    args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {}
  } catch {
    return { text: `The arguments were not valid JSON: ${call.function.arguments.slice(0, 200)}`, isError: true }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return { text: 'The arguments must be a JSON object.', isError: true }
  return host.call(call.function.name, args as Record<string, unknown>, signal)
}

/** One streamed completion: text goes to onDelta; returns the tool calls it asked for (if any). */
async function streamStep(
  target: ChatTarget,
  messages: LoopMessage[],
  tools: FunctionTool[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<ToolCall[]> {
  const response = await postChat(target, { messages, ...(tools.length > 0 ? { tools } : {}) }, signal)
  // Tool calls arrive in pieces, keyed by index: the id and name first, then the arguments bit by bit.
  const calls: ToolCall[] = []
  for await (const { event, data } of readSse(response.body!)) {
    if (event) continue
    const delta = (data as { choices?: { delta?: StreamDelta }[] }).choices?.[0]?.delta
    if (!delta) continue
    if (delta.content) onDelta(delta.content)
    for (const piece of delta.tool_calls ?? []) {
      const index = piece.index ?? calls.length
      const call = (calls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } })
      if (piece.id) call.id = piece.id
      if (piece.function?.name) call.function.name += piece.function.name
      if (piece.function?.arguments) call.function.arguments += piece.function.arguments
    }
  }
  return calls.filter(Boolean).map((call, i) => ({ ...call, id: call.id || `call_${i}` }))
}

interface StreamDelta {
  content?: string | null
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
}
