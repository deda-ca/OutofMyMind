// config.jsonc: Jarvis's settings in one commented JSON file, with sections
// (settings.ts lists them all). Read at start-up, before anything else reads
// a setting: each value fills its environment variable (PORT, LLM_URL, …),
// which the rest of Jarvis reads as before. An environment variable that's
// already set wins over the file.
//
//   CONFIG_FILE=path/to/file.jsonc   another file;  CONFIG_FILE=off   none (the tests)
//
// "${NAME}" in a value is replaced from the environment, so a secret can stay
// out of the file ("apiKey": "${OPENAI_API_KEY}").
//
// The same table makes the commented file (renderConfig: the example, and
// `npm run config:init`, which moves .env and .env.local into config.jsonc)
// and the JSON Schema an editor uses to check the file as it's typed.

import fs from 'node:fs'
import path from 'node:path'
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser'
import { SECTIONS, type Setting, SETTINGS } from './settings.ts'

export interface ConfigFileStatus {
  file: string
  found: boolean
  /** Settings the file gave. */
  applied: string[]
  /** Settings the file has but the environment overrode. */
  overridden: string[]
  /** Unknown settings, references to unset variables. */
  warnings: string[]
}

export class ConfigError extends Error {}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const chosen = env.CONFIG_FILE?.trim()
  if (chosen && /^(off|none|false|0)$/i.test(chosen)) return null
  return path.resolve(chosen || 'config.jsonc')
}

/** "line 12, column 5" for an offset in text. */
function where(text: string, offset: number): string {
  const before = text.slice(0, offset).split('\n')
  return `line ${before.length}, column ${before.at(-1)!.length + 1}`
}

function lookup(root: Record<string, unknown>, dotted: string): unknown {
  let at: unknown = root
  for (const part of dotted.split('.')) {
    if (!at || typeof at !== 'object' || Array.isArray(at)) return undefined
    at = (at as Record<string, unknown>)[part]
  }
  return at
}

/**
 * Reads the config file and fills the environment from it (only variables
 * that aren't set). Throws a ConfigError saying where the file is wrong.
 */
export function loadConfigFile(env: NodeJS.ProcessEnv = process.env, file = configFilePath(env)): ConfigFileStatus {
  // Read once per process (the release binary reads it before the server does, to set its own defaults after).
  const cache = (globalThis as { [LOADED]?: Map<string, ConfigFileStatus> })[LOADED] ??= new Map()
  const key = env === process.env ? (file ?? '(none)') : ''
  if (key && cache.has(key)) return cache.get(key)!
  const status = readInto(env, file)
  if (key) cache.set(key, status)
  return status
}

const LOADED = Symbol.for('jarvis.configFile')

function readInto(env: NodeJS.ProcessEnv, file: string | null): ConfigFileStatus {
  const status: ConfigFileStatus = { file: file ?? '(none)', found: false, applied: [], overridden: [], warnings: [] }
  if (!file || !fs.existsSync(file)) return status
  status.found = true
  const text = fs.readFileSync(file, 'utf8')
  const errors: ParseError[] = []
  const root = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown
  if (errors.length) {
    throw new ConfigError(`${file}: ${errors.map((e) => `${printParseErrorCode(e.error)} at ${where(text, e.offset)}`).join('; ')}`)
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new ConfigError(`${file}: the file must be one { … } object`)
  const obj = root as Record<string, unknown>

  // Unknown sections and settings: probably a typo, said once at start-up.
  const sections = new Set(SECTIONS.map((s) => s.name))
  const known = new Set(SETTINGS.map((s) => s.path))
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$schema') continue
    if (!sections.has(key)) {
      status.warnings.push(`unknown section "${key}"`)
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      status.warnings.push(`"${key}" should be a { … } section`)
      continue
    }
    for (const name of Object.keys(value)) if (!known.has(`${key}.${name}`)) status.warnings.push(`unknown setting "${key}.${name}"`)
  }

  const problems: string[] = []
  const original = { ...env }
  for (const s of SETTINGS) {
    const raw = lookup(obj, s.path)
    if (raw === undefined || raw === null) continue
    let value: string
    try {
      value = toEnv(s, raw, (name) => {
        const v = original[name]
        if (v === undefined) status.warnings.push(`${s.path} uses \${${name}}, which isn't set`)
        return v ?? ''
      })
    } catch (err) {
      problems.push(`${s.path}: ${(err as Error).message}`)
      continue
    }
    if (value === '') continue
    if (original[s.env]?.trim()) {
      if (original[s.env]!.trim() !== value) status.overridden.push(s.path)
      continue
    }
    env[s.env] = value
    status.applied.push(s.path)
  }
  if (problems.length) throw new ConfigError(`${file}: ${problems.join('; ')}`)
  return status
}

