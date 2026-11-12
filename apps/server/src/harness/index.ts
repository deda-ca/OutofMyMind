// The harness: Jarvis's own agent loop, with tools from plug-in MCP servers.
//
// Started once at server start-up (main.ts) from the plugin file (MCP_CONFIG,
// default mcp.json). With no plugins configured it's inactive and replies are
// plain chat, exactly as before. Plugins live in /plugins; any other MCP
// server (stdio or streamable HTTP) can be added to the file too.

import path from 'node:path'
import type { AgentEvent, ChatTarget } from '../assistant/llm.ts'
import { config } from '../config.ts'
import { loadPluginConfig } from './config.ts'
import { runLoop, type LoopMessage, type LoopResult, type ToolHost } from './loop.ts'
import { McpHub, type FunctionTool, type PluginInfo, type PluginLink, type PluginStatus, type ToolOutcome } from './mcp.ts'
import { CRUD, type Crud } from './crud.ts'
import { ToolToggles } from './toggles.ts'

/** A plugin as the Tools tab shows it: with the owner's on/off switches. */
export interface PluginView extends Omit<PluginInfo, 'tools'> {
  enabled: boolean
  /** enabled: the tool's own switch. blockedBy: kinds it does that are switched off (then it isn't offered either). */
  tools: (PluginInfo['tools'][number] & { enabled: boolean; blockedBy: Crud[] })[]
}

class Harness {
  private hub?: McpHub
  private toggles?: ToolToggles
  private link: PluginLink | null = null
  private ownerHeard: () => number | null = () => null

  /** Where self-contained plugins' events and requests go (plugins/index.ts). */
  setLink(link: PluginLink | null): void {
    this.link = link
    if (this.hub) this.hub.link = link
  }

  /** When the owner last spoke or typed to Jarvis: the confirmation gate's "yes". */
  setOwnerHeard(fn: () => number | null): void {
    this.ownerHeard = fn
    if (this.hub) this.hub.ownerHeard = fn
  }

  /** A plugin's tool, called by the owner from its tab. */
  callAsOwner(plugin: string, tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    return this.hub?.callAsOwner(plugin, tool, args) ?? Promise.resolve({ text: 'No plugins are running.', isError: true })
  }

  /** Tells a plugin something (a server event, or an event it subscribed to). */
  notifyPlugin(plugin: string, type: string, payload: unknown): void {
    this.hub?.notifyPlugin(plugin, type, payload)
  }

  /** The self-contained plugins (with plugin.json) and whether each is running. */
  manifests() {
    return this.hub?.manifests() ?? []
  }

  /** `togglesFile`: where the Tools tab's on/off switches are kept. */
  async start(configFile: string, log: (message: string, err?: unknown) => void, togglesFile = path.join(config.dataDir, 'tools.json')): Promise<void> {
    const toggles = new ToolToggles(togglesFile)
    this.toggles = toggles
    let plugins
    try {
      plugins = loadPluginConfig(configFile)
    } catch (err) {
      log(`harness: could not read ${configFile}, no plugins: ${(err as Error).message}`)
      return
    }
    if (plugins.length === 0) {
      log(`harness: no plugins enabled in ${configFile}`)
      return
    }
    this.hub = new McpHub(plugins, log, (plugin, tool, crud) => {
      try {
        return toggles.allowed(plugin, tool, crud)
      } catch (err) {
        // An unreadable tools.json: offer nothing rather than tools the owner may have switched off.
        log('harness: could not read the tool switches', err)
        return false
      }
    })
    this.hub.link = this.link
    this.hub.ownerHeard = this.ownerHeard
    await this.hub.start()
  }

  /** Whether any plugin offers tools (switched on, and allowed for the agent) right now. */
  hasTools(allow: ToolAllow = () => true): boolean {
    return (this.hub?.tools().some((t) => allow(t.function.name)) ?? false)
  }

  status(): PluginStatus[] {
    return this.hub?.status() ?? []
  }

  /** Every plugin and tool, with whether it's switched on. */
  catalog(): PluginView[] {
    const toggles = this.toggles
    return (this.hub?.catalog() ?? []).map((p) => ({
      ...p,
      enabled: toggles?.pluginEnabled(p.name) ?? true,
      tools: p.tools.map((t) => ({
        ...t,
        enabled: toggles?.toolEnabled(p.name, t.name) ?? true,
        blockedBy: t.crud.filter((k) => !(toggles?.kindEnabled(k) ?? true)),
      })),
    }))
  }

  /** The CRUD switches: whether tools that create / read / update / delete may be used at all. */
  kinds(): Record<Crud, boolean> {
    return Object.fromEntries(CRUD.map((k) => [k, this.toggles?.kindEnabled(k) ?? true])) as Record<Crud, boolean>
  }

  setKind(kind: Crud, enabled: boolean): void {
    this.toggles?.setKind(kind, enabled)
  }

