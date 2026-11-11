// Markdown notes in one folder (NOTES_DIR). Every path a tool is given is
// relative to that folder and can never leave it: no "..", no absolute paths,
// no following a symlink out. Only .md files.

import fs from 'node:fs/promises'
import path from 'node:path'

export const MAX_NOTE_BYTES = 256 * 1024

export class NotesStore {
  readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
  }

  /** "groceries" → "<root>/groceries.md"; throws for anything outside the folder. */
  async resolve(notePath: string): Promise<{ absolute: string; relative: string }> {
    let relative = notePath.trim().replaceAll('\\', '/').replace(/^\.\/+/, '')
    if (!relative) throw new Error('A note path is needed, e.g. "shopping" or "projects/jarvis".')
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) {
      throw new Error(`"${notePath}" is outside the notes folder. Use a path like "projects/jarvis".`)
    }
    if (!relative.toLowerCase().endsWith('.md')) relative += '.md'
    const absolute = path.resolve(this.root, relative)
    await this.assertInside(absolute)
    return { absolute, relative }
  }

  /** The nearest existing ancestor must really be inside the root (catches symlinks). */
  private async assertInside(absolute: string): Promise<void> {
    const root = await fs.realpath(this.root)
    let probe = absolute
    for (;;) {
      try {
        const real = await fs.realpath(probe)
        if (real !== root && !real.startsWith(root + path.sep)) throw new Error('That path leads outside the notes folder.')
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        const parent = path.dirname(probe)
        if (parent === probe) throw err
        probe = parent
      }
    }
  }

  async list(folder = ''): Promise<{ path: string; bytes: number; modified: string }[]> {
    const base = folder.trim() ? path.dirname((await this.resolve(path.posix.join(folder, 'x'))).absolute) : this.root
    const entries = await fs.readdir(base, { recursive: true, withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return []
      throw err
    })
    const notes = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      const absolute = path.join(entry.parentPath, entry.name)
      const stat = await fs.stat(absolute)
      notes.push({ path: path.relative(this.root, absolute).split(path.sep).join('/'), bytes: stat.size, modified: stat.mtime.toISOString() })
    }
    return notes.sort((a, b) => a.path.localeCompare(b.path))
  }

  async read(notePath: string): Promise<string> {
    const { absolute, relative } = await this.resolve(notePath)
    try {
      return await fs.readFile(absolute, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`There is no note "${relative}".`)
      throw err
    }
  }

  async write(notePath: string, content: string): Promise<{ relative: string; created: boolean }> {
    checkSize(content)
    const { absolute, relative } = await this.resolve(notePath)
    const created = !(await exists(absolute))
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, content.endsWith('\n') ? content : `${content}\n`, 'utf8')
    return { relative, created }
  }

  async append(notePath: string, addition: string): Promise<{ relative: string; created: boolean }> {
    const { absolute, relative } = await this.resolve(notePath)
    const before = (await exists(absolute)) ? await fs.readFile(absolute, 'utf8') : ''
    const joined = before && !before.endsWith('\n') ? `${before}\n${addition}` : `${before}${addition}`
    checkSize(joined)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, joined.endsWith('\n') ? joined : `${joined}\n`, 'utf8')
    return { relative, created: before === '' }
  }

  /** Case-insensitive search of note names and lines. */
  async search(query: string, limit = 40): Promise<{ path: string; line: number; text: string }[]> {
    const needle = query.trim().toLowerCase()
    if (!needle) throw new Error('Say what to search for.')
    const hits: { path: string; line: number; text: string }[] = []
    for (const note of await this.list()) {
      if (note.path.toLowerCase().includes(needle)) hits.push({ path: note.path, line: 0, text: '(name matches)' })
      const lines = (await fs.readFile(path.join(this.root, note.path), 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(needle)) hits.push({ path: note.path, line: i + 1, text: line.trim().slice(0, 200) })
      })
      if (hits.length >= limit) break
    }
    return hits.slice(0, limit)
  }
}

function checkSize(content: string): void {
  if (Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new Error(`Notes are limited to ${MAX_NOTE_BYTES / 1024} KB.`)
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}
