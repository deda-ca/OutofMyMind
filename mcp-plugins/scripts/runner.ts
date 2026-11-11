// Runs a JavaScript or TypeScript file in a sandbox, two layers deep:
//   - bubblewrap (bwrap): a private filesystem view (only /usr, Node itself and
//     the workspace), no network, no access to other processes;
//   - Node's permission model: reads only inside the workspace, writes only to
//     the output folder (and a throwaway /scratch, the temp folder), no child processes, workers,
//     native addons or inspector.
// TypeScript runs as is (Node strips the types: no enums or namespaces).
// A run is stopped after a time limit, gets at most so much memory, and its
// output is cut to what the model can use.
//
// The workspace is mounted at its real path, so paths in a script are the same
// ones the files plugin uses.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface SandboxOptions {
  /** Readable by scripts (the workspace). */
  readDir: string
  /** Writable by scripts (inside readDir). */
  writeDir: string
  timeoutMs?: number
  memoryMb?: number
  /** bwrap binary (default: found on PATH). */
  bwrap?: string
}

export interface RunResult {
  exitCode: number | null
  /** Why it ended, if not by itself. */
  stopped?: 'timeout' | 'output'
  ms: number
  stdout: string
  stderr: string
  /** Files created or changed in writeDir, relative to it. */
  written: string[]
}

const STDOUT_KEEP = 5000
const STDERR_KEEP = 2500
/** Output beyond this stops the run (an endless loop printing). */
const OUTPUT_LIMIT = 1_000_000

export function findBwrap(explicit?: string): string | null {
  for (const candidate of [explicit, '/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * The Node that runs scripts: never Bun, since Node's permission model is half
 * the sandbox. Under Node, this one; in the release binary (Bun), JARVIS_NODE
 * or the first node on PATH.
 */
export function findNode(): string | null {
  if (!process.versions.bun) return fs.realpathSync(process.execPath)
  const onPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'node'))
  for (const candidate of [process.env.JARVIS_NODE, ...onPath]) if (candidate && fs.existsSync(candidate)) return fs.realpathSync(candidate)
  return null
}

/** Checks the sandbox can start here (user namespaces may be disabled); null if fine, else why not. */
export function checkSandbox(bwrap: string | null): string | null {
  if (!findNode()) return 'Node.js 24 is not installed (scripts run on Node): install it, or set JARVIS_NODE'
  if (!bwrap) return 'bubblewrap (bwrap) is not installed: sudo apt install bubblewrap'
  const r = spawnSync(bwrap, ['--ro-bind', '/', '/', '--unshare-all', '--die-with-parent', 'true'], { encoding: 'utf8', timeout: 5000 })
  return r.status === 0 ? null : `bubblewrap can't start a sandbox here: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`
}

export function runFile(file: string, args: string[], opts: SandboxOptions): Promise<RunResult> {
  const bwrap = findBwrap(opts.bwrap)
  if (!bwrap) return Promise.reject(new Error('bubblewrap (bwrap) is not installed'))
  const readDir = fs.realpathSync(opts.readDir)
  fs.mkdirSync(opts.writeDir, { recursive: true })
  const writeDir = fs.realpathSync(opts.writeDir)
  const node = findNode()
  if (!node) return Promise.reject(new Error('Node.js is not installed (set JARVIS_NODE)'))
  // Node's own folder (e.g. ~/.nvm/versions/node/v24…), unless it's already under /usr.
  const nodeHome = path.dirname(path.dirname(node))
  const before = snapshot(writeDir)

  const sandbox = [
    // Empty first, so the binds below show through (the workspace may be under /tmp).
    '--tmpfs', '/tmp',
    '--tmpfs', '/scratch',
    '--ro-bind', '/usr', '/usr',
    ...['/lib', '/lib64', '/bin', '/etc/localtime', '/etc/ssl'].flatMap((p) => ['--ro-bind-try', p, p]),
    ...(nodeHome.startsWith('/usr/') ? [] : ['--ro-bind', nodeHome, nodeHome]),
    '--ro-bind', readDir, readDir,
    '--bind', writeDir, writeDir,
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
    '--chdir', readDir,
  ]
  const nodeArgs = [
    '--permission',
    `--allow-fs-read=${readDir}`,
    `--allow-fs-write=${writeDir}`,
    '--allow-fs-write=/scratch',
    `--max-old-space-size=${opts.memoryMb ?? 256}`,
    '--disable-warning=ExperimentalWarning',
    file,
    ...args,
  ]

  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(bwrap, [...sandbox, node, ...nodeArgs], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const out = new Collector()
    const err = new Collector()
    let stopped: RunResult['stopped']
    const kill = (why: NonNullable<RunResult['stopped']>) => {
      stopped ??= why
      try {
        process.kill(-child.pid!, 'SIGKILL') // the whole group: bwrap and the script
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => kill('timeout'), opts.timeoutMs ?? 30_000)
    child.stdout.on('data', (d: Buffer) => out.add(d) || kill('output'))
    child.stderr.on('data', (d: Buffer) => err.add(d) || kill('output'))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: code,
        stopped,
        ms: Date.now() - started,
        stdout: out.head(STDOUT_KEEP),
        stderr: err.tail(STDERR_KEEP),
        written: changed(before, snapshot(writeDir)),
      })
    })
  })
}

