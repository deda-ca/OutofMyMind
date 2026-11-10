// The supervisor (docs/services.md): finds the services in
// WORKSPACE_DIR/services, works out where each stands (waiting for approval,
// running on its schedule, paused, failing), runs approved ones in their
// sandbox on time, and does what the owner (Services tab) or Jarvis (its
// tools) asks: approve, reject, run now, pause, resume, stop everything.
//
// On disk, outside the workspace (DATA_DIR):
//   services.json              approvals and pauses (approvals.ts)
//   secrets.json               the vault (vault.ts)
//   services/<id>/approved/    the approved files, as approved (for diffs)
//   services/<id>/run/         what runs: those files plus node_modules
//   services/<id>/state/       the service's own files (/state in the sandbox)
//   services/<id>/log.txt      its output and the gate's notes, secrets blanked
//   services/<id>/runs.json    recent runs

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { Approvals, diffFiles, FolderError, hashFiles, installCopy, readFolder, type ServiceRecord } from './approvals.ts'
import { Gate, type GateStats } from './gate.ts'
import { describePermissions, ManifestError, ms, parseManifest, SERVICE_ID, widened, type Manifest } from './manifest.ts'
import { checkSandbox, runService, type RunResult } from './sandbox.ts'
import { Triggers, type TurnRequest } from './triggers.ts'
import type { Vault } from './vault.ts'

export type ServiceStatus = 'active' | 'waiting' | 'changed' | 'rejected' | 'paused' | 'needs-secret' | 'error' | 'missing'

export interface RunRecord {
  at: string
  ms: number
  ok: boolean
  /** "finished", "failed (exit 1)", "stopped: took too long", … */
  result: string
  stats: GateStats
}

export interface ServiceView {
  id: string
  name: string
  description: string
  status: ServiceStatus
  /** The status in a sentence. */
  statusText: string
  /** The approved manifest's schedule. */
  every?: string
  running: boolean
  nextRunAt?: string
  lastRun?: RunRecord
  failures: number
  /** What's wrong with service.md as it is now. */
  error?: string
  /** The folder differs from what was approved (or nothing was approved yet). */
  pending: boolean
  /** The hash of the folder as it is now (approve this one). */
  hash?: string
  /** What the approved version may do (or, if none, what the current one asks for). */
  permissions: string[]
  secrets: { name: string; set: boolean }[]
  waitingEvents: number
  paused?: { at: string; by: string }
  /** In development mode: Jarvis's changes are approved automatically. until null: until the owner locks it. */
  developing?: { since: string; until: string | null }
  /** Who approved the version that runs. */
  approvedBy?: 'owner' | 'development'
  approvedAt?: string
}

export interface Changes {
  hash: string
  /** What it may do that the approved version can't (everything, if new). */
  widened: string[]
  /** Everything it may do. */
  permissions: string[]
  files: { file: string; status: 'added' | 'changed' | 'deleted'; diff: string }[]
  error?: string
}

export interface SupervisorOptions {
  /** WORKSPACE_DIR/services. */
  servicesDir: string
  /** DATA_DIR. */
  dataDir: string
  vault: Vault
  dailyTurns: number
  localHosts?: string[]
  /** An unattended LLM turn for a batch of events. */
  runTurn: (turn: TurnRequest) => Promise<void>
  /** A notification for the owner (not spoken). */
  tell: (title: string, text: string) => void
  /** A note in the active session (so Jarvis knows). */
  note: (text: string) => void
  log: (message: string, err?: unknown) => void
  /** How often to check for due runs (0: never by itself; tests call tick()). */
  tickMs?: number
  now?: () => number
}

const LOG_KEEP = 2000
const RUNS_KEEP = 50
/** After this many failures in a row: wait 10 min, then 1 h, then pause. */
const BACKOFF = [10 * 60_000, 60 * 60_000]
const FAILURES_BEFORE_BACKOFF = 3

interface Scanned {
  id: string
  dir: string
  files?: Map<string, string>
  hash?: string
  manifest?: Manifest
  error?: string
}

