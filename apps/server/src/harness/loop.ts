// The harness loop: ask the LLM, run the tools it calls (through MCP plugins),
// give it the results, and repeat until it answers in words.
//
// Text is streamed as it comes (so Jarvis can start speaking "Let me check."
// while a tool runs). The last allowed step is sent without tools (Claude gets
// them but may not call one: it needs them defined), so the
// loop always ends with an answer.

import type { RawReply } from '../assistant/anthropic.ts'
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
  | { role: 'assistant'; content: string | null; tool_calls: ToolCall[]; /** Claude's own reply blocks (anthropic.ts). */ raw?: RawReply }
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

/** LLM calls per request. 8: a skill's one-time refusal plus making a folder still leaves room to finish. */
export const DEFAULT_MAX_STEPS = 8
/**
 * A tool call written as text (Qwen's own markup) instead of a real one, e.g. on the
 * last step, which is sent without tools: never shown or spoken.
 */
const TOOL_MARKUP = /<tool_call>|<function=|<\/?tool_call/
const MARKUP_STARTS = ['<tool_call>', '<function=', '</tool_call']
/** Longest tool result sent to the client with a tool-call event. */
const EVENT_RESULT_CHARS = 4000

export async function runLoop(target: ChatTarget, messages: LoopMessage[], host: ToolHost, options: LoopOptions): Promise<LoopResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const transcript: LoopMessage[] = [...messages]
  let said = ''
  let stepText = ''
  /** Tool-call markup turned up in the text: nothing more of this reply is passed on. */
  let leaked = false
  /** The end of the text so far, held back while it could be the start of such markup ("<tool_"). */
  let held = ''
  const emit = (delta: string) => {
    if (!delta) return
    // Text from separate steps is joined with a space ("Let me look." + "You have two notes.").
    if (said !== '' && stepText === '' && !/\s$/.test(said) && !/^\s/.test(delta)) {
      said += ' '
      options.onDelta(' ')
    }
    stepText += delta
    said += delta
    options.onDelta(delta)
  }
  const onDelta = (delta: string) => {
    if (leaked) return
    const text = held + delta
    held = ''
    const at = text.search(TOOL_MARKUP)
    if (at !== -1) {
      leaked = true
      emit(text.slice(0, at).replace(/\s+$/, ''))
      return
    }
    // Hold back a trailing "<…" that could still become markup.
    const lt = text.lastIndexOf('<')
    if (lt !== -1 && MARKUP_STARTS.some((m) => m.startsWith(text.slice(lt)) && text.length - lt < m.length)) {
      held = text.slice(lt)
      emit(text.slice(0, lt))
    } else {
      emit(text)
    }
  }
  /** End of a step: what was held back was just text after all. */
  const flush = () => {
    if (!leaked && held) emit(held)
    held = ''
  }
  for (let step = 1; step <= maxSteps; step++) {
    stepText = ''
    // Claude needs the tools defined whenever the history has tool calls: on the last step it gets them, but may not call one.
    const last = step >= maxSteps
    const tools = !last || target.kind === 'anthropic' ? host.tools() : []
    const { calls, cutOff, raw } = await streamStep(target, transcript, tools, onDelta, options.signal, last)
    flush()
    if (leaked || calls.length === 0) break
    // A call whose arguments aren't valid JSON (usually cut off: a whole file in one write) isn't run,
    // and goes back with "{}": llama-server re-parses the history's arguments and fails the whole
    // request (HTTP 500) on a broken one, in this reply and every later one.
    const broken = new Set(calls.filter((c) => !validJson(c.function.arguments)).map((c) => c.id))
    transcript.push({
      role: 'assistant',
      content: stepText || null,
      tool_calls: calls.map((c) => (broken.has(c.id) ? { ...c, function: { ...c.function, arguments: '{}' } } : c)),
      ...(raw && broken.size === 0 ? { raw } : {}),
    })
    for (const call of calls) {
      const label = host.label(call.function.name)
      const detail = { id: call.id, name: call.function.name, args: call.function.arguments, crud: host.crud?.(call.function.name) ?? [] }
      options.onEvent?.({ kind: 'tool', label, emoji: '🔧', status: 'running', call: { ...detail, status: 'running' } })
      const started = performance.now()
      const outcome: ToolOutcome = broken.has(call.id)
        ? {
            isError: true,
            text: cutOff
              ? `Not done: this ${call.function.name} call was cut off because it was too long for one reply, so nothing was changed. ` +
                'Split the work into smaller calls: for a long file, write_file the first part (about 40 lines), then append_file the rest in parts of about 40 lines, or use edit_file for just the lines that change.'
              : `The arguments were not valid JSON: ${call.function.arguments.slice(0, 200)}. Nothing was done; send the call again with valid JSON (if it's long, split it into smaller calls).`,
          }
        : await runCall(host, call, options.signal)
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
  if (leaked) {
    const note = `${said.trim() ? ' ' : ''}I couldn't finish that in one go; ask me again and I'll pick it up.`
    said += note
    options.onDelta(note)
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
  noCalls = false,
): Promise<{ calls: ToolCall[]; cutOff: boolean; raw?: RawReply }> {
  const response = await postChat(target, { messages, ...(tools.length > 0 ? { tools, ...(noCalls ? { tool_choice: 'none' } : {}) } : {}) }, signal)
  // Tool calls arrive in pieces, keyed by index: the id and name first, then the arguments bit by bit.
  const calls: ToolCall[] = []
  let cutOff = false
  let raw: RawReply | undefined
  for await (const { event, data } of readSse(response.body!)) {
    if (event) continue
    if (data.jarvis_raw) raw = data.jarvis_raw as RawReply
    const choice = (data as { choices?: { delta?: StreamDelta; finish_reason?: string | null }[] }).choices?.[0]
    // "length": the reply hit max_tokens, so a tool call in it may be unfinished.
    if (choice?.finish_reason === 'length') cutOff = true
    const delta = choice?.delta
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
  return { calls: calls.filter(Boolean).map((call, i) => ({ ...call, id: call.id || `call_${i}` })), cutOff, ...(raw ? { raw } : {}) }
}

function validJson(text: string): boolean {
  if (!text.trim()) return true
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

interface StreamDelta {
  content?: string | null
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
}
