// Files the owner drops into a conversation: saved in the workspace under
// uploads/<date>/, where Jarvis's file tools can reach them (to move a photo
// into photos/, read a .md, …). And reading workspace files back for the
// client, never outside the workspace.

import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'

export interface FileRef {
  /** Relative to the workspace, with forward slashes: "uploads/2026-11-09/photo.jpg". */
  path: string
  /** The name it was dropped with. */
  name: string
  /** MIME type, e.g. "image/jpeg" ("" if unknown). */
  type: string
  size: number
}

export class FileError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Largest file accepted (videos can be big; it's streamed to disk, not held in memory). */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024

/** A file name that's safe on any disk and in a Markdown link: no folders, no control characters. */
export function safeName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'))
  const cleaned = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"|?*()[\]#%]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(-120)
  return cleaned || 'file'
}

/** Streams an upload to WORKSPACE_DIR/uploads/<yyyy-mm-dd>/<name> (name-1, name-2, … if taken). */
export async function saveUpload(workspaceDir: string, body: Readable, name: string, type: string, now = new Date()): Promise<FileRef> {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const dir = path.join(workspaceDir, 'uploads', day)
  fs.mkdirSync(dir, { recursive: true })
  const clean = safeName(name)
  const ext = path.extname(clean)
  const stem = clean.slice(0, clean.length - ext.length) || 'file'
  let file = path.join(dir, clean)
  for (let n = 1; fs.existsSync(file); n++) file = path.join(dir, `${stem}-${n}${ext}`)

  let size = 0
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length
      if (size > MAX_UPLOAD_BYTES) done(new FileError(`Files can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413))
      else done(null, chunk)
    },
  })
  try {
    // "wx": never overwrite, even if another upload took the name a moment ago.
    await pipeline(body, limit, fs.createWriteStream(file, { flags: 'wx' }))
  } catch (err) {
    fs.rmSync(file, { force: true })
    throw err
  }
  if (size === 0) {
    fs.rmSync(file, { force: true })
    throw new FileError('The file is empty', 400)
  }
  return { path: path.relative(workspaceDir, file).split(path.sep).join('/'), name: clean, type: type.slice(0, 100), size }
}

/** The absolute path of a workspace file, or an error if it's outside the workspace (.., symlinks) or missing. */
export function workspaceFile(workspaceDir: string, relative: string): string {
  const root = fs.realpathSync(workspaceDir)
  let real: string
  try {
    real = fs.realpathSync(path.resolve(root, relative))
  } catch {
    throw new FileError('No such file', 404)
  }
  if (real !== root && !real.startsWith(root + path.sep)) throw new FileError('Outside the workspace', 403)
  if (!fs.statSync(real).isFile()) throw new FileError('Not a file', 400)
  return real
}

/** Content type for serving a file back (the common ones; anything else downloads). */
export function contentTypeOf(file: string): string {
  const types: Record<string, string> = {
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.flac': 'audio/flac',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
  }
  return types[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** "2.1 MB" */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}
