// The notifier and the scheduler, one each for the server (started by app.ts).

import path from 'node:path'
import type { AgentLibrary } from '../agents/library.ts'
import { config } from '../config.ts'
import { harness } from '../harness/index.ts'
import type { SessionStore } from '../sessions/store.ts'
import type { SkillLibrary } from '../skills/library.ts'
import { Notifier } from './notifier.ts'
import { scheduledRun } from './run.ts'
import { Scheduler } from './scheduler.ts'
import { scheduleTools } from './tools.ts'

export const notifier = new Notifier(path.join(config.dataDir, 'notifications.json'))

let scheduler: Scheduler | null = null

/** The scheduler, once started (null in tests that don't start it). */
export function schedules(): Scheduler | null {
  return scheduler
}

export function startSchedules(deps: { agents: AgentLibrary; skills: SkillLibrary; sessions: SessionStore; log: (message: string, err?: unknown) => void }): Scheduler {
  if (scheduler) return scheduler
  const kindOn = (kind: 'create' | 'delete') => harness.kinds()[kind]
  const s: Scheduler = new Scheduler(path.join(config.workspaceDir, 'schedules.json'), {
    notifier,
    log: deps.log,
    run: scheduledRun({
      agents: deps.agents,
      skills: deps.skills,
      notifier,
      builtins: (scheduleId, followUp) => scheduleTools({ scheduler: s, notifier, kindOn, unattended: { scheduleId, followUp } }),
    }),
    // In the active session: so "snooze it", "what did it say?" make sense afterwards.
    record: (note, outcome) => {
      const at = new Date().toISOString()
      deps.sessions.record({ kind: 'note', at, text: note })
      if (outcome && (outcome.text || outcome.tools.length)) deps.sessions.record({ kind: 'jarvis', at, text: outcome.text || '(Done.)', ...(outcome.tools.length ? { tools: outcome.tools } : {}) })
    },
  })
  s.on('change', () => notifier.broadcast({ type: 'schedules' }))
  s.start()
  scheduler = s
  return s
}

export function stopSchedules(): void {
  scheduler?.stop()
  scheduler = null
  notifier.close()
}

/** The schedule tools for a live reply (none if the scheduler isn't running). */
export function liveScheduleTools() {
  if (!scheduler) return []
  return scheduleTools({ scheduler, notifier, kindOn: (kind) => harness.kinds()[kind] })
}