/** Keeps a run's output, up to OUTPUT_LIMIT in all; add() says false once it's over. */
class Collector {
  private chunks: Buffer[] = []
  private size = 0

  add(chunk: Buffer): boolean {
    if (this.size < OUTPUT_LIMIT) this.chunks.push(chunk)
    this.size += chunk.length
    return this.size < OUTPUT_LIMIT
  }

  private text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  /** The beginning (where results usually are). */
  head(max: number): string {
    const t = this.text()
    return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters cut)` : t
  }

  /** The end (where the error is). */
  tail(max: number): string {
    const t = this.text()
    return t.length > max ? `(… ${t.length - max} characters cut)\n${t.slice(-max)}` : t
  }
}

function snapshot(dir: string): Map<string, number> {
  const files = new Map<string, number>()
  const walk = (d: string, depth: number) => {
    if (depth > 6 || files.size > 2000) return
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile()) files.set(path.relative(dir, full), fs.statSync(full).mtimeMs)
    }
  }
  try {
    walk(dir, 0)
  } catch {
    // unreadable: report nothing
  }
  return files
}

function changed(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after].filter(([file, mtime]) => before.get(file) !== mtime).map(([file]) => file).sort()
}

/** The run, as the model reads it. */
export function report(result: RunResult, outDir: string, scriptPath: string): string {
  const status =
    result.stopped === 'timeout'
      ? 'Stopped: took too long (time limit reached)'
      : result.stopped === 'output'
        ? 'Stopped: printed too much'
        : result.exitCode === 0
          ? 'Finished'
          : `Failed (exit code ${result.exitCode})`
  const lines = [`${status} in ${(result.ms / 1000).toFixed(2)} s. Script: ${scriptPath}`]
  lines.push(result.stdout.trim() ? `Output:\n${result.stdout.trimEnd()}` : 'Output: (nothing printed; use console.log to show results)')
  const stderr = cleanStderr(result.stderr)
  if (stderr) lines.push(`Errors and warnings:\n${stderr}`)
  if (/ERR_ACCESS_DENIED/.test(result.stderr)) lines.push(`(The sandbox refused that: scripts can read the workspace, write only in ${outDir}, and can't use the network or start programs.)`)
  if (result.written.length) lines.push(`Files written: ${result.written.map((f) => path.join(outDir, f)).join(', ')}`)
  return lines.join('\n\n')
}

/** Node's stack traces, without the lines from its own internals. */
function cleanStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((l) => !/^\s+at .*node:internal|^Node\.js v\d/.test(l))
    .join('\n')
    .trim()
}
