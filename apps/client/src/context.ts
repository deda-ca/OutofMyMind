// The context meter's data (server: apps/server/src/assistant/context.ts):
// what the last request to the local model held, by section.

import { reactive } from 'vue'

export interface ContextSection {
  key: string
  label: string
  tokens: number
  items?: { label: string; tokens: number }[]
}

export interface ContextStats {
  at: string
  model: string
  limit: number
  used: number
  cached: number | null
  reply: number | null
  sections: ContextSection[]
}

export const context = reactive({
  stats: null as ContextStats | null,
  /** The window size, known even before the first request. */
  limit: 0,
})

export async function loadContext(): Promise<void> {
  try {
    const response = await fetch('/api/context')
    if (!response.ok) return
    const body = (await response.json()) as { stats: ContextStats | null; limit: number }
    context.stats = body.stats
    context.limit = body.stats?.limit || body.limit
  } catch {
    // the meter just stays empty
  }
}

export function onContext(stats: ContextStats): void {
  context.stats = stats
  if (stats.limit) context.limit = stats.limit
}

/** 31,204 → "31K"; 262,144 → "256K"; 812 → "812". */
export function shortTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return `${Math.round(n / 1000)}K`
}
