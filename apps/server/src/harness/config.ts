// Which MCP servers ("plugins") the harness connects to: a JSON file in the
// same `mcpServers` format other MCP clients use, so third-party servers can
// be dropped in as they are.
//
//   {
//     "mcpServers": {
//       "notes":    { "command": "node", "args": ["../../plugins/notes/server.ts"], "env": { "NOTES_DIR": "${DATA_DIR}/notes" } },
//       "calendar": { "url": "http://127.0.0.1:3001/mcp", "headers": { "Authorization": "Bearer ${CALENDAR_TOKEN}" }, "enabled": false }
//     }
//   }
//
// `${NAME}` in args, env, url and headers is replaced from the server's
// environment (which config.jsonc fills: secrets stay there), plus DATA_DIR and WORKSPACE_DIR.
// An optional "instructions" string is extra guidance for the LLM about the
// plugin (e.g. how the workspace folder is laid out), Jarvis-only. stdio plugins
// run with the config file's folder as their working directory, and get only
// a minimal environment plus their own `env`, not the server's secrets.

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.ts'
import { isCrud, type Crud } from './crud.ts'
import { loadManifest, type PluginManifest } from './manifest.ts'

export type PluginTransport =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { kind: 'http'; url: string; headers: Record<string, string> }

export interface PluginConfig {
  name: string
  transport: PluginTransport
  /** Longest a single tool call may take. */
  timeoutMs: number
  /** Extra guidance for the LLM about this plugin (mcp.json "instructions"), added to the plugin's own. */
  instructions?: string
  /** CRUD tags for tools whose names don't say what they do (mcp.json "crud": { "<tool>": ["read"] }). */
  crud?: Record<string, Crud[]>
  /** Tools never offered to the LLM, and refused if called (mcp.json "exclude": ["<tool>"]): too dangerous to switch on from the Tools tab. */
  exclude?: string[]
  /** Longest tool result handed to the LLM (mcp.json "maxResultChars"; default 8,000). */
  maxResultChars?: number
  /** A self-contained plugin's manifest (plugin.json): its events, tab, and tools needing the owner's yes. */
  manifest?: PluginManifest
  /**
   * "on demand": its tools aren't sent with every request; the LLM sees one line
   * (`summary`) and loads them with tools__load (docs/tool-loading.md). Default: always.
   */
  load?: 'always' | 'on demand'
  summary?: string
}

const DEFAULT_TIMEOUT_MS = 30_000

/** The enabled plugins in the file; none if it doesn't exist. Throws if it's malformed. */
export function loadPluginConfig(file: string): PluginConfig[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, Record<string, unknown>> }
  const servers = parsed.mcpServers ?? {}
  const dir = path.dirname(path.resolve(file))
  const plugins: PluginConfig[] = []
  for (const [name, entry] of Object.entries(servers)) {
    if (entry.enabled === false) continue
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error(`${file}: plugin name "${name}" must be letters, digits, _ or - (at most 32)`)
    const timeoutMs = typeof entry.timeoutMs === 'number' && entry.timeoutMs > 0 ? entry.timeoutMs : DEFAULT_TIMEOUT_MS
    const instructions = typeof entry.instructions === 'string' && entry.instructions.trim() ? expand(entry.instructions.trim()) : undefined
    const crud = crudOverrides(entry.crud, `${file}: plugin "${name}" crud`)
    const extra: Pick<PluginConfig, 'exclude' | 'maxResultChars' | 'load' | 'summary'> = {}
    if (entry.load !== undefined) {
      if (entry.load !== 'always' && entry.load !== 'on demand') throw new Error(`${file}: plugin "${name}" load must be "always" or "on demand"`)
      extra.load = entry.load
    }
    if (entry.summary !== undefined) {
      if (typeof entry.summary !== 'string' || !entry.summary.trim()) throw new Error(`${file}: plugin "${name}" summary must be a short line of text`)
      extra.summary = entry.summary.trim().slice(0, 200)
    }
    if (extra.load === 'on demand' && !extra.summary) throw new Error(`${file}: plugin "${name}" is "on demand" and needs a "summary" (one line: what its tools are for)`)
    if (entry.exclude !== undefined) extra.exclude = stringArray(entry.exclude, `${name}.exclude`)
    if (entry.maxResultChars !== undefined) {
      if (typeof entry.maxResultChars !== 'number' || !Number.isInteger(entry.maxResultChars) || entry.maxResultChars < 1000 || entry.maxResultChars > 100_000)
        throw new Error(`${file}: plugin "${name}" maxResultChars must be a whole number from 1000 to 100000`)
      extra.maxResultChars = entry.maxResultChars
    }
    if (typeof entry.plugin === 'string') {
      // A self-contained plugin (docs/plugins.md): everything but "on" comes from its plugin.json.
      const manifest = loadManifest(path.resolve(dir, expand(entry.plugin)))
      if (manifest.name !== name) throw new Error(`${file}: "${name}" points at the plugin "${manifest.name}" (the names must match)`)
      plugins.push({ ...pluginFromManifest(manifest, mapValues(stringRecord(entry.env, `${name}.env`), expand)), ...extra })
      continue
    }
    if (typeof entry.command === 'string') {
      plugins.push({
        name,
        timeoutMs,
        instructions,
        crud,
        ...extra,
        transport: {
          kind: 'stdio',
          command: expand(entry.command),
          args: stringArray(entry.args, `${name}.args`).map(expand),
          env: mapValues(stringRecord(entry.env, `${name}.env`), expand),
          cwd: typeof entry.cwd === 'string' ? path.resolve(dir, expand(entry.cwd)) : dir,
        },
      })
    } else if (typeof entry.url === 'string') {
      plugins.push({ name, timeoutMs, instructions, crud, ...extra, transport: { kind: 'http', url: expand(entry.url), headers: mapValues(stringRecord(entry.headers, `${name}.headers`), expand) } })
    } else {
      throw new Error(`${file}: plugin "${name}" needs a "command" (stdio) or a "url" (HTTP)`)
    }
  }
  return plugins
}