export class ServiceError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export class Supervisor extends EventEmitter<{ change: [] }> {
  readonly triggers: Triggers
  private readonly o: Required<Omit<SupervisorOptions, 'localHosts'>> & { localHosts: string[] }
  private readonly approvals: Approvals
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>()
  private readonly failures = new Map<string, number>()
  private timer?: ReturnType<typeof setInterval>
  private watcher?: fs.FSWatcher
  private changeTimer?: ReturnType<typeof setTimeout>
  private sandboxProblem: string | null = null
  private stopped = false

  constructor(o: SupervisorOptions) {
    super()
    this.o = { tickMs: 5000, now: Date.now, localHosts: [], ...o }
    this.approvals = new Approvals(path.join(o.dataDir, 'services.json'))
    this.triggers = new Triggers({
      dir: this.runtime(),
      dailyTurns: o.dailyTurns,
      run: o.runTurn,
      tell: o.tell,
      log: (id, line) => this.logLine(id, line),
      now: this.o.now,
    })
  }

  start(): void {
    fs.mkdirSync(this.o.servicesDir, { recursive: true })
    fs.mkdirSync(this.runtime(), { recursive: true })
    this.sandboxProblem = checkSandbox()
    if (this.sandboxProblem) this.o.log(`services: ${this.sandboxProblem}; services won't run`)
    try {
      this.watcher = fs.watch(this.o.servicesDir, { recursive: true }, () => {
        clearTimeout(this.changeTimer)
        this.changeTimer = setTimeout(() => void this.developmentSync().finally(() => this.emit('change')), 500)
      })
      this.watcher.on('error', (err) => this.o.log('services: stopped watching the services folder', err))
    } catch (err) {
      this.o.log("services: can't watch the services folder", err)
    }
    if (this.o.tickMs > 0) this.timer = setInterval(() => this.tick(), this.o.tickMs)
    this.tick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    clearTimeout(this.changeTimer)
    this.watcher?.close()
    for (const r of this.running.values()) r.abort.abort()
    await Promise.all([...this.running.values()].map((r) => r.done))
    await this.triggers.stop()
  }

  // ── Listing ────────────────────────────────────────────────────────────────

  list(): ServiceView[] {
    const ids = new Set([...this.folderIds(), ...this.approvals.ids()])
    return [...ids].sort().map((id) => this.view(this.scan(id)))
  }

  get(id: string): ServiceView {
    return this.view(this.scan(this.known(id)))
  }

  /** What approving the folder as it is now would change. */
  changes(id: string): Changes {
    const s = this.scan(this.known(id))
    if (!s.files || !s.hash) throw new ServiceError(s.error ?? `The folder services/${id} is gone`, 404)
    const record = this.approvals.get(id)
    const approvedFiles = record.approved ? this.approvedFiles(id) : new Map<string, string>()
    return {
      hash: s.hash,
      widened: s.manifest ? widened(record.approved?.manifest, s.manifest) : [],
      permissions: s.manifest ? describePermissions(s.manifest) : [],
      files: diffFiles(approvedFiles, s.files),
      ...(s.error ? { error: s.error } : {}),
    }
  }

  log(id: string, lines = 100): string {
    this.known(id)
    try {
      const all = fs.readFileSync(this.logFile(id), 'utf8').split('\n')
      return all.slice(-Math.max(1, Math.min(lines, LOG_KEEP)) - 1).join('\n').trim()
    } catch {
      return ''
    }
  }

  // ── What the owner (or Jarvis) does ────────────────────────────────────────

