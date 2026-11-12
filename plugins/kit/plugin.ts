// The small kit every Jarvis plugin is built with. A plugin is an ordinary MCP
// server that talks over stdio, so the harness (apps/server/src/harness) can
// start it as a child process, and any other MCP client could use it too.
//
//   const plugin = createPlugin('notes', '0.1.0', 'What the plugin is for.')
//   plugin.registerTool('list_notes', { description, inputSchema: { … } }, async (args) => text('…'))
//   await serve(plugin)
//
// stdout belongs to the MCP protocol: log with `log()` (stderr), never console.log.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export function createPlugin(name: string, version: string, instructions?: string): McpServer {
  return new McpServer({ name, version }, instructions ? { instructions } : undefined)
}

/** Runs the plugin on stdio until the harness closes it. */
export async function serve(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  const stop = () => void server.close().finally(() => process.exit(0))
  process.stdin.once('end', stop)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

/** A plain-text tool result. */
export function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] }
}

/** A tool result the model sees as a failure (it can then explain or retry). */
export function failure(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Logs to stderr (the harness shows it in the server log). */
export function log(message: string): void {
  process.stderr.write(`${message}\n`)
}

// ------------------------------------------------------------------ talking to the Jarvis server (docs/plugins.md)
// For self-contained plugins (with a plugin.json). Events must be declared in
// plugin.json; requests are answered by the server's plugin platform.

/** Sends Jarvis an event, e.g. emit(plugin, 'email.received', { from, subject }, id). `id` makes it handled once. */
export function emit(server: McpServer, type: string, payload: Record<string, unknown>, id?: string, summary?: string): void {
  void server.server
    .notification({ method: 'notifications/jarvis/event', params: { type, payload, at: new Date().toISOString(), ...(id ? { id } : {}), ...(summary ? { summary } : {}) } })
    .catch((err: Error) => log(`couldn't send ${type}: ${err.message}`))
}

const Empty = z.object({}).passthrough()

/** A notification on the owner's screens ("info", or "reminder": stays until seen). */
export async function notify(server: McpServer, title: string, text: string, urgency: 'info' | 'reminder' = 'info'): Promise<void> {
  await server.server.request({ method: 'jarvis/notify', params: { title, text, urgency } }, Empty)
}

/** A note in the owner's active conversation with Jarvis. */
export async function note(server: McpServer, text: string): Promise<void> {
  await server.server.request({ method: 'jarvis/note', params: { text } }, Empty)
}

/** The speech models there are ("connection/model", with a label), the default one, Jarvis's voice, and the voices of `model` (default: the default one). */
export async function speechOptions(server: McpServer, model?: string): Promise<{ models: { ref: string; label: string }[]; tts: string; voice: string; voices: string[] }> {
  return server.server.request(
    { method: 'jarvis/speech', params: model ? { model } : {} },
    z.object({ models: z.array(z.object({ ref: z.string(), label: z.string() })), tts: z.string(), voice: z.string(), voices: z.array(z.string()) }).passthrough(),
  )
}

/** Text (up to 1,000 characters) as speech, by the server's speech servers: a WAV. */
export async function speak(server: McpServer, text: string, options: { voice?: string; model?: string } = {}): Promise<Buffer> {
  const r = await server.server.request(
    { method: 'jarvis/speak', params: { text, ...(options.voice ? { voice: options.voice } : {}), ...(options.model ? { model: options.model } : {}) } },
    z.object({ wav: z.string() }).passthrough(),
    { timeout: 60_000 },
  )
  return Buffer.from(r.wav, 'base64')
}

/** Tells the plugin's tab to reload its data. */
export async function refreshTab(server: McpServer): Promise<void> {
  await server.server.request({ method: 'jarvis/tab-push', params: {} }, Empty).catch(() => {})
}

/**
 * What the plugin's tab button shows besides its title: an icon (instead of
 * its own; animate: it pulses gently), a pill (a number or a word or two), a
 * tooltip. null clears it. E.g. tabStatus(plugin, { badge: unread }).
 */
export async function tabStatus(server: McpServer, status: { icon?: string; animate?: boolean; badge?: string | number; title?: string } | null): Promise<void> {
  await server.server.request({ method: 'jarvis/tab-status', params: status ?? {} }, Empty).catch(() => {})
}

/** Server events (another plugin's event this one subscribed to, …). */
export function onServerEvent(server: McpServer, handler: (type: string, payload: Record<string, unknown>) => void): void {
  server.server.setNotificationHandler(
    z.object({ method: z.literal('notifications/jarvis/server-event'), params: z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()).optional() }) }),
    (n) => handler(n.params.type, n.params.payload ?? {}),
  )
}

/** DATA_DIR/plugins/<name>/ (plugin.json "data": true), and WORKSPACE_DIR/<folder>/ ("workspace"). */
export const pluginDataDir = process.env.JARVIS_DATA?.trim() ?? ''
export const pluginWorkspaceDir = process.env.JARVIS_WORKSPACE?.trim() ?? ''
