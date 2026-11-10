// One run of a service, sandboxed (docs/services.md), the same two layers as
// the scripts plugin (mcp-plugins/scripts/runner.ts) with a service's profile:
//   - bubblewrap: a private filesystem view with only /usr, Node, the kit, the
//     service's approved copy (read-only, at /service), its state folder (at
//     /state) and the gate's sockets (at /run/jarvis); no network at all, no
//     other processes;
//   - Node's permission model: reads only those, writes only /state and a
//     throwaway /scratch; no child processes, workers, addons or inspector.
// Its output goes line by line to the log; a run that takes too long, or
// prints far too much, is stopped.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const KIT_DIR = fileURLToPath(new URL('./kit/', import.meta.url))

export interface RunOptions {
  /** The approved copy (with its node_modules): /service. */
  serviceDir: string
  /** Its state folder: /state. */
  stateDir: string
  /** The gate's folder: /run/jarvis. */
  gateDir: string
  /** The file to run, relative to serviceDir. */
  main: string
  hosts: string[]
  timeoutMs: number
  memoryMb: number
  /** Each line it prints (stderr lines start with "! "). */
  line: (text: string) => void
  signal?: AbortSignal
  bwrap?: string
}

export interface RunResult {
  exitCode: number | null
  stopped?: 'timeout' | 'output' | 'cancelled'
  ms: number
}

const OUTPUT_LIMIT = 2_000_000

export function findBwrap(explicit?: string): string | null {
  for (const candidate of [explicit, '/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']) if (candidate && fs.existsSync(candidate)) return candidate
  return null
}

/** Null if sandboxes can start here, else why not. */
export function checkSandbox(bwrap = findBwrap()): string | null {
  if (!bwrap) return 'bubblewrap (bwrap) is not installed: sudo apt install bubblewrap'
  const r = spawnSync(bwrap, ['--ro-bind', '/', '/', '--unshare-all', '--die-with-parent', 'true'], { encoding: 'utf8', timeout: 5000 })
  return r.status === 0 ? null : `bubblewrap can't start a sandbox here: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`
}

export function runService(o: RunOptions): Promise<RunResult> {
  const bwrap = findBwrap(o.bwrap)
  if (!bwrap) return Promise.reject(new Error('bubblewrap (bwrap) is not installed'))
  const node = fs.realpathSync(process.execPath)
  const nodeHome = path.dirname(path.dirname(node))
  fs.mkdirSync(o.stateDir, { recursive: true })
  const main = path.posix.join('/service', o.main)

  const sandbox = [
    '--tmpfs', '/tmp',
    '--tmpfs', '/scratch',
    '--ro-bind', '/usr', '/usr',
    ...['/lib', '/lib64', '/bin', '/etc/localtime', '/etc/ssl', '/etc/ca-certificates'].flatMap((p) => ['--ro-bind-try', p, p]),
    ...(nodeHome.startsWith('/usr/') ? [] : ['--ro-bind', nodeHome, nodeHome]),
    '--ro-bind', fs.realpathSync(KIT_DIR), '/kit',
    '--ro-bind', fs.realpathSync(o.serviceDir), '/service',
    '--bind', fs.realpathSync(o.stateDir), '/state',
    '--bind', fs.realpathSync(o.gateDir), '/run/jarvis',
    '--proc', '/proc',
    '--dev', '/dev',
    '--unshare-all', // includes the network: only an unconnected loopback inside
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--setenv', 'HOME', '/scratch',
    '--setenv', 'TMPDIR', '/scratch',
    '--setenv', 'LANG', process.env.LANG ?? 'C.UTF-8',
    ...(process.env.TZ ? ['--setenv', 'TZ', process.env.TZ] : []),
    '--setenv', 'JARVIS_GATE', '/run/jarvis/api.sock',
    '--setenv', 'JARVIS_TUNNEL', '/run/jarvis/tunnel.sock',
    '--setenv', 'JARVIS_HOSTS', o.hosts.join(','),
    '--chdir', '/service',
  ]
  const nodeArgs = [
    '--permission',
    '--allow-fs-read=/kit',
    '--allow-fs-read=/service',
    '--allow-fs-read=/state',
    '--allow-fs-write=/state',
    '--allow-fs-write=/scratch',
    `--max-old-space-size=${o.memoryMb}`,
    '--disable-warning=ExperimentalWarning',
    '--import', '/kit/preload.ts',
    main,
  ]

  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(bwrap, [...sandbox, node, ...nodeArgs], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stopped: RunResult['stopped']
    let size = 0
    const kill = (why: NonNullable<RunResult['stopped']>) => {
      stopped ??= why
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => kill('timeout'), o.timeoutMs)
    const onAbort = () => kill('cancelled')
    o.signal?.addEventListener('abort', onAbort)
    const flushers: (() => void)[] = []
    const lines = (prefix: string) => {
      let rest = ''
      flushers.push(() => rest && o.line(prefix + rest))
      return (chunk: Buffer) => {
        size += chunk.length
        if (size > OUTPUT_LIMIT) return kill('output')
        const parts = (rest + chunk.toString('utf8')).split('\n')
        rest = parts.pop() ?? ''
        for (const p of parts) o.line(prefix + p)
      }
    }
    child.stdout.on('data', lines(''))
    child.stderr.on('data', lines('! '))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      for (const flush of flushers) flush()
      resolve({ exitCode: code, ...(stopped ? { stopped } : {}), ms: Date.now() - started })
    })
  })
}
