// Which plugins and tools the owner has switched off (the Tools tab).
//
// Kept apart from the plugin file (mcp.json): that says which plugins exist
// and how to start them; this says which of their tools the LLM may use. A
// plugin switched off here keeps running, its tools are just not offered.
// Everything is on unless listed:
//
//   { "disabledPlugins": ["weather"], "disabledTools": { "notes": ["delete_note"] }, "disabledKinds": ["delete"] }
//
// disabledKinds switches off every tool that does that kind of thing (CRUD,
// see crud.ts), including tools of plugins added later.

import fs from 'node:fs'
import path from 'node:path'
import { CRUD, type Crud } from './crud.ts'

interface State {
  disabledPlugins: string[]
  disabledTools: Record<string, string[]>
  disabledKinds: Crud[]
}

export class ToolToggles {
  private state?: State
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  pluginEnabled(plugin: string): boolean {
    return !this.load().disabledPlugins.includes(plugin)
  }

  /** The tool's own switch (regardless of its plugin's). */
  toolEnabled(plugin: string, tool: string): boolean {
    return !(this.load().disabledTools[plugin] ?? []).includes(tool)
  }

  kindEnabled(kind: Crud): boolean {
    return !this.load().disabledKinds.includes(kind)
  }

  /** Whether the LLM may use the tool: it and its plugin are on, and so is every kind of thing it does. */
  allowed(plugin: string, tool: string, crud: Crud[] = []): boolean {
    return this.pluginEnabled(plugin) && this.toolEnabled(plugin, tool) && crud.every((k) => this.kindEnabled(k))
  }

  setPlugin(plugin: string, enabled: boolean): void {
    const state = this.load()
    state.disabledPlugins = state.disabledPlugins.filter((p) => p !== plugin)
    if (!enabled) state.disabledPlugins.push(plugin)
    this.save()
  }

  setTool(plugin: string, tool: string, enabled: boolean): void {
    const state = this.load()
    const tools = (state.disabledTools[plugin] ?? []).filter((t) => t !== tool)
    if (!enabled) tools.push(tool)
    if (tools.length > 0) state.disabledTools[plugin] = tools
    else delete state.disabledTools[plugin]
    this.save()
  }

  setKind(kind: Crud, enabled: boolean): void {
    const state = this.load()
    state.disabledKinds = state.disabledKinds.filter((k) => k !== kind)
    if (!enabled) state.disabledKinds.push(kind)
    this.save()
  }

  private load(): State {
    if (this.state) return this.state
    let parsed: Partial<State> = {}
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<State>
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${this.file}: ${(err as Error).message}`)
    }
    this.state = {
      disabledPlugins: Array.isArray(parsed.disabledPlugins) ? parsed.disabledPlugins.filter((p) => typeof p === 'string') : [],
      disabledTools:
        parsed.disabledTools && typeof parsed.disabledTools === 'object'
          ? Object.fromEntries(Object.entries(parsed.disabledTools).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.filter((t) => typeof t === 'string')]))
          : {},
      disabledKinds: Array.isArray(parsed.disabledKinds) ? CRUD.filter((k) => parsed.disabledKinds!.includes(k)) : [],
    }
    return this.state
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`)
    fs.renameSync(tmp, this.file)
  }
}
