// LLM connections (config.jsonc llm.connections): several providers at once,
// each agent picking "connection/model". Without the list, the single llm.url /
// llm.model / llm.apiKey is one connection called "local", as before.
//
//   openai      any OpenAI-compatible host: OpenAI, xAI Grok, OpenRouter, Groq,
//               llama.cpp, Ollama, LM Studio, vLLM (llm.ts speaks to it directly)
//   anthropic   Claude, through Anthropic's own API (anthropic.ts)

import Anthropic from '@anthropic-ai/sdk'
import { config, configFile } from '../config.ts'
import type { Price } from './usage.ts'

export interface Connection {
  id: string
  label: string
  kind: 'openai' | 'anthropic'
  url: string
  apiKey?: string
  /** The model agents on it use unless they name another. */
  model: string
  /** The models offered in the pickers (empty: the ones it lists). */
  models: string[]
  vision: boolean
  /** A llama.cpp server: /tokenize and /props for the context meter; asked for replies without thinking. */
  llamaCpp: boolean
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  contextWindow?: number
  /** Extra request fields (openai kind). */
  extra?: Record<string, unknown>
  /** Dollars per million tokens, by model ("*": any); Claude's are built in, llama.cpp is free (usage.ts). */
  prices?: Record<string, Price>
  /** Dollars a day: once spent, new turns use the default model instead. */
  budget?: number
}

export class ModelError extends Error {}

const ID = /^[A-Za-z0-9_-]{1,32}$/
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** "${NAME}" from the environment. */
const expand = (v: string) => v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => process.env[n] ?? '')

/** The connections from a config file's root (exported for tests), or the single one from llm.url/model/apiKey. */
export function readConnections(root: Record<string, unknown>, fallback = { url: config.llmUrl, model: config.llmModel, apiKey: config.llmApiKey, vision: config.llmVision }): Connection[] {
  const llm = (root.llm ?? {}) as Record<string, unknown>
  const list = llm.connections
  if (list === undefined) {
    return [
      {
        id: 'local',
        label: 'Local',
        kind: 'openai',
        url: fallback.url,
        ...(fallback.apiKey ? { apiKey: fallback.apiKey } : {}),
        model: fallback.model,
        models: [],
        vision: fallback.vision,
        llamaCpp: true,
      },
    ]
  }
  if (!Array.isArray(list) || list.length === 0) throw new ModelError('llm.connections should be a list of connections, like [{ "id": "local", "kind": "openai", "url": "…" }]')
  const seen = new Set<string>()
  return list.map((raw, i): Connection => {
    const c = (raw ?? {}) as Record<string, unknown>
    const where = `llm.connections[${i}]`
    const str = (k: string) => (typeof c[k] === 'string' ? expand(c[k] as string).trim() : '')
    const id = str('id')
    if (!ID.test(id)) throw new ModelError(`${where}.id should be a short name (letters, digits, _ or -)`)
    if (seen.has(id)) throw new ModelError(`${where}: there are two connections called "${id}"`)
    seen.add(id)
    const kind = c.kind === undefined ? 'openai' : c.kind
    if (kind !== 'openai' && kind !== 'anthropic') throw new ModelError(`${where}.kind should be "openai" or "anthropic"`)
    const url = str('url')
    if (kind === 'openai' && !url) throw new ModelError(`${where}: an openai connection needs its "url"`)
    const effort = str('effort')
    if (effort && !EFFORTS.has(effort)) throw new ModelError(`${where}.effort should be low, medium, high, xhigh or max`)
    const models = Array.isArray(c.models) ? (c.models as unknown[]).filter((m): m is string => typeof m === 'string' && m.trim() !== '').map((m) => m.trim()) : []
    const model = str('model') || models[0] || (kind === 'anthropic' ? 'claude-opus-5-5' : '')
    if (!model) throw new ModelError(`${where}: give its "model" (or a "models" list)`)
    return {
      id,
      label: str('label') || id,
      kind,
      url: url || (kind === 'anthropic' ? 'https://api.anthropic.com' : ''),
      ...(str('apiKey') ? { apiKey: str('apiKey') } : {}),
      model,
      models,
      vision: typeof c.vision === 'boolean' ? c.vision : kind === 'anthropic',
      llamaCpp: c.llamaCpp === true,
      ...(effort ? { effort: effort as Connection['effort'] } : {}),
      ...(typeof c.contextWindow === 'number' && c.contextWindow > 0 ? { contextWindow: c.contextWindow } : {}),
      ...(c.extra && typeof c.extra === 'object' && !Array.isArray(c.extra) ? { extra: c.extra as Record<string, unknown> } : {}),
      ...(c.prices !== undefined ? { prices: readPrices(c.prices, `${where}.prices`) } : {}),
      ...(c.budget !== undefined ? { budget: positive(c.budget, `${where}.budget`) } : {}),
    }
  })
}

