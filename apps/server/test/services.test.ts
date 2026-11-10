import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { describePermissions, parseManifest, widened } from '../src/services/manifest.ts'
import { checkSandbox } from '../src/services/sandbox.ts'
import { Supervisor } from '../src/services/supervisor.ts'
import { Triggers, type TurnRequest } from '../src/services/triggers.ts'
import { Vault } from '../src/services/vault.ts'
import { lineDiff } from '../src/services/approvals.ts'

const EMAIL = `---
name: Email
description: Checks the inbox   # for new mail
runs: every 5 min
timeout: 90 s
hosts: [imap.gmail.com:993]
secrets: [gmail]
packages: { imapflow: 2.11.0 }
on:
  email.received:
    agent: email-triage
    prompt: |
      Summarise it in one sentence.
      If it's urgent, say so.
    batch: 2 min
    max_per_hour: 10
---
Checks the inbox every five minutes.
`

test('a manifest: frontmatter with lists, maps, a block prompt and comments', () => {
  const m = parseManifest(EMAIL)
  assert.equal(m.name, 'Email')
  assert.equal(m.description, 'Checks the inbox')
  assert.equal(m.everyMs, 5 * 60_000)
  assert.equal(m.timeoutMs, 90_000)
  assert.equal(m.memoryMb, 256)
  assert.deepEqual(m.hosts, ['imap.gmail.com:993'])
  assert.deepEqual(m.secrets, ['gmail'])
  assert.deepEqual(m.packages, { imapflow: '2.11.0' })
  assert.deepEqual(m.on['email.received'], { agent: 'email-triage', prompt: "Summarise it in one sentence.\nIf it's urgent, say so.", batchMs: 120_000, maxPerHour: 10 })
  assert.equal(m.about, 'Checks the inbox every five minutes.')
  // Block lists work too.
  assert.deepEqual(parseManifest('---\nname: X\nruns: every 1 h\nhosts:\n  - a.example.com:443\n  - b.example.com:443\n---\n').hosts, ['a.example.com:443', 'b.example.com:443'])
})

test('a manifest with mistakes says what each one is', () => {
  const bad = `---\nname: X\nruns: every 10 s\nhost: [a.com:443]\nhosts: [https://a.com, b.com]\npackages: { imapflow: ^2.0.0 }\non:\n  Mail!:\n    prompt: hi\n---\n`
  assert.throws(
    () => parseManifest(bad),
    (err: Error) =>
      /unknown setting "host"/.test(err.message) &&
      /"runs" must be from 1 min/.test(err.message) &&
      /host "https:\/\/a.com"/.test(err.message) &&
      /host "b.com" should be/.test(err.message) &&
      /exact version/.test(err.message) &&
      /event "Mail!"/.test(err.message) &&
      /needs "agent"/.test(err.message),
  )
  assert.throws(() => parseManifest('no frontmatter'), /must start/)
  assert.throws(() => parseManifest('---\nname: X\n---\n'), /"runs" is needed/)
})

test('approval wording: everything for a new service, only what widens for a change', () => {
  const m = parseManifest(EMAIL)
  assert.match(describePermissions(m).join('\n'), /Can connect to: imap.gmail.com:993.*\n.*secrets: gmail.*\n.*imapflow 2.11.0/)
  const more = parseManifest(EMAIL.replace('[imap.gmail.com:993]', '[imap.gmail.com:993, smtp.gmail.com:465]').replace('secrets: [gmail]', 'secrets: [gmail, other]').replace('agent: email-triage', 'agent: jarvis'))
  assert.deepEqual(widened(m, more), ['Can now also connect to smtp.gmail.com:465.', 'Can now also read the secret "other".', '"email.received" is now handled by the agent "jarvis" (was "email-triage").'])
  assert.deepEqual(widened(m, m), [])
})

