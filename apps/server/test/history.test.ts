import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DataHistory, commitMessage, parseNameStatus } from '../src/history/history.ts'

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
/** Commit subjects, newest first. */
const subjects = (dir: string) => git(dir, 'log', '--format=%s').trim().split('\n').filter(Boolean)
const tracked = (dir: string) => git(dir, 'ls-files').trim().split('\n').filter(Boolean).sort()

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-data-'))
  const workspaceDir = path.join(dataDir, 'workspace')
  fs.mkdirSync(path.join(workspaceDir, 'lists'), { recursive: true })
  const logs: string[] = []
  const history = new DataHistory({ dataDir, workspaceDir, log: (m) => logs.push(m), settleMs: 100, maxWaitMs: 2000 })
  return { dataDir, workspaceDir, history, logs }
}

test('the data folder becomes a repository; what changed while Jarvis was off is committed at start, without the excluded files', async (t) => {
  const { dataDir, workspaceDir, history } = setup()
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(workspaceDir, 'todo.md'), '- [ ] milk\n')
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), '{}')
  // Not kept: big, binary, churning or secret.
  fs.writeFileSync(path.join(dataDir, 'jarvis.db'), 'db')
  fs.writeFileSync(path.join(dataDir, 'jarvis.db-wal'), 'wal')
  fs.writeFileSync(path.join(dataDir, 'access-key'), 'secret')
  fs.mkdirSync(path.join(dataDir, 'browser', 'profile'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'browser', 'profile', 'Cookies'), 'c')
  fs.mkdirSync(path.join(dataDir, 'audio'))
  fs.writeFileSync(path.join(dataDir, 'audio', '1.ogg'), 'a')
  fs.mkdirSync(path.join(workspaceDir, 'scripts', 'tmp'), { recursive: true })
  fs.writeFileSync(path.join(workspaceDir, 'scripts', 'tmp', 'x.ts'), '1')

  await history.start()
  await history.stop()
  assert.ok(fs.existsSync(path.join(dataDir, '.git')))
  // The repository is above the workspace: nothing the LLM's tools can reach.
  assert.ok(!fs.existsSync(path.join(workspaceDir, '.git')))
  assert.deepEqual(tracked(dataDir), ['.gitignore', 'sessions.json', 'workspace/todo.md'])
  assert.match(subjects(dataDir)[0]!, /^Add 3 files: .* \(while jarvis was off\)$/)
})

test('changes, deletions and renames are committed shortly after they happen', async (t) => {
  const { dataDir, workspaceDir, history } = setup()
  t.after(async () => {
    await history.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  await history.start()
  const before = subjects(dataDir).length

  fs.writeFileSync(path.join(workspaceDir, 'lists', 'shopping.md'), '- milk\n')
  await until(() => subjects(dataDir).length === before + 1)
  assert.equal(subjects(dataDir)[0], 'Add workspace/lists/shopping.md')

  fs.appendFileSync(path.join(workspaceDir, 'lists', 'shopping.md'), '- eggs\n')
  await until(() => subjects(dataDir).length === before + 2)
  assert.equal(subjects(dataDir)[0], 'Update workspace/lists/shopping.md')

  fs.renameSync(path.join(workspaceDir, 'lists', 'shopping.md'), path.join(workspaceDir, 'lists', 'groceries.md'))
  await until(() => subjects(dataDir).length === before + 3)
  assert.equal(subjects(dataDir)[0], 'Rename workspace/lists/shopping.md → workspace/lists/groceries.md')

  fs.rmSync(path.join(workspaceDir, 'lists', 'groceries.md'))
  await until(() => subjects(dataDir).length === before + 4)
  assert.equal(subjects(dataDir)[0], 'Delete workspace/lists/groceries.md')
  // Every version is still there.
  assert.equal(git(dataDir, 'show', 'HEAD~2:workspace/lists/shopping.md'), '- milk\n- eggs\n')

  // Churn in an excluded folder makes no commit.
  fs.mkdirSync(path.join(dataDir, 'browser'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'browser', 'x'), 'y')
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(subjects(dataDir).length, before + 4)
})

test('history refuses to run if the workspace contains the data folder (the LLM could reach .git)', async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-'))
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }))
  for (const dataDir of [outer, path.join(outer, 'data')]) {
    const history = new DataHistory({ dataDir, workspaceDir: outer, log: () => {} })
    await assert.rejects(history.start(), /contains the data folder/)
    assert.ok(!fs.existsSync(path.join(dataDir, '.git')))
  }
})

test('commit messages', () => {
  const changes = parseNameStatus('M\0workspace/todo.md\0A\0workspace/notes/a.md\0R100\0workspace/x.md\0workspace/y.md\0D\0tools.json\0')
  assert.deepEqual(changes, [
    { status: 'changed', path: 'workspace/todo.md' },
    { status: 'added', path: 'workspace/notes/a.md' },
    { status: 'renamed', from: 'workspace/x.md', path: 'workspace/y.md' },
    { status: 'deleted', path: 'tools.json' },
  ])
  assert.equal(
    commitMessage(changes),
    [
      'Change 4 files: workspace/todo.md, workspace/notes/a.md, workspace/y.md, …',
      '',
      'changed workspace/todo.md',
      'added   workspace/notes/a.md',
      'renamed workspace/x.md → workspace/y.md',
      'deleted tools.json',
    ].join('\n'),
  )
  assert.equal(commitMessage([{ status: 'added', path: 'a.md' }, { status: 'added', path: 'b.md' }]).split('\n')[0], 'Add 2 files: a.md, b.md')
})
