// The harness: Jarvis's own agent loop, with tools from plug-in MCP servers.
//
// Started once at server start-up (main.ts) from the plugin file (MCP_CONFIG,
// default mcp.json). With no plugins configured it's inactive and replies are
// plain chat, exactly as before. Plugins live in /mcp-plugins; any other MCP
// server (stdio or streamable HTTP) can be added to the file too.

import type { AgentEvent, ChatTarget } from '../assistant/llm.ts'
import { loadPluginConfig } from './config.ts'
import { runLoop, type LoopMessage, type LoopResult } from './loop.ts'
import { McpHub, type PluginStatus } from './mcp.ts'

class Harness {
  private hub?: McpHub

  async start(configFile: string, log: (message: string, err?: unknown) => void): Promise<void> {
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
    this.hub = new McpHub(plugins, log)
    await this.hub.start()
  }

  /** Whether any plugin offers tools right now. */
  get active(): boolean {
    return (this.hub?.tools().length ?? 0) > 0
  }

  status(): PluginStatus[] {
    return this.hub?.status() ?? []
  }

  /** Answers with the tool loop. */
  run(target: ChatTarget, messages: LoopMessage[], onDelta: (text: string) => void, signal?: AbortSignal, onEvent?: (event: AgentEvent) => void): Promise<LoopResult> {
    if (!this.hub) throw new Error('The harness has no plugins')
    return runLoop(target, withToolGuidance(messages, this.hub.instructions()), this.hub, { onDelta, onEvent, signal })
  }

  async close(): Promise<void> {
    await this.hub?.close()
    this.hub = undefined
  }
}

/**
 * Adds how to use the tools to the system message: never guess what a tool
 * can tell (a model asked "what's the temperature?" otherwise invents one),
 * and what each plugin says about itself (e.g. the owner's home town).
 */
export function withToolGuidance(messages: LoopMessage[], instructions: string[]): LoopMessage[] {
  const guidance = [
    'You have tools. When a request needs facts a tool can give (the weather, the owner\'s notes, …), call the tool: never guess or make them up. Then say briefly what you found or did; never read out raw tool output.',
    'Only say you did something (saved, added, changed, looked up) if a tool call in this reply did it and succeeded. If a tool failed, say so.',
    ...(instructions.length > 0 ? ['About the tools:', ...instructions.map((i) => `- ${i}`)] : []),
  ].join('\n')
  const [first, ...rest] = messages
  if (first?.role === 'system') return [{ role: 'system', content: `${first.content}\n${guidance}` }, ...rest]
  return [{ role: 'system', content: guidance }, ...messages]
}

export const harness = new Harness()
export type { LoopMessage, LoopResult, PluginStatus }