  /**
   * Switches a plugin (`tool` null) or one of its tools on or off. Returns
   * false if there's no such plugin or tool.
   */
  setEnabled(plugin: string, tool: string | null, enabled: boolean): boolean {
    const found = this.hub?.catalog().find((p) => p.name === plugin)
    if (!found || !this.toggles) return false
    if (tool === null) {
      this.toggles.setPlugin(plugin, enabled)
      return true
    }
    if (!found.tools.some((t) => t.name === tool)) return false
    this.toggles.setTool(plugin, tool, enabled)
    return true
  }

  /**
   * Answers with the tool loop, offering only the tools `allow` lets through
   * (the agent's). The system message should already carry toolGuidance().
   */
  run(
    target: ChatTarget,
    messages: LoopMessage[],
    onDelta: (text: string) => void,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    allow: ToolAllow = () => true,
    builtins: BuiltinTool[] = [],
    hooks: CallHooks = {},
  ): Promise<LoopResult> {
    const hub = this.hub
    if (!hub) throw new Error('The harness has no plugins')
    const own = new Map(builtins.map((b) => [b.tool.function.name, b]))
    // Plugins (or some of their tools) on demand: offered once loaded (tools__load), for the rest of this reply.
    const deferrals = hub.deferrals()
    const loaded = new Set<string>()
    const hidden = (name: string) => {
      const plugin = hub.pluginOf(name)
      const d = deferrals.find((x) => x.name === plugin)
      if (!d || loaded.has(d.name)) return false
      return d.whole || d.tools.includes(name.slice(d.name.length + 2))
    }
    const loader = (): BuiltinTool[] => loadTool(hub, allow, deferrals, loaded, hidden)
    const host: ToolHost = {
      // Built-in tools only touch Jarvis's own screen, never the owner's data: every agent gets them.
      // First in the list: with 20+ tools, a smaller model favours the early ones it recognises.
      tools: () => [
        ...builtins.map((b) => b.tool),
        ...loader().map((b) => b.tool),
        ...hub.tools().filter((t) => allow(t.function.name) && !hidden(t.function.name)),
      ],
      label: (name) => own.get(name)?.label ?? hub.label(name),
      crud: (name) => own.get(name)?.crud ?? hub.crudOf(name),
      call: async (name, args, callSignal) => {
        // Not offered yet (a tool on demand that isn't loaded): refused, whatever name the model used.
        if (!own.has(name) && hidden(name)) {
          const plugin = hub.pluginOf(name) ?? ''
          return { text: `${name} isn't loaded yet: call tools__load with { "plugin": "${plugin}" } first.`, isError: true }
        }
        const builtin = own.get(name) ?? loader().find((b) => b.tool.function.name === name)
        const crud = builtin?.crud ?? hub.crudOf(name)
        const refused = hooks.before?.(name, args, crud)
        if (refused) return refused
        const outcome = builtin
          ? await builtin.run(args)
          : allow(name)
            ? await hub.call(name, args, callSignal)
            : { text: `The tool "${name}" isn't available to this agent.`, isError: true }
        return hooks.after ? hooks.after(name, args, crud, outcome) : outcome
      },
    }
    return runLoop(target, messages, host, { onDelta, onEvent, signal })
  }

  /** What a plugin tool does (create/read/update/delete), by function name; [] if there's no such tool. */
  crudOf(name: string): Crud[] {
    return this.hub?.crudOf(name) ?? []
  }

  /** The function names of the tools offered right now (switched on, allowed for the agent). */
  toolNames(allow: ToolAllow = () => true): string[] {
    return (this.hub?.tools() ?? []).map((t) => t.function.name).filter(allow)
  }

  /** How to use the tools, for the system message (only plugins with a tool the agent may use). */
  toolGuidance(allow: ToolAllow = () => true): string {
    const off = CRUD.filter((k) => !this.kinds()[k])
    // The tools those switches take away (that would otherwise be offered), by name: the
    // model then knows exactly what it can't do, instead of promising to "create one instead".
    const blocked = this.catalog().flatMap((p) =>
      p.enabled ? p.tools.filter((t) => t.enabled && t.blockedBy.length > 0 && allow(`${p.name}__${t.name}`)).map((t) => `${p.name}__${t.name}`) : [],
    )
    // Plugins on demand: one line each. Those on demand as a whole leave their instructions to tools__load; those with
    // some tools on demand keep theirs, and list the tools that wait for tools__load.
    const hub = this.hub
    const offered = (name: string) => hub!.tools().some((t) => hub!.pluginOf(t.function.name) === name && allow(t.function.name))
    const deferrals = (hub?.deferrals() ?? []).filter((d) => offered(d.name))
    const lines = deferrals.map((d) =>
      d.whole
        ? `${d.name} (on demand): ${d.summary}. Its tools are loaded with tools__load({ "plugin": "${d.name}" }) when a request needs them.`
        : `${d.name} (some tools on demand): ${d.summary}. ${d.tools.join(', ')} are loaded with tools__load({ "plugin": "${d.name}" }) before use.`,
    )
    return toolGuidance([...(hub?.instructions(allow, (p) => deferrals.some((d) => d.whole && d.name === p)) ?? []), ...lines], off, blocked)
  }