test('diffs show changed lines with a little context', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
  const after = before.replace('line 10', 'line ten')
  const d = lineDiff(before, after)
  assert.match(d, /^…\n line 7\n line 8\n line 9\n-line 10\n\+line ten\n line 11/)
  assert.ok(!d.includes('line 2\n'))
})

test('the vault keeps secrets out of logs and events; the file is private', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-vault-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const vault = new Vault(path.join(dir, 'secrets.json'))
  vault.request('gmail', 'IMAP login')
  assert.deepEqual(vault.list(), [{ name: 'gmail', description: 'IMAP login', set: false, requested: true }])
  vault.set('gmail', JSON.stringify({ user: 'someone@example.com', password: 'hunter22-very-secret' }))
  assert.equal(fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777, 0o600)
  assert.equal(vault.list()[0]!.set, true)
  assert.ok(!('value' in vault.list()[0]!))
  assert.equal(vault.redact('logged in with hunter22-very-secret as someone@example.com', ['gmail']), 'logged in with [secret gmail] as [secret gmail]')
  assert.equal(vault.redact('hunter22-very-secret', []), 'hunter22-very-secret')
  assert.throws(() => vault.set('bad name', 'x'), /letters/)
})

test('triggers: duplicates dropped, events batched into one turn, limits per hour and per day', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-triggers-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const turns: TurnRequest[] = []
  const told: string[] = []
  const triggers = new Triggers({ dir, dailyTurns: 3, run: async (turn) => void turns.push(turn), tell: (title) => told.push(title), log: () => {} })
  const trigger = { agent: 'a', prompt: 'p', batchMs: 30, maxPerHour: 2 }
  assert.equal(triggers.accept('svc', 'Svc', undefined, 'other', {}).status, 403)
  assert.equal(triggers.accept('svc', 'Svc', trigger, 'e', { id: 1 }).status, 202)
  assert.equal(triggers.accept('svc', 'Svc', trigger, 'e', { id: 2 }).status, 202)
  assert.equal(triggers.accept('svc', 'Svc', trigger, 'e', { id: 1 }).status, 200) // seen
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0]!.payloads, [{ id: 1 }, { id: 2 }])
  triggers.accept('svc', 'Svc', trigger, 'e', { id: 3 })
  await new Promise((r) => setTimeout(r, 80))
  triggers.accept('svc', 'Svc', trigger, 'e', { id: 4 })
  await new Promise((r) => setTimeout(r, 80))
  // Two turns this hour: the third waits, and the owner is told once.
  assert.equal(turns.length, 2)
  assert.equal(triggers.waiting('svc'), 1)
  assert.deepEqual(told, ['Svc: paused for now'])
  // Seen ids survive a restart.
  const again = new Triggers({ dir, dailyTurns: 3, run: async () => {}, tell: () => {}, log: () => {} })
  assert.equal(again.accept('svc', 'Svc', trigger, 'e', { id: 2 }).status, 200)
  await triggers.stop()
  await again.stop()
})

const sandboxProblem = checkSandbox()