  /**
   * The owner approves the folder as it was when they looked (its hash); or,
   * by 'development', the supervisor does, for a service in development mode.
   */
  async approve(id: string, hash: string, by: 'owner' | 'development' = 'owner'): Promise<void> {
    const s = this.scan(this.known(id))
    if (!s.files || !s.manifest || !s.hash) throw new ServiceError(s.error ? `It can't be approved: ${s.error}` : `The folder services/${id} is gone`)
    if (s.hash !== hash) throw new ServiceError('It changed since you looked at it: look at the changes again.', 409)
    const record = this.approvals.get(id)
    await this.running.get(id)?.done
    this.logLine(id, by === 'development' ? `approved automatically, development mode (${s.hash})` : `approved (${s.hash})`)
    try {
      await installCopy(this.runDir(id), s.files, s.manifest.packages, record.approved?.manifest.packages, (line) => this.logLine(id, line))
    } catch (err) {
      this.logLine(id, `approval failed: ${(err as Error).message}`)
      throw new ServiceError(`Couldn't set it up: ${(err as Error).message}`, 500)
    }
    const approvedDir = path.join(this.serviceRuntime(id), 'approved')
    fs.rmSync(approvedDir, { recursive: true, force: true })
    for (const [name, text] of s.files) {
      fs.mkdirSync(path.dirname(path.join(approvedDir, name)), { recursive: true })
      fs.writeFileSync(path.join(approvedDir, name), text)
    }
    const failing = record.paused?.by === 'failing'
    this.approvals.update(id, (r) => {
      const next: ServiceRecord = { ...r, approved: { hash: s.hash!, approvedAt: new Date(this.o.now()).toISOString(), manifest: s.manifest!, by } }
      delete next.rejectedHash
      if (failing) delete next.paused
      return next
    })
    this.failures.delete(id)
    this.autoFailed.delete(id)
    this.emit('change')
    // While developing, Jarvis runs it when it wants (run_now); the schedule carries on as before.
    if (by === 'development') return
    this.dueNow.add(id) // the new version runs now
    this.o.note(`The owner approved the service "${s.manifest.name}" (services/${id})${record.approved ? ': the new version runs from now on' : ''}.`)
    this.tick()
  }

  /**
   * Development mode (the owner only): every change saved in the folder is
   * approved automatically (new hosts, secrets and packages too), so Jarvis
   * can edit, run, read the log and edit again. `hours` null: until the owner
   * locks it. What's there now is approved straight away.
   */
  async develop(id: string, hours: number | null): Promise<void> {
    this.known(id)
    if (hours !== null && !(hours > 0 && hours <= 24 * 30)) throw new ServiceError('Development mode lasts from a few minutes to 30 days, or until locked.')
    const now = this.o.now()
    const until = hours === null ? null : new Date(now + hours * 3_600_000).toISOString()
    this.approvals.update(id, (r) => ({ ...r, developing: { since: new Date(now).toISOString(), until } }))
    this.logLine(id, `development mode on${until ? ` until ${until}` : ' until locked'}`)
    const name = this.get(id).name
    this.o.note(
      `The owner put the service "${name}" (services/${id}) in development mode${until ? ` until ${new Date(until).toLocaleString()}` : ' until they lock it'}: ` +
        'every change you save there is approved automatically, permissions included. jarvis__service_run_now runs the latest version; read jarvis__service_log, fix, run again. Tell the owner when it works, so they can lock it.',
    )
    await this.autoApprove(id)
    this.emit('change')
  }

  /** Ends development mode: the version approved now stays, and later changes wait for the owner again. */
  lock(id: string, why: 'the owner' | 'time' = 'the owner'): void {
    this.known(id)
    const record = this.approvals.get(id)
    if (!record.developing) return
    this.approvals.update(id, (r) => {
      const next = { ...r }
      delete next.developing
      return next
    })
    this.logLine(id, why === 'time' ? 'development mode ended (its time was up): locked' : 'locked by the owner')
    const name = this.get(id).name
    this.o.note(`The service "${name}" (services/${id}) is locked${why === 'time' ? ' (its development time ran out)' : ' by the owner'}: from now on, changes to it wait for the owner's approval again.`)
    if (why === 'time') this.o.tell(`${name} is locked`, 'Its development time ran out: the version approved now keeps running, and further changes wait for you.')
    this.emit('change')
  }

  /** In development mode now (an expired one is locked here). */
  private developing(id: string): boolean {
    const d = this.approvals.get(id).developing
    if (!d) return false
    if (d.until && new Date(d.until).getTime() <= this.o.now()) {
      this.lock(id, 'time')
      return false
    }
    return true
  }

