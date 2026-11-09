// Between a session's entries and what the LLM sees (chat messages, with the
// harness's tool calls and results).

import type { LoopMessage, ToolCall } from '../harness/loop.ts'
import type { SessionEntry, ToolUse } from './format.ts'

/** Longest tool result kept in a session (the full one was used for the reply). */
export const TOOL_RESULT_CHARS = 2000

/** One entry as chat messages. */
export function entryMessages(entry: SessionEntry, index: number): LoopMessage[] {
  switch (entry.kind) {
    case 'owner':
      return [{ role: 'user', content: entry.text }]
    case 'context':
      return [{ role: 'user', content: `[${entry.who} said, not to you]: ${entry.text}` }]
    case 'note':
      return [{ role: 'user', content: `(Note from Jarvis's software, not from the owner: ${entry.text})` }]
    case 'earlier':
      return [
        { role: 'user', content: `(Context, not a request: what was said in the last few minutes before you were called.)\n${entry.text}` },
        { role: 'assistant', content: 'Understood.' },
      ]
    case 'jarvis': {
      const tools = entry.tools ?? []
      if (tools.length === 0) return [{ role: 'assistant', content: entry.text }]
      const calls: ToolCall[] = tools.map((t, k) => ({ id: `s${index}_${k}`, type: 'function', function: { name: t.name, arguments: t.args } }))
      return [
        { role: 'assistant', content: null, tool_calls: calls },
        ...calls.map((c, k): LoopMessage => ({ role: 'tool', tool_call_id: c.id, content: tools[k]!.result })),
        { role: 'assistant', content: entry.text },
      ]
    }
  }
}

/**
 * The end of a session as the LLM's history: whole entries only (so a tool
 * result never loses its call), at most `max` messages.
 */
export function historyMessages(entries: SessionEntry[], max: number): LoopMessage[] {
  const out: LoopMessage[][] = []
  let count = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const messages = entryMessages(entries[i]!, i)
    if (count + messages.length > max && out.length > 0) break
    out.unshift(messages)
    count += messages.length
  }
  return out.flat()
}

/** The tools used in a reply, from the harness's steps (calls matched to their results). */
export function toolUses(steps: LoopMessage[]): ToolUse[] {
  const results = new Map<string, string>()
  for (const m of steps) if (m.role === 'tool') results.set(m.tool_call_id, m.content)
  const uses: ToolUse[] = []
  for (const m of steps) {
    if (m.role !== 'assistant' || !('tool_calls' in m)) continue
    for (const call of m.tool_calls) {
      const result = results.get(call.id) ?? '(no result)'
      uses.push({
        name: call.function.name,
        args: call.function.arguments,
        result: result.length > TOOL_RESULT_CHARS ? `${result.slice(0, TOOL_RESULT_CHARS)} … (cut)` : result,
      })
    }
  }
  return uses
}