  async close(): Promise<void> {
    await this.hub?.close()
    this.hub = undefined
  }
}

/**
 * How to use the tools: never guess what a tool can tell (a model asked
 * "what's the temperature?" otherwise invents one), and what each plugin says
 * about itself (e.g. the owner's home town).
 */
export function toolGuidance(instructions: string[], kindsOff: Crud[] = [], blocked: string[] = []): string {
  return [
    'You have tools. When a request needs facts a tool can give (the weather, the owner\'s notes, …), call the tool: never guess or make them up. Then say briefly what you found or did; never read out raw tool output.',
    'Only say you did something (saved, added, changed, looked up) if a tool call in this reply did it and succeeded. If a tool failed, say so.',
    ...(instructions.length > 0 ? ['About the tools:', ...instructions.map((i) => `- ${i}`)] : []),
    // Told, not just left without the tools: otherwise the model says "Deleted." with nothing to delete with.
    ...(kindsOff.length > 0
      ? [
          `The owner has switched off tools that ${kindsOff.map(verb).join(', ')}${blocked.length ? `, so these are unavailable: ${blocked.join(', ')}` : ''}. ` +
            `If a request needs any of that, say plainly that it's switched off in the Tools tab. Don't offer another way to do it, and never say or imply you did it or noted it.`,
        ]
      : []),
  ].join('\n')
}

function verb(kind: Crud): string {
  return { create: 'create', read: 'read', update: 'change', delete: 'delete' }[kind] + ' things'
}

/** Around each tool call (e.g. the skill guard: rules before a governed file is changed). */
export interface CallHooks {
  /** Returns an outcome to refuse the call with, or null to go ahead. */
  before?(name: string, args: Record<string, unknown>, crud: string[]): ToolOutcome | null
  after?(name: string, args: Record<string, unknown>, crud: string[], outcome: ToolOutcome): ToolOutcome
}

/** A tool that runs inside Jarvis itself (not an MCP plugin), e.g. showing a file on the owner's screen. */
export interface BuiltinTool {
  tool: FunctionTool
  label: string
  crud: string[]
  run(args: Record<string, unknown>): Promise<ToolOutcome>
}

/** Whether the LLM may use a tool, by its function name ("files__read_text_file"). */
export type ToolAllow = (functionName: string) => boolean

export const harness = new Harness()
export type { LoopMessage, LoopResult, PluginLink, PluginStatus }

/**
 * tools__load, offered while some plugin has tools on demand that aren't loaded
 * yet (and the agent may use one of them): it loads that plugin's on-demand
 * tools for the rest of the reply, and returns their names (and, for a plugin
 * on demand as a whole, its instructions).
 */
function loadTool(
  hub: McpHub,
  allow: ToolAllow,
  deferrals: { name: string; whole: boolean; tools: string[] }[],
  loaded: Set<string>,
  hidden: (name: string) => boolean,
): BuiltinTool[] {
  const plugins = deferrals
    .filter((d) => !loaded.has(d.name) && hub.tools().some((t) => hub.pluginOf(t.function.name) === d.name && allow(t.function.name) && hidden(t.function.name)))
    .map((d) => d.name)
  if (plugins.length === 0) return []
  return [
    {
      label: 'Loading tools',
      crud: [],
      tool: {
        type: 'function',
        function: {
          name: 'tools__load',
          description: 'Load the tools of a plugin that the instructions list as on demand, when the request needs them. Afterwards they can be called.',
          parameters: { type: 'object', properties: { plugin: { type: 'string', enum: plugins, description: 'The plugin, e.g. "browser".' } }, required: ['plugin'] } as Record<string, unknown>,
        },
      },
      run: async (args) => {
        const plugin = String(args.plugin ?? '')
        if (!plugins.includes(plugin)) return { text: `No plugin "${plugin}" to load here: ${plugins.join(', ') || 'none'}.`, isError: true }
        // The tools that were waiting (the rest of the plugin was offered already).
        const names = hub.tools().filter((t) => hub.pluginOf(t.function.name) === plugin && allow(t.function.name) && hidden(t.function.name)).map((t) => t.function.name)
        loaded.add(plugin)
        const whole = deferrals.find((d) => d.name === plugin)?.whole
        const about = whole ? hub.instructions(allow).filter((s) => s.startsWith(`${plugin}: `)) : []
        return { text: `Loaded ${plugin}: ${names.join(', ')}. You can call them now.${about.length ? ` ${about.join(' ')}` : ''}`, isError: false }
      },
    },
  ]
}