test('a service end to end: approval, the sandbox, the gate, secrets, events', { skip: sandboxProblem ?? false, timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-svc-'))
  const dataDir = path.join(root, 'data')
  const workspace = path.join(dataDir, 'workspace')
  const servicesDir = path.join(workspace, 'services')
  const svc = path.join(servicesDir, 'echo')
  fs.mkdirSync(svc, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'private-notes.md'), 'my private notes')

  // Something on this machine for the service to talk to (allowed as a "local host").
  const echo = net.createServer((c) => c.on('data', (d) => c.end(`echo:${d}`)))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
  const port = (echo.address() as net.AddressInfo).port
  const turns: TurnRequest[] = []
  const notes: string[] = []
  const vault = new Vault(path.join(dataDir, 'secrets.json'))
  const supervisor = new Supervisor({
    servicesDir,
    dataDir,
    vault,
    dailyTurns: 10,
    localHosts: [`127.0.0.1:${port}`],
    runTurn: async (turn) => void turns.push(turn),
    tell: () => {},
    note: (text) => notes.push(text),
    log: () => {},
    tickMs: 0,
  })
  t.after(async () => {
    await supervisor.stop()
    echo.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const manifest = (extra = '') => `---\nname: Echo\nruns: every 1 h\nhosts: [127.0.0.1:${port}]\nsecrets: [token]\non:\n  thing.seen:\n    agent: jarvis\n    prompt: Tell me.\n    batch: 0 s\n${extra}---\nTalks to the echo server.\n`
  const code = (version: string) => `
import { emit, secret, state } from 'jarvis:service'
import fs from 'node:fs'
import net from 'node:net'
console.log('version ${version}')
const token = await secret('token')
console.log('the token is', token)
try { fs.readFileSync(${JSON.stringify(path.join(workspace, 'private-notes.md'))}); console.log('READ THE WORKSPACE') } catch (e) { console.log('workspace:', e.code) }
try { await secret('other'); console.log('GOT ANOTHER SECRET') } catch (e) { console.log('other secret refused') }
const reply = await new Promise((resolve, reject) => {
  const s = net.connect(${port}, '127.0.0.1', () => s.write('hi'))
  let text = ''
  s.on('data', (d) => (text += d)).on('end', () => resolve(text)).on('error', reject)
})
console.log('reply', reply)
try { await fetch('https://example.com/'); console.log('REACHED THE INTERNET') } catch (e) { console.log('example.com refused') }
const runs = Number((await state.read('runs')) ?? 0) + 1
await state.write('runs', String(runs))
await emit('thing.seen', { id: 'run-' + runs, reply, token })
try { await emit('not.listed', {}) } catch { console.log('unlisted event refused') }
`
  fs.writeFileSync(path.join(svc, 'service.md'), manifest())
  fs.writeFileSync(path.join(svc, 'main.ts'), code('1'))
  supervisor.start()

  let view = supervisor.get('echo')
  assert.equal(view.status, 'waiting')
  await assert.rejects(supervisor.runNow('echo'), /hasn't been approved/)
  const changes = supervisor.changes('echo')
  assert.ok(changes.widened.some((l) => l.includes(`127.0.0.1:${port}`)))
  assert.deepEqual(changes.files.map((f) => [f.file, f.status]), [['main.ts', 'added'], ['service.md', 'added']])
  await assert.rejects(supervisor.approve('echo', 'not-the-hash'), /changed since you looked/)
  await supervisor.approve('echo', changes.hash)
  assert.ok(notes.some((n) => n.includes('approved the service "Echo"')))
  // Approved, but its secret isn't set: it waits for it.
  assert.equal(supervisor.get('echo').status, 'needs-secret')
  vault.set('token', 'tok-12345678')

  const run = await supervisor.runNow('echo')
  const log = supervisor.log('echo', 200)
  assert.ok(run.ok, log)
  assert.match(log, /version 1/)
  assert.match(log, /the token is \[secret token\]/)
  assert.doesNotMatch(log, /tok-12345678/)
  assert.match(log, /workspace: ERR_ACCESS_DENIED|workspace: ENOENT/)
  assert.doesNotMatch(log, /READ THE WORKSPACE|GOT ANOTHER SECRET|REACHED THE INTERNET/)
  assert.match(log, /other secret refused/)
  assert.match(log, /reply echo:hi/)
  assert.match(log, /example.com refused/)
  assert.match(log, /unlisted event refused/)
  assert.equal(run.stats.connections, 1)
  assert.deepEqual(run.stats.secretsRead, ['token'])
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0]!.payloads, [{ id: 'run-1', reply: 'echo:hi', token: '[secret token]' }])

  // An edit isn't run until approved; the approved version keeps running.
  fs.writeFileSync(path.join(svc, 'main.ts'), code('2'))
  view = supervisor.get('echo')
  assert.equal(view.status, 'changed')
  await supervisor.runNow('echo')
  assert.match(supervisor.log('echo', 60), /version 1/)
  assert.doesNotMatch(supervisor.log('echo', 60), /version 2/)
  // A wider manifest shows exactly what widens.
  fs.writeFileSync(path.join(svc, 'service.md'), manifest().replace('secrets: [token]', 'secrets: [token, other]'))
  assert.deepEqual(supervisor.changes('echo').widened, ['Can now also read the secret "other".'])
  supervisor.reject('echo', supervisor.changes('echo').hash)
  assert.equal(supervisor.get('echo').status, 'rejected')

  // The kill switch.
  assert.equal(supervisor.stopAll('test'), 1)
  assert.equal(supervisor.get('echo').status, 'paused')
})