  /** A version auto-approval couldn't set up (npm failed): not retried until the folder changes again. */
  private readonly autoFailed = new Map<string, string>()

  /** In development mode: approves the folder as it is now, if it changed and service.md is fine. */
  private async autoApprove(id: string): Promise<void> {
    if (!this.developing(id)) return
    const s = this.scan(id)
    if (!s.hash || !s.manifest || s.hash === this.approvals.get(id).approved?.hash || this.autoFailed.get(id) === s.hash) return
    try {
      await this.approve(id, s.hash, 'development')
    } catch (err) {
      this.autoFailed.set(id, s.hash)
      this.logLine(id, `couldn't approve the latest version automatically: ${(err as Error).message}`)
    }
  }

  private async developmentSync(): Promise<void> {
    for (const id of this.approvals.ids()) if (this.approvals.get(id).developing) await this.autoApprove(id)
  }

  reject(id: string, hash: string): void {
    const s = this.scan(this.known(id))
    if (s.hash !== hash) throw new ServiceError('It changed since you looked at it: look at the changes again.', 409)
    this.approvals.update(id, (r) => ({ ...r, rejectedHash: hash }))
    this.logLine(id, `rejected (${hash})`)
    this.o.note(`The owner turned down the ${this.approvals.get(id).approved ? 'changes to' : 'new'} service "${s.manifest?.name ?? id}" (services/${id}).${this.approvals.get(id).approved ? ' The approved version keeps running.' : ''}`)
    this.emit('change')
  }

  pause(id: string, by: string): void {
    this.known(id)
    this.approvals.update(id, (r) => ({ ...r, paused: { at: new Date(this.o.now()).toISOString(), by } }))
    this.running.get(id)?.abort.abort()
    this.triggers.clear(id)
    this.logLine(id, `paused by ${by}`)
    this.emit('change')
  }

  resume(id: string): void {
    this.known(id)
    this.approvals.update(id, (r) => {
      const next = { ...r }
      delete next.paused
      return next
    })
    this.failures.delete(id)
    this.logLine(id, 'resumed')
    this.emit('change')
  }

  /** Runs an approved service now (to test it); in development mode, the latest version. Resolves when the run is over. */
  async runNow(id: string): Promise<RunRecord> {
    this.known(id)
    if (this.developing(id)) {
      await this.autoApprove(id)
      const latest = this.scan(id)
      if (latest.error) throw new ServiceError(`The latest version can't run: ${latest.error}`)
      if (latest.hash && latest.hash === this.autoFailed.get(id)) throw new ServiceError(`The latest version couldn't be set up (its log says why): ${this.log(id, 3)}`)
    }
    const s = this.scan(id)
    const record = this.approvals.get(id)
    if (!record.approved) throw new ServiceError("It hasn't been approved yet: the owner approves it in the Services tab.")
    if (this.sandboxProblem) throw new ServiceError(this.sandboxProblem, 503)
    if (!s.files) throw new ServiceError(`The folder services/${id} is gone`, 404)
    if (this.running.has(id)) {
      await this.running.get(id)!.done
      return this.readRuns(id).at(-1)!
    }
    await this.run(id, record.approved.manifest)
    return this.readRuns(id).at(-1)!
  }

  /** The kill switch: everything paused, runs stopped, waiting events dropped. */
  stopAll(by: string): number {
    let n = 0
    for (const v of this.list()) {
      if (v.paused) continue
      this.pause(v.id, by)
      n++
    }
    this.triggers.clear()
    return n
  }

  /** Deletes a service: its folder, its approved copy, state and log. */
  async remove(id: string): Promise<void> {
    this.known(id)
    this.running.get(id)?.abort.abort()
    await this.running.get(id)?.done
    this.triggers.clear(id)
    fs.rmSync(path.join(this.o.servicesDir, id), { recursive: true, force: true })
    fs.rmSync(this.serviceRuntime(id), { recursive: true, force: true })
    this.approvals.update(id, () => undefined)
    this.emit('change')
  }

