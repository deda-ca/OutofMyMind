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
// environment (so secrets stay in .env.local), plus DATA_DIR. stdio plugins
// run with the config file's folder as their working directory, and get only
// a minimal environment plus their own `env`, not the server's secrets.

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.ts'

export type PluginTransport =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { kind: 'http'; url: string; headers: Record<string, string> }

export interface PluginConfig {
  name: string
  transport: PluginTransport
  /** Longest a single tool call may take. */
  timeoutMs: number
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
    if (typeof entry.command === 'string') {
      plugins.push({
        name,
        timeoutMs,
        transport: {
          kind: 'stdio',
          command: expand(entry.command),
          args: stringArray(entry.args, `${name}.args`).map(expand),
          env: mapValues(stringRecord(entry.env, `${name}.env`), expand),
          cwd: typeof entry.cwd === 'string' ? path.resolve(dir, expand(entry.cwd)) : dir,
        },
      })
    } else if (typeof entry.url === 'string') {
      plugins.push({ name, timeoutMs, transport: { kind: 'http', url: expand(entry.url), headers: mapValues(stringRecord(entry.headers, `${name}.headers`), expand) } })
    } else {
      throw new Error(`${file}: plugin "${name}" needs a "command" (stdio) or a "url" (HTTP)`)
    }
  }
  return plugins
}

function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => (key === 'DATA_DIR' ? config.dataDir : (process.env[key] ?? '')))
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