/** A value from the file as its environment variable's text. Throws saying what's wrong. */
export function toEnv(s: Setting, raw: unknown, variable: (name: string) => string = () => ''): string {
  const expand = (v: string) => v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => variable(name))
  switch (s.type) {
    case 'boolean':
      if (typeof raw !== 'boolean') throw new Error('should be true or false')
      return raw ? 'on' : 'off'
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(expand(raw)) : Number.NaN
      if (!Number.isFinite(n)) throw new Error('should be a number')
      if (s.min !== undefined && n < s.min) throw new Error(`should be at least ${s.min}`)
      if (s.max !== undefined && n > s.max) throw new Error(`should be at most ${s.max}`)
      return String(n)
    }
    case 'list':
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) throw new Error('should be a list of strings, like ["a", "b"]')
      return raw.map((x) => expand(x).trim()).filter(Boolean).join(',')
    default: {
      // Phone numbers and the like may be written without quotes: taken as text.
      if (typeof raw !== 'string' && typeof raw !== 'number') throw new Error('should be text in "quotes"')
      const v = expand(String(raw)).trim()
      if (v && s.enum && !s.enum.includes(v)) throw new Error(`should be one of ${s.enum.map((e) => `"${e}"`).join(', ')}`)
      return v
    }
  }
}

/** An environment variable's text as the file's value (for moving .env into config.jsonc). */
export function fromEnv(s: Setting, text: string): string | number | boolean | string[] | undefined {
  const t = text.trim()
  if (!t) return undefined
  switch (s.type) {
    case 'boolean':
      return /^(1|on|true|yes)$/i.test(t) ? true : /^(0|off|false|no)$/i.test(t) ? false : undefined
    case 'number':
      return Number.isFinite(Number(t)) ? Number(t) : undefined
    case 'list':
      return t
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    default:
      return t
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The commented config file: every section and setting with what it does;
 * the given values written, the rest commented out with their defaults.
 */
export function renderConfig(values: Record<string, unknown> = {}, opts: { schema?: string; header?: string[] } = {}): string {
  const out: string[] = []
  const comment = (text: string, indent: string) => out.push(...text.split('\n').map((l) => `${indent}// ${l}`))
  out.push(...(opts.header ?? []).map((l) => `// ${l}`))
  out.push('{')
  if (opts.schema) out.push(`  "$schema": ${JSON.stringify(opts.schema)},`)
  SECTIONS.forEach((section, si) => {
    const settings = SETTINGS.filter((s) => s.path.startsWith(`${section.name}.`))
    const real = settings.filter((s) => values[s.path] !== undefined)
    out.push('')
    comment(section.doc, '  ')
    out.push(`  ${JSON.stringify(section.name)}: {`)
    settings.forEach((s) => {
      const name = s.path.slice(section.name.length + 1)
      const kind = s.type === 'secret' ? ' (secret)' : ''
      const choices = s.enum ? ` One of: ${s.enum.join(', ')}.` : ''
      comment(`${s.doc}${choices}${kind}`, '    ')
      if (values[s.path] !== undefined) {
        const last = real.at(-1) === s
        out.push(`    ${JSON.stringify(name)}: ${JSON.stringify(values[s.path])}${last ? '' : ','}`)
      } else {
        out.push(`    // ${JSON.stringify(name)}: ${s.default !== undefined ? JSON.stringify(s.default) : '""'}`)
      }
    })
    out.push(`  }${si < SECTIONS.length - 1 ? ',' : ''}`)
  })
  out.push('}', '')
  return out.join('\n')
}

/** The JSON Schema for config.jsonc: an editor checks and completes the file with it. */
export function configSchema(): Record<string, unknown> {
  const prop = (s: Setting) => {
    const base: Record<string, unknown> = { description: s.doc }
    if (s.type === 'boolean') base.type = 'boolean'
    else if (s.type === 'number') Object.assign(base, { type: 'number' }, s.min !== undefined ? { minimum: s.min } : {}, s.max !== undefined ? { maximum: s.max } : {})
    else if (s.type === 'list') Object.assign(base, { type: 'array', items: { type: 'string' } })
    else Object.assign(base, { type: ['string', 'number'] }, s.enum ? { enum: s.enum } : {})
    if (s.default !== undefined) base.default = s.default
    return base
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Jarvis configuration (config.jsonc)',
    type: 'object',
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      ...Object.fromEntries(
        SECTIONS.map((section) => [
          section.name,
          {
            description: section.doc,
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(SETTINGS.filter((s) => s.path.startsWith(`${section.name}.`)).map((s) => [s.path.slice(section.name.length + 1), prop(s)])),
          },
        ]),
      ),
    },
  }
}

/** What config.jsonc should hold for these environment values: only what differs from the defaults. */
export function valuesFromEnv(env: NodeJS.ProcessEnv): { values: Record<string, unknown>; skipped: string[] } {
  const values: Record<string, unknown> = {}
  for (const s of SETTINGS) {
    const text = env[s.env]
    if (text === undefined) continue
    const v = fromEnv(s, text)
    if (v === undefined || same(v, s.default)) continue
    values[s.path] = v
  }
  const mapped = new Set(SETTINGS.map((s) => s.env))
  return { values, skipped: Object.keys(env).filter((k) => !mapped.has(k)) }
}
