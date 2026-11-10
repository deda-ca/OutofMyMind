// The supervisor and the vault, one each for the server (started by app.ts),
// unless SERVICES=off. Design: docs/services.md.

import path from 'node:path'
import type { AgentLibrary } from '../agents/library.ts'
import { config } from '../config.ts'
import { notifier } from '../schedule/index.ts'
import type { SessionStore } from '../sessions/store.ts'
import type { SkillLibrary } from '../skills/library.ts'
import { Supervisor } from './supervisor.ts'
import { seedServicesSkill } from './skill.ts'
import { serviceTools } from './tools.ts'
import { serviceTurn } from './turn.ts'
import { Vault } from './vault.ts'

let supervisor: Supervisor | null = null
let vault: Vault | null = null

/** The supervisor and vault, once started (null when SERVICES=off, or in tests that don't start them). */
export function services(): { supervisor: Supervisor; vault: Vault } | null {
  return supervisor && vault ? { supervisor, vault } : null
}

export function startServices(deps: { agents: AgentLibrary; skills: SkillLibrary; sessions: SessionStore; log: (message: string, err?: unknown) => void }): void {
  if (supervisor || !config.services) return
  try {
    seedServicesSkill(config.workspaceDir, config.dataDir)
  } catch (err) {
    deps.log("services: couldn't write the services skill", err)
  }
  const v = new Vault(path.join(config.dataDir, 'secrets.json'))
  const tell = (title: string, text: string) => void notifier.notify({ title, text, urgency: 'info', speak: false })
  const s: Supervisor = new Supervisor({
    servicesDir: path.join(config.workspaceDir, 'services'),
    dataDir: config.dataDir,
    vault: v,
    dailyTurns: config.servicesDailyTurns,
    localHosts: config.servicesLocalHosts,
    runTurn: serviceTurn({
      agents: deps.agents,
      skills: deps.skills,
      notify: tell,
      record: (note, reply, tools) => {
        const at = new Date().toISOString()
        deps.sessions.record({ kind: 'note', at, text: note })
        deps.sessions.record({ kind: 'jarvis', at, text: reply, ...(tools.length ? { tools } : {}) })
      },
      log: (id, line) => s.logLine(id, line),
    }),
    tell,
    note: (text) => deps.sessions.record({ kind: 'note', at: new Date().toISOString(), text }),
    log: deps.log,
  })
  s.on('change', () => notifier.broadcast({ type: 'services' }))
  s.start()
  supervisor = s
  vault = v
}

export async function stopServices(): Promise<void> {
  await supervisor?.stop()
  supervisor = null
  vault = null
}

/** Jarvis's service tools for a live reply (none if services are off). */
export function liveServiceTools() {
  return supervisor && vault ? serviceTools(supervisor, vault) : []
}