  // ── Running ────────────────────────────────────────────────────────────────

  private readonly dueNow = new Set<string>()

  /** Starts the runs that are due. */
  tick(): void {
    if (this.stopped || this.sandboxProblem) return
    const now = this.o.now()
    for (const id of this.approvals.ids()) {
      this.developing(id) // locks one whose time is up
      const record = this.approvals.get(id)
      if (!record.approved || record.paused || this.running.has(id)) continue
      if (!fs.existsSync(path.join(this.o.servicesDir, id))) continue
      const m = record.approved.manifest
      if (m.secrets.some((name) => !this.o.vault.has(name))) continue
      const next = this.nextRun(id, m)
      if (next !== undefined && next > now && !this.dueNow.has(id)) continue
      this.dueNow.delete(id)
      void this.run(id, m)
    }
  }

  private nextRun(id: string, m: Manifest): number | undefined {
    const last = this.readRuns(id).at(-1)
    if (!last) return undefined
    const failures = this.failures.get(id) ?? 0
    const wait = failures >= FAILURES_BEFORE_BACKOFF ? Math.max(m.everyMs, BACKOFF[Math.min(failures - FAILURES_BEFORE_BACKOFF, BACKOFF.length - 1)]!) : m.everyMs
    return new Date(last.at).getTime() + last.ms + wait
  }

  private run(id: string, m: Manifest): Promise<void> {
    const abort = new AbortController()
    const done = this.runOnce(id, m, abort.signal).finally(() => {
      this.running.delete(id)
      this.emit('change')
    })
    this.running.set(id, { abort, done })
    this.emit('change')
    return done
  }

  private async runOnce(id: string, m: Manifest, signal: AbortSignal): Promise<void> {
    const startedAt = this.o.now()
    const runDir = this.runDir(id)
    if (!fs.existsSync(runDir)) {
      this.logLine(id, 'the approved copy is missing: approve the service again')
      return
    }
    const main = fs.existsSync(path.join(runDir, 'main.ts')) ? 'main.ts' : fs.existsSync(path.join(runDir, 'main.js')) ? 'main.js' : 'main.mjs'
    this.logLine(id, `── run started (${main})`)
    let gate: Gate | undefined
    let result: RunResult | undefined
    let failure = ''
    try {
      gate = await Gate.open({
        hosts: m.hosts,
        localHosts: this.o.localHosts,
        secret: (name) => (m.secrets.includes(name) ? (this.o.vault.get(name) ?? null) : undefined),
        emit: (event, payload) => {
          const redacted = JSON.parse(this.o.vault.redact(JSON.stringify(payload), m.secrets)) as unknown
          const r = this.triggers.accept(id, m.name, m.on[event], event, redacted)
          if (r.status < 300) this.logLine(id, `event ${event}${r.status === 200 ? ' (already handled)' : ''}`)
          return r
        },
        log: (line) => this.logLine(id, line),
      })
      result = await runService({
        serviceDir: runDir,
        stateDir: path.join(this.serviceRuntime(id), 'state'),
        gateDir: gate.dir,
        main,
        hosts: m.hosts,
        timeoutMs: m.timeoutMs,
        memoryMb: m.memoryMb,
        line: (text) => this.logLine(id, this.o.vault.redact(text, m.secrets)),
        signal,
      })
    } catch (err) {
      failure = (err as Error).message
    } finally {
      await gate?.close().catch(() => {})
    }
    const ok = !failure && result?.exitCode === 0 && !result.stopped
    const text = failure
      ? `couldn't start: ${failure}`
      : result!.stopped === 'timeout'
        ? `stopped: took longer than ${ms(m.timeoutMs)}`
        : result!.stopped === 'output'
          ? 'stopped: printed far too much'
          : result!.stopped === 'cancelled'
            ? 'stopped (paused or shutting down)'
            : result!.exitCode === 0
              ? 'finished'
              : `failed (exit code ${result!.exitCode})`
    const record: RunRecord = { at: new Date(startedAt).toISOString(), ms: result?.ms ?? this.o.now() - startedAt, ok, result: text, stats: gate?.stats ?? { connections: 0, refused: 0, bytesIn: 0, bytesOut: 0, secretsRead: [], events: 0 } }
    this.logLine(id, `── run ${text} in ${(record.ms / 1000).toFixed(1)} s`)
    this.writeRuns(id, [...this.readRuns(id), record].slice(-RUNS_KEEP))
    if (result?.stopped === 'cancelled') return
    if (ok) {
      this.failures.delete(id)
      return
    }
    const failures = (this.failures.get(id) ?? 0) + 1
    this.failures.set(id, failures)
    if (failures >= FAILURES_BEFORE_BACKOFF + BACKOFF.length) {
      this.pause(id, 'failing')
      this.o.tell(`${m.name} stopped`, `The service "${m.name}" failed ${failures} times in a row, so it's paused. Ask Jarvis to look at its log and fix it.`)
      this.o.note(`The service "${m.name}" (services/${id}) failed ${failures} times in a row and was paused. Its log (jarvis__service_log) says why.`)
    } else if (failures >= FAILURES_BEFORE_BACKOFF) {
      this.logLine(id, `failed ${failures} times in a row: waiting ${ms(BACKOFF[failures - FAILURES_BEFORE_BACKOFF]!)} before trying again`)
    }
  }

