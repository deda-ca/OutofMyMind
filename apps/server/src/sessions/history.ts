// Between a session's entries and what the LLM sees (chat messages, with the
// harness's tool calls and results).

import path from 'node:path'
import { config } from '../config.ts'
import { formatSize } from '../files/workspaceFiles.ts'
import type { LoopMessage, ToolCall } from '../harness/loop.ts'
import type { SessionEntry, ToolUse } from './format.ts'

/** Longest tool result kept in a session (the full one was used for the reply). */
export const TOOL_RESULT_CHARS = 2000

/**
 * When it was said, for the start of a message: "[14:30]" today, "[Sun 8 Nov 14:30]" before.
 * Only the owner's side carries times (Jarvis's answers don't, so it doesn't copy the format).
 */
export function stamp(at: string, now = new Date()): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `[${time}]`
  return `[${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}]`
}

/** One entry as chat messages. */
export function entryMessages(entry: SessionEntry, index: number, now = new Date()): LoopMessage[] {
  const at = stamp(entry.at, now)
  switch (entry.kind) {
    case 'owner':
      return [{ role: 'user', content: `${at} ${entry.text}` }]
    case 'context':
      return [{ role: 'user', content: `${at} [${entry.who} said, not to you]: ${entry.text}` }]
    case 'note':
      return [{ role: 'user', content: `${at} (Note from Jarvis's software, not from the owner: ${entry.text})` }]
    case 'files':
      return [{ role: 'user', content: `${at} ${filesMessage(entry.files, entry.text)}` }]
    case 'earlier':
      return [
        { role: 'user', content: `${at} (Context, not a request: what was said in the last few minutes before you were called.)\n${entry.text}` },
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
export function historyMessages(entries: SessionEntry[], max: number, now = new Date()): LoopMessage[] {
  const out: LoopMessage[][] = []
  let count = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const messages = entryMessages(entries[i]!, i, now)
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

/** Text files Jarvis can read with read_text_file. */
const READABLE = /\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|html?|log|ini|toml)$/i

/**
 * Files the owner dropped in, as the LLM sees them: full paths (its file tools
 * need them), and what it can and can't do with each.
 */
export function filesMessage(files: { path: string; name: string; type: string; size: number }[], note = ''): string {
  const lines = files.map((f) => `- ${path.join(config.workspaceDir, f.path)} (${f.type || 'unknown type'}, ${formatSize(f.size)}${READABLE.test(f.name) ? ', text you can read' : ''})`)
  const media = files.some((f) => !READABLE.test(f.name))
  return [
    `(The owner added ${files.length === 1 ? 'a file' : `${files.length} files`} to the conversation, saved in your workspace:`,
    ...lines,
    `To save or file ${files.length === 1 ? 'it' : 'them'} somewhere, use your file tools: create the folder if needed, then move_file (or copy_file) to the place the owner names, inside the workspace.` +
      (media ? " You can't see inside images, audio, video or PDFs yet: don't describe or guess their contents; say so if asked." : '') +
      (note ? `\nThe owner's note with ${files.length === 1 ? 'it' : 'them'}: ${note}` : '') +
      ')',
  ].join('\n')
}
