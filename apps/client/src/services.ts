// Jarvis's background services (server: apps/server/src/services, design:
// docs/services.md): the list, the secrets (names only), today's turns.
// Reloaded whenever the server says something changed (notifications stream).

import { reactive } from 'vue'

export interface GateStats {
  connections: number
  refused: number
  bytesOut: number
  bytesIn: number
  secretsRead: string[]
  events: number
}

export interface ServiceView {
  id: string
  name: string
  description: string
  status: 'active' | 'waiting' | 'changed' | 'rejected' | 'paused' | 'needs-secret' | 'error' | 'missing'
  statusText: string
  every?: string
  running: boolean
  nextRunAt?: string
  lastRun?: { at: string; ms: number; ok: boolean; result: string; stats: GateStats }
  failures: number
  error?: string
  pending: boolean
  hash?: string
  permissions: string[]
  secrets: { name: string; set: boolean }[]
  waitingEvents: number
  paused?: { at: string; by: string }
  /** Development mode: Jarvis's changes are approved automatically (until null: until locked). */
  developing?: { since: string; until: string | null }
  approvedBy?: 'owner' | 'development'
  approvedAt?: string
}

export interface SecretView {
  name: string
  description: string
  set: boolean
  setAt?: string
  requested?: boolean
  usedBy: string[]
}

export const servicesState = reactive({
  list: [] as ServiceView[],
  secrets: [] as SecretView[],
  budget: { turns: 0, limit: 0 },
  /** Services are off (SERVICES=off) or the server can't be reached. */
  error: '',
})

/** What needs the owner: approvals and missing secrets. */
export function servicesNeedingOwner(): number {
  return servicesState.list.filter((s) => (s.status === 'waiting' || s.status === 'changed' || s.status === 'needs-secret') && !s.error).length
}

export async function loadServices(): Promise<void> {
  try {
    const response = await fetch('/api/services')
    const body = (await response.json().catch(() => ({}))) as { services?: ServiceView[]; secrets?: SecretView[]; budget?: { turns: number; limit: number }; error?: string }
    if (!response.ok) {
      servicesState.error = body.error ?? `HTTP ${response.status}`
      return
    }
    servicesState.error = ''
    servicesState.list = body.services ?? []
    servicesState.secrets = body.secrets ?? []
    servicesState.budget = body.budget ?? { turns: 0, limit: 0 }
  } catch (err) {
    servicesState.error = (err as Error).message
  }
}