/** How a self-contained plugin is started: in its folder, with only the settings it names, its data and workspace folders. */
export function pluginFromManifest(m: PluginManifest, extraEnv: Record<string, string> = {}): PluginConfig {
  const env: Record<string, string> = {}
  for (const key of m.env) if (process.env[key] !== undefined) env[key] = process.env[key]!
  if (m.data) {
    env.JARVIS_DATA = path.join(config.dataDir, 'plugins', m.name)
    fs.mkdirSync(env.JARVIS_DATA, { recursive: true })
  }
  if (m.workspace) env.JARVIS_WORKSPACE = path.join(config.workspaceDir, m.workspace)
  // The release binary runs built-in plugins itself (`jarvis plugin <name>`).
  const binary = process.env.JARVIS_BIN
  const command = binary ? binary : m.command
  const args = binary ? ['plugin', m.name] : m.args
  const crud = Object.fromEntries(Object.entries(m.tools).flatMap(([tool, t]) => (t.crud ? [[tool, t.crud]] : [])))
  return {
    name: m.name,
    timeoutMs: m.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(m.instructions ? { instructions: expand(m.instructions) } : {}),
    ...(Object.keys(crud).length ? { crud } : {}),
    ...(m.maxResultChars ? { maxResultChars: m.maxResultChars } : {}),
    manifest: m,
    transport: { kind: 'stdio', command, args, env: { ...env, ...extraEnv }, cwd: m.dir },
  }
}

function crudOverrides(value: unknown, what: string): Record<string, Crud[]> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) throw new Error(`${what} must be an object of tool name → ["create" | "read" | "update" | "delete", …]`)
  const out: Record<string, Crud[]> = {}
  for (const [tool, kinds] of Object.entries(value)) {
    const list = Array.isArray(kinds) ? kinds : [kinds]
    if (!list.every(isCrud)) throw new Error(`${what}.${tool}: use "create", "read", "update" and/or "delete"`)
    out[tool] = list
  }
  return out
}

function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => (key === 'DATA_DIR' ? config.dataDir : key === 'WORKSPACE_DIR' ? config.workspaceDir : (process.env[key] ?? '')))
}

function stringArray(value: unknown, what: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new Error(`${what} must be a list of strings`)
  return value
}

function stringRecord(value: unknown, what: string): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || !Object.values(value).every((v) => typeof v === 'string')) {
    throw new Error(`${what} must be an object of strings`)
  }
  return value as Record<string, string>
}

function mapValues(record: Record<string, string>, fn: (v: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, fn(v)]))
}
