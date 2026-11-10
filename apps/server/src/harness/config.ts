// Which MCP servers ("plugins") the harness connects to: a JSON file in the
// same `mcpServers` format other MCP clients use, so third-party servers can
// be dropped in as they are.
//
//   {
//     "mcpServers": {
//       "notes":    { "command": "node", "args": ["../../mcp-plugins/notes/server.ts"], "env": { "NOTES_DIR": "${DATA_DIR}/notes" } },
//       "calendar": { "url": "http://127.0.0.1:3001/mcp", "headers": { "Authorization": "Bearer ${CALENDAR_TOKEN}" }, "enabled": false }
//     }
//   }
//
// `${NAME}` in args, env, url and headers is replaced from the server's
// environment (so secrets stay in .env.local), plus DATA_DIR and WORKSPACE_DIR.
// An optional "instructions" string is extra guidance for the LLM about the
// plugin (e.g. how the workspace folder is laid out), Jarvis-only. stdio plugins
// run with the config file's folder as their working directory, and get only
// a minimal environment plus their own `env`, not the server's secrets.

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.ts'
import { isCrud, type Crud } from './crud.ts'

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
    const extra: Pick<PluginConfig, 'exclude' | 'maxResultChars'> = {}
    if (entry.exclude !== undefined) extra.exclude = stringArray(entry.exclude, `${name}.exclude`)
    if (entry.maxResultChars !== undefined) {
      if (typeof entry.maxResultChars !== 'number' || !Number.isInteger(entry.maxResultChars) || entry.maxResultChars < 1000 || entry.maxResultChars > 100_000)
        throw new Error(`${file}: plugin "${name}" maxResultChars must be a whole number from 1000 to 100000`)
      extra.maxResultChars = entry.maxResultChars
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
