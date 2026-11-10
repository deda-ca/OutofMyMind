// What the owner approved, per service (docs/services.md): the folder's hash
// and its parsed manifest, in DATA_DIR/services.json (in the data history: an
// audit trail of approvals). A service runs only from its approved copy,
// DATA_DIR/services/<id>/run/, never from the workspace, so nothing
// unapproved ever runs. Approving copies the folder there and installs its
// npm packages (exact versions, no install scripts), outside the sandbox.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Manifest } from './manifest.ts'

export interface Approved {
  hash: string
  approvedAt: string
  /** Approved by the owner, or automatically while the service was in development mode. */
  by?: 'owner' | 'development'
  manifest: Manifest
}

export interface ServiceRecord {
  approved?: Approved
  /** A version the owner turned down (its hash): shown as rejected until the folder changes again. */
  rejectedHash?: string
  /**
   * Development mode, switched on by the owner: every change Jarvis saves is
   * approved automatically, until the owner locks it (or `until`, if set).
   */
  developing?: { since: string; until: string | null }
  /** Paused by the owner, by Jarvis, by the kill switch, or after failing too often. */
  paused?: { at: string; by: string }
}

const MAX_FILES = 50
const MAX_BYTES = 1024 * 1024

export class FolderError extends Error {}

/** The service's files (text), relative path → content. node_modules and dotfiles are left out. */
export function readFolder(dir: string): Map<string, string> {
  const files = new Map<string, string>()
  let total = 0
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const buf = fs.readFileSync(full)
        total += buf.length
        if (files.size >= MAX_FILES) throw new FolderError(`a service has at most ${MAX_FILES} files`)
        if (total > MAX_BYTES) throw new FolderError('a service is at most 1 MB of files')
        if (buf.includes(0)) throw new FolderError(`${path.relative(dir, full)} isn't a text file`)
        files.set(path.relative(dir, full).split(path.sep).join('/'), buf.toString('utf8'))
      }
    }
  }
  walk(dir)
  return files
}

export function hashFiles(files: Map<string, string>): string {
  const h = createHash('sha256')
  for (const [name, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) h.update(`${name}\0${text}\0`)
  return h.digest('hex').slice(0, 16)
}

export class Approvals {
  private readonly file: string
  private records: Record<string, ServiceRecord> = {}

  constructor(file: string) {
    this.file = file
    try {
      this.records = (JSON.parse(fs.readFileSync(file, 'utf8')) as { services?: Record<string, ServiceRecord> }).services ?? {}
    } catch {
      // none yet
    }
  }

  get(id: string): ServiceRecord {
    return this.records[id] ?? {}
  }

  ids(): string[] {
    return Object.keys(this.records)
  }

  update(id: string, change: (r: ServiceRecord) => ServiceRecord | undefined): void {
    const next = change({ ...this.get(id) })
    if (next === undefined) delete this.records[id]
    else this.records[id] = next
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ services: this.records }, null, 2)}\n`)
    fs.renameSync(tmp, this.file)
  }
}

/**
 * Makes `files` the approved copy in runDir: written to a fresh folder, npm
 * packages installed (or kept, if unchanged), then swapped in.
 */
export async function installCopy(runDir: string, files: Map<string, string>, packages: Record<string, string>, previous?: Record<string, string>, log: (line: string) => void = () => {}): Promise<void> {
  const next = `${runDir}.next`
  fs.rmSync(next, { recursive: true, force: true })
  fs.mkdirSync(next, { recursive: true })
  for (const [name, text] of files) {
    const target = path.join(next, name)
    if (!target.startsWith(next + path.sep)) throw new FolderError(`bad file name ${name}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
  }
  const names = Object.keys(packages)
  if (names.length) {
    const same = previous && JSON.stringify(sorted(previous)) === JSON.stringify(sorted(packages)) && fs.existsSync(path.join(runDir, 'node_modules'))
    // The service's own package.json (if any) is replaced: dependencies come from the manifest only.
    fs.writeFileSync(path.join(next, 'package.json'), `${JSON.stringify({ private: true, type: 'module', dependencies: sorted(packages) }, null, 2)}\n`)
    if (same) {
      fs.renameSync(path.join(runDir, 'node_modules'), path.join(next, 'node_modules'))
      if (fs.existsSync(path.join(runDir, 'package-lock.json'))) fs.copyFileSync(path.join(runDir, 'package-lock.json'), path.join(next, 'package-lock.json'))
    } else {
      log(`installing ${names.map((n) => `${n}@${packages[n]}`).join(', ')}`)
      await npmInstall(next)
    }
  } else if (!files.has('package.json')) {
    fs.writeFileSync(path.join(next, 'package.json'), '{ "private": true, "type": "module" }\n')
  }
  fs.rmSync(runDir, { recursive: true, force: true })
  fs.renameSync(next, runDir)
}

function sorted(packages: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)))
}

function npmInstall(dir: string): Promise<void> {
  const npm = path.join(path.dirname(process.execPath), 'npm')
  return new Promise((resolve, reject) => {
    execFile(
      fs.existsSync(npm) ? npm : 'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--save-exact', '--loglevel=error'],
      { cwd: dir, timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, npm_config_update_notifier: 'false' } },
      (err, _stdout, stderr) => (err ? reject(new Error(`npm install failed: ${(stderr || err.message).trim().slice(-1500)}`)) : resolve()),
    )
  })
}

/** A unified-style diff of two file sets, for the approval screen. */
export function diffFiles(before: Map<string, string>, after: Map<string, string>): { file: string; status: 'added' | 'changed' | 'deleted'; diff: string }[] {
  const out: { file: string; status: 'added' | 'changed' | 'deleted'; diff: string }[] = []
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(name)
    const b = after.get(name)
    if (a === b) continue
    out.push({ file: name, status: a === undefined ? 'added' : b === undefined ? 'deleted' : 'changed', diff: lineDiff(a ?? '', b ?? '') })
  }
  return out
}

/** Line diff with 3 lines of context ("+", "-", " " prefixes; "…" between hunks). */
export function lineDiff(a: string, b: string): string {
  const x = a === '' ? [] : a.split('\n')
  const y = b === '' ? [] : b.split('\n')
  if (x.length * y.length > 4_000_000) return [...x.map((l) => `-${l}`), ...y.map((l) => `+${l}`)].join('\n')
  // LCS table, from the end.
  const n = x.length
  const m = y.length
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = x[i] === y[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!)
  const ops: string[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      ops.push(` ${x[i++]}`)
      j++
    } else if (i < n && (j >= m || t[i + 1]![j]! >= t[i]![j + 1]!)) ops.push(`-${x[i++]}`)
    else ops.push(`+${y[j++]}`)
  }
  // Keep changed lines and 3 lines around them.
  const keep = ops.map((op) => op[0] !== ' ')
  const near = ops.map((_, k) => keep.slice(Math.max(0, k - 3), k + 4).some(Boolean))
  const lines: string[] = []
  let skipped = false
  ops.forEach((op, k) => {
    if (near[k]) {
      if (skipped) lines.push('…')
      lines.push(op)
      skipped = false
    } else skipped = true
  })
  if (skipped) lines.push('…')
  return lines.join('\n')
}