function positive(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ModelError(`${where} should be a number of dollars (0 or more)`)
  return v
}

/** { "model": { "input": 3, "output": 15, "cacheRead": 0.3 } }: dollars per million tokens. */
function readPrices(v: unknown, where: string): Record<string, Price> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ModelError(`${where} should be { "model": { "input": …, "output": … } } (dollars per million tokens)`)
  const out: Record<string, Price> = {}
  for (const [model, raw] of Object.entries(v as Record<string, unknown>)) {
    const p = (raw ?? {}) as Record<string, unknown>
    const at = `${where}.${model}`
    out[model] = {
      input: positive(p.input, `${at}.input`),
      output: positive(p.output, `${at}.output`),
      ...(p.cacheRead !== undefined ? { cacheRead: positive(p.cacheRead, `${at}.cacheRead`) } : {}),
      ...(p.cacheWrite !== undefined ? { cacheWrite: positive(p.cacheWrite, `${at}.cacheWrite`) } : {}),
    }
  }
  return out
}

let cached: Connection[] | null = null

/** The connections (llm.connections read once from config.jsonc; the single llm.url one follows config as it is). */
export function connections(): Connection[] {
  if ((configFile.root.llm as Record<string, unknown> | undefined)?.connections === undefined) return readConnections({})
  cached ??= readConnections(configFile.root)
  return cached
}

/** "connection/model" → the connection and the model (the model may itself contain "/"). */
export function splitRef(ref: string): { connection: string; model: string } | null {
  const at = ref.indexOf('/')
  if (at <= 0 || at === ref.length - 1) return null
  return { connection: ref.slice(0, at), model: ref.slice(at + 1) }
}

/** The default "connection/model": llm.default, else the first connection's model. */
export function defaultRef(list = connections(), chosen = process.env.LLM_DEFAULT?.trim() ?? ''): string {
  const r = chosen ? splitRef(chosen) : null
  if (r && list.some((c) => c.id === r.connection)) return chosen
  return `${list[0]!.id}/${list[0]!.model}`
}

/**
 * Which connection and model to use for "connection/model" (an agent's choice),
 * or the default. An unknown connection falls back to the default (said in `note`).
 */
export function resolve(ref?: string, list = connections()): { connection: Connection; model: string; note?: string } {
  const pick = (r: { connection: string; model: string }) => {
    const c = list.find((x) => x.id === r.connection)
    return c ? { connection: c, model: r.model } : null
  }
  const wanted = ref ? splitRef(ref) : null
  const found = wanted ? pick(wanted) : null
  if (found) return found
  const fallback = pick(splitRef(defaultRef(list))!)!
  return wanted ? { ...fallback, note: `the connection "${wanted.connection}" isn't in llm.connections: using ${fallback.connection.id}/${fallback.model}` } : fallback
}

// ------------------------------------------------------------------ listing models (for the pickers)

const listCache = new Map<string, { at: number; models: string[]; error?: string }>()

/** The models a connection offers: its "models" list, else what it lists itself (cached 5 minutes). */
export async function listModels(c: Connection): Promise<{ models: string[]; error?: string }> {
  if (c.models.length) return { models: c.models }
  const hit = listCache.get(c.id)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit
  let result: { models: string[]; error?: string }
  try {
    if (c.kind === 'anthropic') {
      const client = new Anthropic({ apiKey: c.apiKey, baseURL: c.url, timeout: 10_000, maxRetries: 1 })
      const ids: string[] = []
      for await (const m of client.models.list()) ids.push(m.id)
      result = { models: ids }
    } else {
      const r = await fetch(new URL('/v1/models', c.url), { headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}, signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = (await r.json()) as { data?: { id?: unknown }[] }
      result = { models: (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean).sort() }
    }
  } catch (err) {
    result = { models: [c.model], error: `couldn't list its models: ${(err as Error).message}` }
  }
  if (!result.models.includes(c.model)) result.models.unshift(c.model)
  listCache.set(c.id, { at: Date.now(), ...result })
  return result
}
