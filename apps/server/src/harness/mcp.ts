// The MCP client side of the harness: one connection per plugin, their tools
// offered to the LLM as OpenAI-style functions named "<plugin>__<tool>", and
// tool calls routed back to the plugin that owns them.
//
// A plugin that fails to start or crashes is left out (logged) and retried in
// the background; the rest keep working.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { PluginConfig } from './config.ts'

/** A tool as the chat-completions API takes it. */
export interface FunctionTool {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}

export interface ToolOutcome {
  text: string
  isError: boolean
}

export interface PluginStatus {
  name: string
  connected: boolean
  tools: string[]
  error?: string
}

const CONNECT_TIMEOUT_MS = 15_000
const RETRY_AFTER_MS = 30_000
/** Longest tool result handed back to the LLM (its context is limited). */
const MAX_RESULT_CHARS = 8000

interface Connection {
  config: PluginConfig
  client?: Client
  tools: Tool[]
  connected: boolean
  connecting?: Promise<void>
  lastAttempt: number
  error?: string
}

export class McpHub {
  private readonly connections: Connection[]
  /** "<plugin>__<tool>" → where it lives. */
  private routes = new Map<string, { connection: Connection; tool: Tool }>()
  private readonly log: (message: string, err?: unknown) => void
  private closed = false

  constructor(plugins: PluginConfig[], log: (message: string, err?: unknown) => void) {
    this.connections = plugins.map((config) => ({ config, tools: [], connected: false, lastAttempt: 0 }))
    this.log = log
  }

  /** Connects every plugin (in parallel); failures are logged, not thrown. */
  async start(): Promise<void> {
    await Promise.all(this.connections.map((c) => this.connect(c)))
  }

  get size(): number {
    return this.connections.length
  }

  status(): PluginStatus[] {
    return this.connections.map((c) => ({ name: c.config.name, connected: c.connected, tools: c.tools.map((t) => t.name), error: c.error }))
  }

  /** The tools of every connected plugin. Kicks off a reconnect for plugins that are down. */
  tools(): FunctionTool[] {
    for (const c of this.connections) {
      if (!this.closed && !c.connected && !c.connecting && Date.now() - c.lastAttempt > RETRY_AFTER_MS) void this.connect(c)
    }
    return [...this.routes].map(([name, { tool }]) => ({
      type: 'function',
      function: { name, description: tool.description ?? tool.title, parameters: tool.inputSchema as Record<string, unknown> },
    }))
  }

  /** What each connected plugin says about itself (MCP `instructions`), for the system prompt. */
  instructions(): string[] {
    return this.connections.flatMap((c) => {
      const text = c.connected ? c.client?.getInstructions()?.trim() : undefined
      return text ? [`${c.config.name}: ${text}`] : []
    })
  }

  /** A short human label for a tool call, e.g. "notes: read_note". */
  label(name: string): string {
    const route = this.routes.get(name)
    return route ? `${route.connection.config.name}: ${route.tool.title ?? route.tool.name}` : name
  }

  /** Runs a tool. Never throws for tool-level problems: those come back as an error result for the LLM. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
    const route = this.routes.get(name)
    if (!route || !route.connection.connected || !route.connection.client) return { text: `The tool "${name}" isn't available right now.`, isError: true }
    const { connection, tool } = route
    try {
      const result = await connection.client!.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: connection.config.timeoutMs })
      const outcome = { text: truncate(resultText(result)), isError: result.isError === true }
      this.log(`harness: ${connection.config.name}.${tool.name} ${oneLine(JSON.stringify(args), 160)} → ${outcome.isError ? 'error: ' : ''}${oneLine(outcome.text, 160)}`)
      return outcome
    } catch (err) {
      if (signal?.aborted) throw err
      this.log(`harness: ${connection.config.name}.${tool.name} failed: ${(err as Error).message}`)
      return { text: `The tool failed: ${(err as Error).message}`, isError: true }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all(this.connections.map((c) => c.client?.close().catch(() => {})))
  }

  // ------------------------------------------------------------------ internals

  private connect(c: Connection): Promise<void> {
    c.lastAttempt = Date.now()
    c.connecting = (async () => {
      const name = c.config.name
      const client = new Client({ name: 'jarvis', version: '0.1.0' })
      const transport = this.transport(c.config)
      try {
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `${name} took too long to start`)
        const tools: Tool[] = []
        let cursor: string | undefined
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined)
          tools.push(...page.tools)
          cursor = page.nextCursor
        } while (cursor)
        client.onclose = () => {
          if (c.client !== client || this.closed) return
          c.connected = false
          c.error = 'disconnected'
          this.rebuildRoutes()
          this.log(`harness: plugin "${name}" disconnected; will retry`)
        }
        c.client = client
        c.tools = tools
        c.connected = true
        c.error = undefined
        this.rebuildRoutes()
        this.log(`harness: plugin "${name}" ready (${tools.map((t) => t.name).join(', ') || 'no tools'})`)
      } catch (err) {
        c.error = (err as Error).message
        this.log(`harness: plugin "${name}" unavailable: ${c.error}`)
        await client.close().catch(() => {})
      } finally {
        c.connecting = undefined
      }
    })()
    return c.connecting
  }

  private transport(config: PluginConfig): Transport {
    const t = config.transport
    if (t.kind === 'http') return new StreamableHTTPClientTransport(new URL(t.url), { requestInit: { headers: t.headers } })
    const transport = new StdioClientTransport({ command: t.command, args: t.args, env: { ...getDefaultEnvironment(), ...t.env }, cwd: t.cwd, stderr: 'pipe' })
    // A plugin's stderr is its log.
    transport.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line.trim()) this.log(`[${config.name}] ${line}`)
    })
    return transport
  }

  private rebuildRoutes(): void {
    this.routes = new Map()
    for (const c of this.connections) {
      if (!c.connected) continue
      for (const tool of c.tools) this.routes.set(functionName(c.config.name, tool.name), { connection: c, tool })
    }
  }
}

/** Function names may only be [A-Za-z0-9_-], at most 64 long. */
function functionName(plugin: string, tool: string): string {
  return `${plugin}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const parts: string[] = []
  for (const item of (result.content ?? []) as { type: string; text?: string; resource?: { uri: string; text?: string } }[]) {
    if (item.type === 'text' && item.text !== undefined) parts.push(item.text)
    else if (item.type === 'resource' && item.resource) parts.push(item.resource.text ?? `[resource ${item.resource.uri}]`)
    else parts.push(`[${item.type}]`)
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent))
  return parts.join('\n') || '(no output)'
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (cut: ${text.length - MAX_RESULT_CHARS} more characters)` : text
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer))
}
