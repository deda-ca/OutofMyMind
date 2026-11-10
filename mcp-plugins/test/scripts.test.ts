import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { checkSandbox, findBwrap, report, runFile } from '../scripts/runner.ts'

const unavailable = checkSandbox(findBwrap())

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-'))
  const out = path.join(root, 'scripts', 'out')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(root, 'scripts', 'package.json'), '{ "type": "module" }\n')
  fs.writeFileSync(path.join(root, 'data.csv'), 'item,price\nmilk,3.49\neggs,5.25\n')
  const write = (name: string, code: string) => {
    const file = path.join(root, 'scripts', name)
    fs.writeFileSync(file, code)
    return file
  }
  return { root, out, write, opts: { readDir: root, writeDir: out, timeoutMs: 5000 } }
}

test('runs TypeScript, reads the workspace, writes only to out', { skip: unavailable ?? false }, async () => {
  const ws = workspace()
  const file = ws.write(
    'total.ts',
    `import fs from 'node:fs'
const rows: string[] = fs.readFileSync(${JSON.stringify(path.join(ws.root, 'data.csv'))}, 'utf8').trim().split('\\n').slice(1)
const total = rows.reduce((sum: number, r) => sum + Number(r.split(',')[1]), 0)
await fs.promises.writeFile(${JSON.stringify(path.join(ws.out, 'total.txt'))}, total.toFixed(2))
console.log('total', total.toFixed(2), process.argv[2])
`,
  )
  const r = await runFile(file, ['hello'], ws.opts)
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'total 8.74 hello')
  assert.deepEqual(r.written, ['total.txt'])
  assert.match(report(r, ws.out, file), /Finished .*Output:\ntotal 8.74 hello.*Files written: .*total\.txt/s)
})

test('the sandbox blocks writes outside out, reads outside the workspace, the network and programs', { skip: unavailable ?? false }, async () => {
  const ws = workspace()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  const file = ws.write(
    'escape.ts',
    `import fs from 'node:fs'
const tries: Record<string, () => unknown> = {
  writeWorkspace: () => fs.writeFileSync(${JSON.stringify(path.join(ws.root, 'hacked.txt'))}, 'x'),
  readOutside: () => fs.readFileSync(${JSON.stringify(path.join(outside, 'secret.txt'))}, 'utf8'),
  readHome: () => fs.readdirSync(${JSON.stringify(os.homedir())}),
  child: async () => (await import('node:child_process')).execSync('id'),
  network: () => fetch('http://127.0.0.1:5550/health', { signal: AbortSignal.timeout(2000) }),
}
for (const [name, attempt] of Object.entries(tries)) {
  try { await attempt(); console.log(name, 'ALLOWED') } catch { console.log(name, 'blocked') }
}
`,
  )
  const r = await runFile(file, [], ws.opts)
  assert.equal(r.exitCode, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /ALLOWED/)
  assert.equal(r.stdout.match(/blocked/g)?.length, 5, r.stdout)
  assert.equal(fs.existsSync(path.join(ws.root, 'hacked.txt')), false)
})

test('a script that runs too long is stopped', { skip: unavailable ?? false }, async () => {
  const ws = workspace()
  const file = ws.write('loop.js', 'while (true) {}\n')
  const r = await runFile(file, [], { ...ws.opts, timeoutMs: 800 })
  assert.equal(r.stopped, 'timeout')
  assert.ok(r.ms < 3000)
  assert.match(report(r, ws.out, file), /took too long/)
})

test('errors come back with the message, without Node internals', { skip: unavailable ?? false }, async () => {
  const ws = workspace()
  const file = ws.write('bad.ts', 'const x: number = 1\nthrow new Error("no milk left: " + x)\n')
  const r = await runFile(file, [], ws.opts)
  assert.notEqual(r.exitCode, 0)
  const text = report(r, ws.out, file)
  assert.match(text, /Failed .*no milk left: 1/s)
  assert.doesNotMatch(text, /node:internal/)
})

test('a lot of output is cut', { skip: unavailable ?? false }, async () => {
  const ws = workspace()
  const file = ws.write('noisy.js', 'for (let i = 0; i < 5000; i++) console.log("line " + i)\n')
  const r = await runFile(file, [], ws.opts)
  assert.equal(r.exitCode, 0)
  assert.ok(r.stdout.length < 5200)
  assert.match(r.stdout, /more characters cut/)
})
