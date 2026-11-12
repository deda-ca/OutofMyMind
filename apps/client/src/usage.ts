// What the LLMs cost (server: apps/server/src/assistant/usage.ts): today by
// model and by source, this month, the session, and each connection's daily
// budget. Re-read when the server says it changed.

import { reactive } from 'vue'
import { shortTokens } from './context'

export interface Totals {
  requests: number
  input: number
  cached: number
  cacheWrite: number
  output: number
  cost: number
  unpriced: number
}

export interface UsageSummary {
  date: string
  today: { total: Totals; models: Record<string, Totals>; sources: Record<string, Totals>; connections: Record<string, number> } | null
  month: Totals
  session: Totals | null
  budgets: { connection: string; label: string; budget: number; spent: number }[]
}

/** One reply's cost (sent with it). */
export interface ReplyUsage {
  model: string
  input: number
  output: number
  /** null: the model has no price. */
  cost: number | null
}

export const usage = reactive({ summary: null as UsageSummary | null })

export async function loadUsage(): Promise<void> {
  try {
    const response = await fetch('/api/usage')
    if (response.ok) usage.summary = (await response.json()) as UsageSummary
  } catch {
    // the badge just stays as it was
  }
}

/** 0.0213 → "$0.021"; 1.5 → "$1.50"; 0 → "$0". */
export function dollars(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4).replace(/0+$/, '')}`
  if (n < 1) return `$${n.toFixed(3).replace(/0$/, '')}`
  return `$${n.toFixed(2)}`
}

/** "claude/claude-opus-5-5 · 12K in · 340 out · $0.051" (the cost left out for a model without a price). */
export function replyLine(u: ReplyUsage): string {
  return [u.model, `${shortTokens(u.input)} in`, `${shortTokens(u.output)} out`, ...(u.cost === null ? [] : [u.cost === 0 ? 'free' : dollars(u.cost)])].join(' · ')
}
