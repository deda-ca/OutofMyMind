// Files built into the binary that have to exist on disk: the web client (served
// from SITE_DIR), the services kit (bind-mounted into each service's sandbox)
// and ONNX Runtime (a native library loaded by path). Unpacked once per build
// into ~/.cache/jarvis/<build>/ (JARVIS_CACHE_DIR to choose another place).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BUILD } from './.generated/embedded.ts'

export const CACHE_ROOT = process.env.JARVIS_CACHE_DIR?.trim() || path.join(process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache'), 'jarvis')

/** `files` ([relative path, embedded file]) in CACHE_ROOT/<build>/<name>; returns that folder. */
export function unpack(name: string, files: [string, string][]): string {
  const dir = path.join(CACHE_ROOT, BUILD.id, name)
  const done = path.join(dir, '.unpacked')
  if (fs.existsSync(done)) return dir
  const tmp = `${dir}.${process.pid}.tmp`
  fs.rmSync(tmp, { recursive: true, force: true })
  for (const [rel, embedded] of files) {
    const target = path.join(tmp, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, fs.readFileSync(embedded))
  }
  fs.writeFileSync(path.join(tmp, '.unpacked'), `${BUILD.id}\n`)
  fs.rmSync(dir, { recursive: true, force: true })
  try {
    fs.renameSync(tmp, dir)
  } catch (err) {
    // Another process unpacked it first.
    fs.rmSync(tmp, { recursive: true, force: true })
    if (!fs.existsSync(done)) throw err
  }
  return dir
}

/** Removes what older builds unpacked. */
export function pruneOtherBuilds(): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(CACHE_ROOT)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry !== BUILD.id && fs.existsSync(path.join(CACHE_ROOT, entry, 'site', '.unpacked'))) fs.rmSync(path.join(CACHE_ROOT, entry), { recursive: true, force: true })
  }
}
