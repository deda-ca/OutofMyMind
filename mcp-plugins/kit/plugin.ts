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
