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
import crypto from 'node:crypto'
import { z } from 'zod'
import type { PluginConfig } from './config.ts'
import { classify, type Crud, type CrudSource } from './crud.ts'

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

/** A plugin and everything its tools take, for the Tools tab. */
export interface PluginInfo {
  name: string
  transport: 'stdio' | 'http'
  connected: boolean
  connecting: boolean
  error?: string
  tools: { name: string; title?: string; description?: string; parameters: Record<string, unknown>; crud: Crud[]; crudSource: CrudSource }[]
}

/** Whether the LLM may use a plugin's tool (the owner's on/off switches), given what it does. */
export type ToolFilter = (plugin: string, tool: string, crud: Crud[]) => boolean

/** An event a plugin sent (docs/plugins.md): `notifications/jarvis/event`. */
export interface PluginEvent {
  type: string
  id?: string
  at?: string
  payload: unknown
  summary?: string
}

/** What the platform does with what plugins send (set by plugins/index.ts). */
export interface PluginLink {
  event(plugin: string, event: PluginEvent): void
  /** A request from a plugin (jarvis/notify, jarvis/note, jarvis/tab-push): its result, or throws. */
  request(plugin: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
}

const EventNotification = z.object({
  method: z.literal('notifications/jarvis/event'),
  params: z.object({ type: z.string(), id: z.string().optional(), at: z.string().optional(), payload: z.unknown(), summary: z.string().optional() }).passthrough(),
})
const PLUGIN_REQUESTS = ['jarvis/notify', 'jarvis/note', 'jarvis/tab-push'] as const

/** How long the owner has to say yes to a tool that needs it (the confirmation gate). */
const CONFIRM_MS = 5 * 60_000

const CONNECT_TIMEOUT_MS = 15_000
const RETRY_AFTER_MS = 30_000
/** Longest tool result handed back to the LLM (its context is limited), unless the plugin sets maxResultChars. */
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
  private readonly allowed: ToolFilter
  private closed = false
  /** Where plugins' events and requests go (the platform); none: dropped. */
  link: PluginLink | null = null
  /** When the owner last spoke or typed to Jarvis (ms), for the confirmation gate. */
  ownerHeard: () => number | null = () => null
  /** Tools waiting for the owner's yes: code → the call and when it was asked. */
  private pending = new Map<string, { name: string; args: string; at: number }>()