  // ── Where things are ───────────────────────────────────────────────────────

  private view(s: Scanned): ServiceView {
    const record = this.approvals.get(s.id)
    const m = record.approved?.manifest
    const shown = m ?? s.manifest
    const runs = this.readRuns(s.id)
    const pending = !!s.hash && s.hash !== record.approved?.hash
    const rejected = pending && s.hash === record.rejectedHash
    const missingSecrets = (m?.secrets ?? []).filter((n) => !this.o.vault.has(n))
    let status: ServiceStatus
    let statusText: string
    if (!s.files) {
      status = 'missing'
      statusText = `The folder services/${s.id} is gone, so it doesn't run.`
    } else if (!record.approved) {
      if (s.error) [status, statusText] = ['error', `service.md has a problem: ${s.error}`]
      else if (rejected) [status, statusText] = ['rejected', 'The owner turned it down. It runs once a changed version is approved.']
      else [status, statusText] = ['waiting', 'Waiting for the owner to approve it in the Services tab.']
    } else if (record.paused) {
      status = 'paused'
      statusText = record.paused.by === 'failing' ? 'Paused: it failed too many times in a row. Read its log, fix it, and it can be resumed.' : `Paused (by ${record.paused.by}).`
    } else if (missingSecrets.length) {
      status = 'needs-secret'
      statusText = `Waiting for the owner to type the secret${missingSecrets.length === 1 ? '' : 's'} ${missingSecrets.join(', ')} in the Services tab.`
    } else if (pending && record.developing && !s.error) {
      status = 'active'
      statusText = 'In development: the latest changes are being approved automatically.'
    } else if (pending) {
      status = rejected ? 'rejected' : 'changed'
      statusText = s.error
        ? `The approved version runs; the edited service.md has a problem: ${s.error}`
        : rejected
          ? 'The owner turned down the latest changes; the approved version keeps running.'
          : 'The approved version runs; the changes wait for the owner to approve them.'
    } else {
      status = 'active'
      statusText = `Runs every ${ms(m!.everyMs)}.`
      if (record.developing) statusText += ` In development mode${record.developing.until ? ` until ${new Date(record.developing.until).toLocaleString()}` : ' until the owner locks it'}: Jarvis's changes are approved automatically.`
    }
    const failures = this.failures.get(s.id) ?? 0
    const next = m && status !== 'paused' && status !== 'missing' && status !== 'needs-secret' ? this.nextRun(s.id, m) : undefined
    return {
      id: s.id,
      name: shown?.name ?? s.id,
      description: shown?.description ?? '',
      status,
      statusText: this.sandboxProblem && record.approved ? `${statusText} But services can't run here: ${this.sandboxProblem}` : statusText,
      ...(m ? { every: ms(m.everyMs) } : {}),
      running: this.running.has(s.id),
      ...(m ? { nextRunAt: new Date(next ?? this.o.now()).toISOString() } : {}),
      ...(runs.length ? { lastRun: runs.at(-1)! } : {}),
      failures,
      ...(s.error ? { error: s.error } : {}),
      pending,
      ...(s.hash ? { hash: s.hash } : {}),
      permissions: shown ? describePermissions(shown) : [],
      secrets: (shown?.secrets ?? []).map((name) => ({ name, set: this.o.vault.has(name) })),
      waitingEvents: this.triggers.waiting(s.id),
      ...(record.paused ? { paused: record.paused } : {}),
      ...(record.developing ? { developing: record.developing } : {}),
      ...(record.approved ? { approvedBy: record.approved.by ?? 'owner', approvedAt: record.approved.approvedAt } : {}),
    }
  }

