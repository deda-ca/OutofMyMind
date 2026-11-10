// Data history: DATA_DIR is a git repository, and every change to it (a note
// written, a list item ticked, a session turn, a skill edited, a file deleted)
// is committed a few seconds after it happens. Nothing Jarvis or the owner
// changes is ever lost: `cd data && git log -p`, and any version can be got
// back.
//
// The repository (DATA_DIR/.git) is out of the LLM's reach by where it is,
// not by asking nicely: every tool the LLM has is confined to the workspace
// (DATA_DIR/workspace) or narrower (notes/, the scripts sandbox, the browser's
// own folder), and .git sits one level above it. If the workspace were set up
// to contain the data folder, .git would be reachable, so history refuses to
// run then.
//
// Not kept (DATA_DIR/.gitignore, written once; edit it to change): the
// database, the audio archive, the browser profile and the access key: big,
// binary, changing all the time, or secret.
//
// On by default; DATA_HISTORY=off turns it off.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const GITIGNORE = `# Jarvis data history: what is NOT kept in it (big, binary, changing all the time, or secret).
# Everything else in this folder is committed when it changes. Edit freely.
/jarvis.db
/jarvis.db-*
/audio/
/browser/
/access-key
/workspace/scripts/tmp/
*.tmp
*.swp
`

export interface HistoryOptions {
  /** The data folder: the repository's root. */
  dataDir: string
  /** The LLM's folder: must not contain the data folder (it would reach .git). */
  workspaceDir: string
  log: (message: string, err?: unknown) => void
  /** Quiet time after a change before committing. */
  settleMs?: number
  /** Commit at least this often while changes keep coming. */
  maxWaitMs?: number
}

/** Folders and files under DATA_DIR not watched (ignored, or churning without anything to keep). */
const UNWATCHED = /^(\.git|audio|browser|jarvis\.db.*|access-key)(\/|$)|(^|\/)scripts\/tmp(\/|$)|\.(tmp|swp)$/

export class DataHistory {
  private readonly o: Required<HistoryOptions>
  private watchers: fs.FSWatcher[] = []
  private settleTimer?: ReturnType<typeof setTimeout>
  private maxTimer?: ReturnType<typeof setTimeout>
  /** Commits run one after another. */
  private running: Promise<void> = Promise.resolve()

  constructor(options: HistoryOptions) {
    this.o = { settleMs: 3000, maxWaitMs: 60_000, ...options }
  }

  /** Sets up the repository if needed, commits anything changed while Jarvis was off, and starts watching. */
  async start(): Promise<void> {
    const { dataDir, workspaceDir } = this.o
    const inside = (child: string, parent: string) => {
      const rel = path.relative(parent, child)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    }
    if (inside(dataDir, workspaceDir)) {
      throw new Error(`the workspace (${workspaceDir}) contains the data folder, so the LLM could reach its .git: history is off. Keep WORKSPACE_DIR inside DATA_DIR, not the other way round.`)
    }
    fs.mkdirSync(dataDir, { recursive: true })
    if (!fs.existsSync(path.join(dataDir, '.git'))) {
      await this.git(['init', '-q', '-b', 'main'])
      this.o.log(`history: started a git repository in ${dataDir}`)
    }
    const ignore = path.join(dataDir, '.gitignore')
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, GITIGNORE)
    if (!inside(workspaceDir, dataDir)) this.o.log(`history: the workspace (${workspaceDir}) is outside ${dataDir}, so its files aren't kept in the history`)
    await this.commit('While Jarvis was off')
    this.watch()
  }

  /** Commits whatever has changed now (also what start() and the watcher call). */
  commit(reason?: string): Promise<void> {
    clearTimeout(this.settleTimer)
    clearTimeout(this.maxTimer)
    this.maxTimer = undefined
    this.running = this.running.then(() => this.commitOnce(reason)).catch((err: unknown) => this.o.log('history: commit failed', err))
    return this.running
  }

  /** Stops watching; commits anything pending. */
  async stop(): Promise<void> {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.maxTimer) await this.commit()
    await this.running
  }

  private watch(): void {
    const { dataDir, workspaceDir } = this.o
    // The data folder's own files (not recursive: the browser profile alone has thousands of folders),
    // and the workspace with everything in it.
    const onChange = (base: string) => (_event: string, file: string | Buffer | null) => {
      const rel = path.relative(dataDir, path.join(base, String(file ?? '')))
      if (!rel || UNWATCHED.test(rel.split(path.sep).join('/'))) return
      this.changed()
    }
    const add = (dir: string, recursive: boolean) => {
      try {
        const w = fs.watch(dir, { recursive }, onChange(dir))
        w.on('error', (err) => this.o.log(`history: stopped watching ${dir}`, err))
        this.watchers.push(w)
      } catch (err) {
        this.o.log(`history: can't watch ${dir}`, err)
      }
    }
    add(dataDir, false)
    if (fs.existsSync(workspaceDir)) add(workspaceDir, true)
  }

  /** A file changed: commit once things are quiet, or after maxWaitMs at the latest. */
  private changed(): void {
    clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => void this.commit(), this.o.settleMs)
    this.maxTimer ??= setTimeout(() => void this.commit(), this.o.maxWaitMs)
  }

  private async commitOnce(reason?: string): Promise<void> {
    await this.git(['add', '-A'])
    const staged = await this.git(['diff', '--cached', '--name-status', '-z', '-M'])
    const changes = parseNameStatus(staged)
    if (changes.length === 0) return
    const message = commitMessage(changes, reason)
    await this.git(['commit', '-q', '--no-verify', '-m', message])
    this.o.log(`history: ${message.split('\n')[0]}`)
  }

  private git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', this.o.dataDir, '-c', 'user.name=Jarvis', '-c', 'user.email=jarvis@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.quotepath=false', ...args],
        { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]}: ${stderr.trim() || err.message}`)) : resolve(stdout)),
      )
    })
  }
}

export interface Change {
  status: 'added' | 'changed' | 'deleted' | 'renamed'
  path: string
  from?: string
}

/** `git diff --name-status -z -M` → the changes. */
export function parseNameStatus(out: string): Change[] {
  const parts = out.split('\0').filter((p) => p !== '')
  const changes: Change[] = []
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]![0]
    if (code === 'R' || code === 'C') {
      changes.push({ status: 'renamed', from: parts[i + 1]!, path: parts[i + 2]! })
      i += 2
    } else {
      changes.push({ status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'changed', path: parts[i + 1]! })
      i += 1
    }
  }
  return changes
}

const VERBS: Record<Change['status'], string> = { added: 'Add', changed: 'Update', deleted: 'Delete', renamed: 'Rename' }

/** "Update workspace/todo.md" or "Update 3 files: …", then one line per file. */
export function commitMessage(changes: Change[], reason?: string): string {
  const name = (c: Change) => (c.status === 'renamed' ? `${c.from} → ${c.path}` : c.path)
  let subject: string
  if (changes.length === 1) subject = `${VERBS[changes[0]!.status]} ${name(changes[0]!)}`
  else {
    const kinds = new Set(changes.map((c) => c.status))
    const verb = kinds.size === 1 ? VERBS[changes[0]!.status] : 'Change'
    const shown = changes.slice(0, 3).map((c) => c.path).join(', ')
    subject = `${verb} ${changes.length} files: ${shown}${changes.length > 3 ? ', …' : ''}`
  }
  const lines = changes.slice(0, 50).map((c) => `${c.status.padEnd(7)} ${name(c)}`)
  if (changes.length > 50) lines.push(`… and ${changes.length - 50} more`)
  return [reason ? `${subject} (${reason.toLowerCase()})` : subject, '', ...lines].join('\n')
}