test('development mode: Jarvis edits and runs without approvals until the owner locks it (or time runs out)', { skip: sandboxProblem ?? false, timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dev-'))
  const dataDir = path.join(root, 'data')
  const servicesDir = path.join(dataDir, 'workspace', 'services')
  const svc = path.join(servicesDir, 'dev')
  fs.mkdirSync(svc, { recursive: true })
  let clock = Date.now()
  const notes: string[] = []
  const told: string[] = []
  const supervisor = new Supervisor({ servicesDir, dataDir, vault: new Vault(path.join(dataDir, 'secrets.json')), dailyTurns: 10, runTurn: async () => {}, tell: (title) => told.push(title), note: (n) => notes.push(n), log: () => {}, tickMs: 0, now: () => clock })
  t.after(async () => {
    await supervisor.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const manifest = (hosts = '[]') => `---\nname: Dev\nruns: every 1 h\nhosts: ${hosts}\n---\n`
  const version = (v: string) => fs.writeFileSync(path.join(svc, 'main.ts'), `console.log('version ${v}')\n`)
  fs.writeFileSync(path.join(svc, 'service.md'), manifest())
  version('1')
  supervisor.start()
  assert.equal(supervisor.get('dev').status, 'waiting')

  // The owner lets Jarvis develop it: what's there is approved at once.
  await supervisor.develop('dev', null)
  assert.ok(notes.some((n) => n.includes('development mode') && n.includes('approved automatically')))
  let view = supervisor.get('dev')
  assert.equal(view.status, 'active')
  assert.equal(view.approvedBy, 'development')
  assert.match((await supervisor.runNow('dev')).result, /finished/)
  assert.match(supervisor.log('dev', 5), /version 1/)

  // Edits, even new permissions, run straight away.
  version('2')
  fs.writeFileSync(path.join(svc, 'service.md'), manifest('[api.example.com:443]'))
  await supervisor.runNow('dev')
  assert.match(supervisor.log('dev', 5), /version 2/)
  assert.ok(supervisor.get('dev').permissions.some((p) => p.includes('api.example.com:443')))

  // A broken service.md is said plainly, not silently run as the old version.
  fs.writeFileSync(path.join(svc, 'service.md'), '---\nname: Dev\n---\n')
  await assert.rejects(supervisor.runNow('dev'), /latest version can't run: "runs" is needed/)
  fs.writeFileSync(path.join(svc, 'service.md'), manifest('[api.example.com:443]'))

  // Locked: changes wait for the owner again; the version approved last keeps running.
  supervisor.lock('dev')
  version('3')
  view = supervisor.get('dev')
  assert.equal(view.status, 'changed')
  assert.equal(view.developing, undefined)
  await supervisor.runNow('dev')
  assert.match(supervisor.log('dev', 5), /version 2/)
  assert.doesNotMatch(supervisor.log('dev', 5), /version 3/)

  // Development mode for 2 hours ends by itself.
  await supervisor.develop('dev', 2)
  assert.equal(supervisor.get('dev').approvedBy, 'development')
  clock += 2 * 3_600_000 + 1000
  supervisor.tick()
  assert.equal(supervisor.get('dev').developing, undefined)
  assert.deepEqual(told, ['Dev is locked'])
  version('4')
  assert.equal(supervisor.get('dev').status, 'changed')
})