  private scan(id: string): Scanned {
    const dir = path.join(this.o.servicesDir, id)
    if (!fs.existsSync(path.join(dir, 'service.md'))) return { id, dir, ...(fs.existsSync(dir) ? { error: 'there is no service.md' } : {}) }
    let files: Map<string, string>
    try {
      files = readFolder(dir)
    } catch (err) {
      return { id, dir, error: err instanceof FolderError ? err.message : `can't read it: ${(err as Error).message}` }
    }
    const hash = hashFiles(files)
    try {
      const manifest = parseManifest(files.get('service.md') ?? '')
      if (![...files.keys()].some((f) => /^main\.(ts|js|mjs)$/.test(f))) return { id, dir, files, hash, error: 'there is no main.ts' }
      return { id, dir, files, hash, manifest }
    } catch (err) {
      return { id, dir, files, hash, error: err instanceof ManifestError ? err.message : (err as Error).message }
    }
  }

  private folderIds(): string[] {
    try {
      return fs.readdirSync(this.o.servicesDir, { withFileTypes: true }).filter((e) => e.isDirectory() && SERVICE_ID.test(e.name)).map((e) => e.name)
    } catch {
      return []
    }
  }

  private known(id: string): string {
    if (!SERVICE_ID.test(id) || (!this.folderIds().includes(id) && !this.approvals.ids().includes(id))) throw new ServiceError(`There's no service "${id}"`, 404)
    return id
  }

  private approvedFiles(id: string): Map<string, string> {
    try {
      return readFolder(path.join(this.serviceRuntime(id), 'approved'))
    } catch {
      return new Map()
    }
  }

  private runtime(): string {
    return path.join(this.o.dataDir, 'services')
  }

  private serviceRuntime(id: string): string {
    return path.join(this.runtime(), id)
  }

  private runDir(id: string): string {
    return path.join(this.serviceRuntime(id), 'run')
  }

  private logFile(id: string): string {
    return path.join(this.serviceRuntime(id), 'log.txt')
  }

  /** A line in a service's log. */
  logLine(id: string, line: string): void {
    const file = this.logFile(id)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const stamp = new Date(this.o.now()).toISOString().slice(0, 19).replace('T', ' ')
      fs.appendFileSync(file, `${stamp} ${line.slice(0, 2000)}\n`)
      if (fs.statSync(file).size > 600_000) {
        const lines = fs.readFileSync(file, 'utf8').split('\n')
        fs.writeFileSync(file, lines.slice(-LOG_KEEP).join('\n'))
      }
    } catch (err) {
      this.o.log(`services: can't write the log of ${id}`, err)
    }
  }

  private readRuns(id: string): RunRecord[] {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.serviceRuntime(id), 'runs.json'), 'utf8')) as RunRecord[]
    } catch {
      return []
    }
  }

  private writeRuns(id: string, runs: RunRecord[]): void {
    const file = path.join(this.serviceRuntime(id), 'runs.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(runs))
    fs.renameSync(`${file}.tmp`, file)
  }
}
