// Jarvis's tools for its services (docs/services.md). It writes a service's
// files with the file tools (WORKSPACE_DIR/services/<id>/); these tell it
// where they stand and let it test, pause and ask for secrets. Approving is
// not a tool: only the owner approves, in the Services tab, or puts a service
// in development mode, where every change Jarvis saves is approved by itself.

import type { BuiltinTool } from '../harness/index.ts'
import { ServiceError, type ServiceView, type Supervisor } from './supervisor.ts'
import type { Vault } from './vault.ts'
import { VaultError } from './vault.ts'

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export function serviceTools(supervisor: Supervisor, vault: Vault): BuiltinTool[] {
  const tool = (name: string, label: string, crud: string[], description: string, properties: Record<string, unknown>, required: string[], run: BuiltinTool['run']): BuiltinTool => ({
    label,
    crud,
    tool: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } },
    run: async (args) => {
      try {
        return await run(args)
      } catch (err) {
        if (err instanceof ServiceError || err instanceof VaultError) return { text: err.message, isError: true }
        throw err
      }
    },
  })
  const nameArg = { name: { type: 'string', description: 'The service id: its folder name under services/.' } }

  return [
    tool(
      'jarvis__services_list',
      'Jarvis: services',
      ['read'],
      "Jarvis's background services (WORKSPACE_DIR/services/<id>/): each one's status (waiting for approval, running, paused, failing, a problem in its service.md), last run, and what it may do. Give a name for one service in detail. Check this after writing or changing a service.",
      nameArg,
      [],
      async (args) => {
        const name = str(args.name)
        const views = name ? [supervisor.get(name)] : supervisor.list()
        if (!views.length) return { text: 'No services yet. A service is a folder services/<id>/ with service.md and main.ts (the services skill says how).', isError: false }
        const { turns, limit } = supervisor.triggers.budget()
        return { text: [...views.map((v) => describe(v, !!name)), `Service turns today: ${turns} of ${limit}.`].join('\n\n'), isError: false }
      },
    ),
    tool(
      'jarvis__service_log',
      'Jarvis: service log',
      ['read'],
      "The end of a service's log: what it printed (secrets blanked out), the gate's notes (refused connections, events), and each run's result. Read it when a service fails.",
      { ...nameArg, lines: { type: 'number', description: 'How many lines (default 80, at most 400).' } },
      ['name'],
      async (args) => {
        const lines = Math.min(400, Math.max(1, Number(args.lines) || 80))
        const text = supervisor.log(str(args.name), lines)
        return { text: text || '(The log is empty: it hasn\'t run yet.)', isError: false }
      },
    ),
    tool(
      'jarvis__service_run_now',
      'Jarvis: run service',
      ['update'],
      'Run a service now, to test it, and get the result and its log. In development mode the latest version runs (your saved changes are approved automatically); otherwise the approved version runs, and changes not yet approved do not.',
      nameArg,
      ['name'],
      async (args) => {
        const name = str(args.name)
        const run = await supervisor.runNow(name)
        const log = supervisor.log(name, 40)
        return { text: `Run ${run.result} in ${(run.ms / 1000).toFixed(1)} s (${run.stats.events} events, ${run.stats.connections} connections, ${run.stats.refused} refused).\n\nLog:\n${log}`, isError: !run.ok }
      },
    ),
    tool('jarvis__service_pause', 'Jarvis: pause service', ['update'], 'Pause a service: it stops running and its waiting events are dropped, until resumed.', nameArg, ['name'], async (args) => {
      supervisor.pause(str(args.name), 'Jarvis')
      return { text: `Paused ${str(args.name)}.`, isError: false }
    }),
    tool('jarvis__service_resume', 'Jarvis: resume service', ['update'], 'Resume a paused service.', nameArg, ['name'], async (args) => {
      supervisor.resume(str(args.name))
      return { text: `Resumed ${str(args.name)}.`, isError: false }
    }),
    tool(
      'jarvis__services_stop_all',
      'Jarvis: stop all services',
      ['update'],
      'The kill switch: pause every service at once and drop their waiting events (when the owner says "stop all services").',
      {},
      [],
      async () => {
        const n = supervisor.stopAll('the owner (stop all)')
        return { text: n ? `Paused ${n} service${n === 1 ? '' : 's'}.` : 'No service was running.', isError: false }
      },
    ),
    tool(
      'jarvis__service_needs_secret',
      'Jarvis: ask for a secret',
      ['create'],
      "Ask the owner to type a secret (a password, an API key) that a service needs: it appears in the Services tab for them to fill in. You never see the value. Name it as in the service's \"secrets:\"; for a login, ask for JSON like {\"user\": \"…\", \"password\": \"…\"} in the description.",
      {
        name: { type: 'string', description: 'The secret\'s name, as listed under "secrets:" (letters, digits, - and _).' },
        description: { type: 'string', description: 'What it is and what to type, for the owner (e.g. \'IMAP login for the main inbox, as {"user": "…", "password": "…"}\').' },
      },
      ['name', 'description'],
      async (args) => {
        const name = str(args.name)
        if (vault.has(name)) return { text: `The secret "${name}" is already set.`, isError: false }
        vault.request(name, str(args.description))
        supervisor.emit('change')
        return { text: `Asked: the owner will see "${name}" in the Services tab to type it. Tell them.`, isError: false }
      },
    ),
  ]
}

function describe(v: ServiceView, detail: boolean): string {
  const lines = [`${v.name} (services/${v.id}): ${v.status}. ${v.statusText}${v.running ? ' Running now.' : ''}`]
  if (v.developing) lines.push('Development mode: save changes and run it with jarvis__service_run_now; no approval needed. Tell the owner when it works so they can lock it.')
  if (v.lastRun) lines.push(`Last run ${v.lastRun.at}: ${v.lastRun.result} (${v.lastRun.stats.events} events${v.lastRun.stats.refused ? `, ${v.lastRun.stats.refused} connections refused` : ''}).`)
  if (v.failures) lines.push(`${v.failures} failure${v.failures === 1 ? '' : 's'} in a row: read its log.`)
  if (v.error && v.status !== 'error') lines.push(`Problem in service.md now: ${v.error}`)
  if (v.waitingEvents) lines.push(`${v.waitingEvents} events waiting.`)
  if (detail) {
    lines.push(...v.permissions.map((p) => `- ${p}`))
    if (v.secrets.length) lines.push(`Secrets: ${v.secrets.map((s) => `${s.name} (${s.set ? 'set' : 'not set'})`).join(', ')}`)
  }
  return lines.join('\n')
}