  constructor(plugins: PluginConfig[], log: (message: string, err?: unknown) => void, allowed: ToolFilter = () => true) {
    this.connections = plugins.map((config) => ({ config, tools: [], connected: false, lastAttempt: 0 }))
    this.log = log
    this.allowed = allowed
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

  /** Every plugin with its tools' full descriptions (switched off or not). */
  catalog(): PluginInfo[] {
    return this.connections.map((c) => ({
      name: c.config.name,
      transport: c.config.transport.kind,
      connected: c.connected,
      connecting: !!c.connecting,
      error: c.error,
      tools: c.tools.map((t) => {
        const tags = this.crud(c, t)
        return { name: t.name, title: t.title, description: t.description, parameters: t.inputSchema as Record<string, unknown>, crud: tags.kinds, crudSource: tags.source }
      }),
    }))
  }

  /** The tools the LLM may use: of connected plugins, and switched on. Kicks off a reconnect for plugins that are down. */
  tools(): FunctionTool[] {
    for (const c of this.connections) {
      if (!this.closed && !c.connected && !c.connecting && Date.now() - c.lastAttempt > RETRY_AFTER_MS) void this.connect(c)
    }
    return [...this.routes]
      .filter(([, { connection, tool }]) => this.permitted(connection, tool) && !manifestTool(connection, tool)?.tab)
      .map(([name, { connection, tool }]) => {
        const parameters = tool.inputSchema as Record<string, unknown>
        if (manifestTool(connection, tool)?.confirm !== 'owner') return { type: 'function', function: { name, description: tool.description ?? tool.title, parameters } }
        // The confirmation gate's code, added to the plugin's own parameters.
        const properties = { ...((parameters.properties as Record<string, unknown>) ?? {}), confirm: { type: 'string', description: 'The code from the first call, only after the owner said yes.' } }
        return {
          type: 'function',
          function: { name, description: `${tool.description ?? tool.title ?? ''} Needs the owner's yes: call it first without confirm, read back exactly what will happen, and only after they say yes call again with the same arguments and the code.`, parameters: { ...parameters, properties } },
        }
      })
  }

  /** What each connected plugin says about itself (MCP `instructions`), for the system prompt. */
  instructions(allow: (functionName: string) => boolean = () => true): string[] {
    return this.connections.flatMap((c) => {
      const usable = c.connected && c.tools.some((t) => this.permitted(c, t) && allow(functionName(c.config.name, t.name)))
      if (!usable) return []
      const text = [c.client?.getInstructions()?.trim(), c.config.instructions].filter(Boolean).join(' ')
      return text ? [`${c.config.name}: ${text}`] : []
    })
  }

  /** What a tool does, by function name ("files__write_file" → create + update). */
  crudOf(name: string): Crud[] {
    const route = this.routes.get(name)
    return route ? this.crud(route.connection, route.tool).kinds : []
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
    if (!this.permitted(connection, tool)) return { text: `The tool "${name}" is switched off.`, isError: true }
    if (manifestTool(connection, tool)?.tab) return { text: `The tool "${name}" is only for the ${connection.config.name} tab.`, isError: true }
    if (manifestTool(connection, tool)?.confirm === 'owner') {
      const gate = this.gate(name, args)
      if (gate.refuse) return gate.refuse
      args = gate.args
    }
    return this.run(connection, tool, args, signal)
  }

  /**
   * The confirmation gate (docs/plugins.md): a tool that acts in the owner's
   * name runs only with a code from a first call, for the same arguments,
   * and only if the owner has spoken or typed to Jarvis since that first call.
   * Checked here, so no plugin and no model can skip it.
   */
  private gate(name: string, args: Record<string, unknown>): { refuse?: ToolOutcome; args: Record<string, unknown> } {
    const { confirm, ...rest } = args
    const key = JSON.stringify(sortKeys(rest))
    const now = Date.now()
    for (const [k, p] of this.pending) if (now - p.at > CONFIRM_MS) this.pending.delete(k)
    const code = typeof confirm === 'string' ? confirm.trim() : ''
    if (!code) {
      const id = crypto.randomBytes(3).toString('hex')
      this.pending.set(id, { name, args: key, at: now })
      return {
        args: rest,
        refuse: {
          text: `Not done yet: this acts in the owner's name. Read back to them exactly what will happen (${oneLine(JSON.stringify(rest), 600)}) and ask them to confirm. If they say yes, call ${name} again with the same arguments and confirm "${id}" (valid 5 minutes).`,
          isError: false,
        },
      }
    }
    const p = this.pending.get(code)
    if (!p || p.name !== name || p.args !== key) return { args: rest, refuse: { text: 'That confirmation code is unknown, expired, or for something else: start again (without confirm) and ask the owner.', isError: true } }
    const heard = this.ownerHeard()
    if (!heard || heard <= p.at) return { args: rest, refuse: { text: "The owner hasn't answered since you asked: wait for their yes, then call again with the code.", isError: true } }
    this.pending.delete(code)
    return { args: rest }
  }

  /** A tool called by the owner from the plugin's tab: no gate (pressing the button is their yes), tab-only tools included. */
  async callAsOwner(plugin: string, toolName: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const connection = this.connections.find((c) => c.config.name === plugin)
    const tool = connection?.tools.find((t) => t.name === toolName)
    if (!connection?.connected || !connection.client || !tool) return { text: `${plugin} has no tool "${toolName}" right now.`, isError: true }
    return this.run(connection, tool, args, undefined, true)
  }

  /** Tells a plugin something (a server event, or another plugin's event it subscribed to). */
  notifyPlugin(plugin: string, type: string, payload: unknown): void {
    const c = this.connections.find((x) => x.config.name === plugin)
    if (!c?.connected || !c.client) return
    void c.client.notification({ method: 'notifications/jarvis/server-event', params: { type, payload: payload as Record<string, unknown> } }).catch((err: Error) => this.log(`harness: couldn't tell ${plugin} about ${type}: ${err.message}`))
  }

  /** The self-contained plugins' manifests. */
  manifests() {
    return this.connections.flatMap((c) => (c.config.manifest ? [{ manifest: c.config.manifest, connected: c.connected }] : []))
  }

  private async run(connection: Connection, tool: Tool, args: Record<string, unknown>, signal?: AbortSignal, full = false): Promise<ToolOutcome> {
    try {
      const result = await connection.client!.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: connection.config.timeoutMs })
      // A tab gets the whole result; the LLM a cut one (its context is limited).
      const text = resultText(result)
      const outcome = { text: full ? text : truncate(text, connection.config.maxResultChars), isError: result.isError === true }
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
      if (c.config.manifest) this.listen(client, name)
      const transport = this.transport(c.config)
      try {
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `${name} took too long to start`)
        const tools: Tool[] = []
        let cursor: string | undefined
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined)
          tools.push(...page.tools.filter((t) => !c.config.exclude?.includes(t.name)))
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

  /** What a self-contained plugin sends unasked: events, and requests to the server. */
  private listen(client: Client, plugin: string): void {
    client.setNotificationHandler(EventNotification, (n) => {
      if (!this.link) return this.log(`harness: ${plugin} sent "${n.params.type}" but nothing handles plugin events`)
      this.link.event(plugin, n.params as PluginEvent)
    })
    for (const method of PLUGIN_REQUESTS) {
      client.setRequestHandler(z.object({ method: z.literal(method), params: z.record(z.string(), z.unknown()).optional() }), async (req) => {
        if (!this.link) throw new Error('The server takes no plugin requests right now.')
        return this.link.request(plugin, method, (req.params ?? {}) as Record<string, unknown>)
      })
    }
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

  /** What a tool does (create / read / update / delete). */
  private crud(c: Connection, tool: Tool) {
    return classify(tool, c.config.crud?.[tool.name])
  }

  private permitted(c: Connection, tool: Tool): boolean {
    return this.allowed(c.config.name, tool.name, this.crud(c, tool).kinds)
  }

  private rebuildRoutes(): void {
    this.routes = new Map()
    for (const c of this.connections) {
      if (!c.connected) continue
      for (const tool of c.tools) this.routes.set(functionName(c.config.name, tool.name), { connection: c, tool })
    }
  }
}

/** What the plugin's manifest says about one of its tools (none for plain MCP servers). */
function manifestTool(c: Connection, tool: Tool) {
  return c.config.manifest?.tools[tool.name]
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]))
  return v
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

function truncate(text: string, max = MAX_RESULT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cut: ${text.length - max} more characters)` : text
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer))
}
