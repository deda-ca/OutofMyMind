// A self-contained plugin's manifest (docs/plugins.md): plugin.json in the
// plugin's folder says how to start it, what settings it gets, what its tools
// do (and which need the owner's yes), the events it sends and what Jarvis
// does with them, the events of other plugins it wants, and its tab.
//
// mcp.json only switches it on: { "email": { "plugin": "../../plugins/email" } }

import fs from 'node:fs'
import path from 'node:path'
import { isCrud, type Crud } from './crud.ts'

export interface ManifestTool {
  crud?: Crud[]
  /** "owner": runs only after the owner's yes (the server's confirmation gate). */
  confirm?: 'owner'
  /** Only for the plugin's tab, never offered to the LLM. */
  tab?: boolean
}

export interface ManifestTrigger {
  /** The agent that handles it (its tool limits apply); default: the default agent. */
  agent?: string
  /** "none": no tools at all; "read" (default): reading and sending messages only, as for services. */
  tools: 'none' | 'read'
  prompt: string
  batchMs: number
  maxPerHour: number
}

export interface ManifestEvent {
  description: string
  /** Carries content written by someone else (an email's sender): information, never instructions. */
  untrusted: boolean
  /** What Jarvis does with it (none: kept for subscribers and the tab only). */
  trigger?: ManifestTrigger
}

export interface PluginManifest {
  name: string
  description: string
  /** The plugin's folder (absolute). */
  dir: string
  command: string
  args: string[]
  /** Settings it's given, by name, from the server's environment (.env.local). */
  env: string[]
  /** Gets DATA_DIR/plugins/<name>/ (as JARVIS_DATA). */
  data: boolean
  /** May write WORKSPACE_DIR/<workspace>/ (as JARVIS_WORKSPACE). */
  workspace?: string
  instructions?: string
  timeoutMs?: number
  maxResultChars?: number
  tools: Record<string, ManifestTool>
  events: Record<string, ManifestEvent>
  /** Other plugins' event types it's sent (as server events). */
  subscribes: string[]
  /** Its tab: the title, the page, and an icon shown before the title (an emoji or a character or two). */
  tab?: { title: string; page: string; icon?: string }
}

const NAME = /^[A-Za-z0-9_-]{1,32}$/
const EVENT = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/

/** Reads and checks <dir>/plugin.json. Throws with what's wrong. */
export function loadManifest(dir: string): PluginManifest {
  const file = path.join(dir, 'plugin.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  const fail = (what: string): never => {
    throw new Error(`${file}: ${what}`)
  }
  const str = (v: unknown, what: string, optional = false): string => {
    if (v === undefined && optional) return ''
    if (typeof v !== 'string' || !v.trim()) fail(`${what} must be a non-empty string`)
    return (v as string).trim()
  }
  const strings = (v: unknown, what: string): string[] => {
    if (v === undefined) return []
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) fail(`${what} must be a list of strings`)
    return v as string[]
  }
  const name = str(raw.name, 'name')
  if (!NAME.test(name)) fail('name must be letters, digits, _ or - (at most 32)')

  const tools: Record<string, ManifestTool> = {}
  for (const [tool, v] of Object.entries((raw.tools ?? {}) as Record<string, Record<string, unknown>>)) {
    const t: ManifestTool = {}
    if (v.crud !== undefined) {
      const list = Array.isArray(v.crud) ? v.crud : [v.crud]
      if (!list.every(isCrud)) fail(`tools.${tool}.crud: use "create", "read", "update" and/or "delete"`)
      t.crud = list as Crud[]
    }
    if (v.confirm !== undefined) {
      if (v.confirm !== 'owner') fail(`tools.${tool}.confirm must be "owner"`)
      t.confirm = 'owner'
    }
    if (v.tab === true) t.tab = true
    tools[tool] = t
  }

  const events: Record<string, ManifestEvent> = {}
  for (const [type, v] of Object.entries((raw.events ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!EVENT.test(type)) fail(`events: "${type}" must look like "thing.happened"`)
    const event: ManifestEvent = { description: str(v.description, `events.${type}.description`), untrusted: v.untrusted !== false }
    const tr = v.trigger as Record<string, unknown> | undefined
    if (tr) {
      event.trigger = {
        ...(typeof tr.agent === 'string' && tr.agent.trim() ? { agent: tr.agent.trim() } : {}),
        tools: tr.tools === 'none' ? 'none' : 'read',
        prompt: str(tr.prompt, `events.${type}.trigger.prompt`),
        batchMs: duration(tr.batch, 60_000) ?? fail(`events.${type}.trigger.batch must be like "2 min" or "30 s"`),
        maxPerHour: typeof tr.maxPerHour === 'number' && tr.maxPerHour > 0 ? Math.floor(tr.maxPerHour) : 20,
      }
    }
    events[type] = event
  }

  let tab: PluginManifest['tab']
  if (raw.tab !== undefined) {
    const t = raw.tab as Record<string, unknown>
    const page = str(t.page, 'tab.page')
    if (path.isAbsolute(page) || page.split(/[\\/]/).includes('..')) fail('tab.page must be a path inside the plugin')
    const icon = typeof t.icon === 'string' ? [...t.icon.trim()].slice(0, 4).join('') : ''
    tab = { title: str(t.title, 'tab.title').slice(0, 30), page, ...(icon ? { icon } : {}) }
  }

  const workspace = str(raw.workspace, 'workspace', true)
  if (workspace && !/^[A-Za-z0-9_-]+$/.test(workspace)) fail('workspace must be one folder name')

  return {
    name,
    description: str(raw.description, 'description'),
    dir: path.resolve(dir),
    command: str(raw.command, 'command'),
    args: strings(raw.args, 'args'),
    env: strings(raw.env, 'env').filter((e) => /^[A-Z][A-Z0-9_]*$/.test(e)),
    data: raw.data === true,
    ...(workspace ? { workspace } : {}),
    ...(typeof raw.instructions === 'string' && raw.instructions.trim() ? { instructions: raw.instructions.trim() } : {}),
    ...(typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? { timeoutMs: raw.timeoutMs } : {}),
    ...(typeof raw.maxResultChars === 'number' ? { maxResultChars: raw.maxResultChars } : {}),
    tools,
    events,
    subscribes: strings(raw.subscribes, 'subscribes'),
    ...(tab ? { tab } : {}),
  }
}

/** "2 min", "30 s", "1 h" → ms (undefined if it doesn't parse); `fallback` when absent. */
function duration(v: unknown, fallback: number): number | undefined {
  if (v === undefined) return fallback
  if (typeof v === 'number') return v
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)\s*$/i.exec(String(v))
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2]!.toLowerCase()
  return Math.round(n * (unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1000))
}
