// The scripts plugin: Jarvis writes small JavaScript/TypeScript programs and
// runs them in a sandbox (see runner.ts) — for exact arithmetic, dates, and
// working through files and data, where a language model otherwise guesses.
//
// In the workspace (WORKSPACE_DIR):
//   scripts/<name>.ts    saved scripts, to run again (run_script with a name)
//   scripts/tmp/         one-off scripts (the last 20 are kept)
//   scripts/out/         the only place scripts can write
// Scripts can read the whole workspace; they have no network and can't start programs.
//
// Try it alone:
//   WORKSPACE_DIR=/tmp/ws npx @modelcontextprotocol/inspector node scripts/server.ts

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { createPlugin, failure, log, serve, text } from '../kit/plugin.ts'
import { checkSandbox, findBwrap, report, runFile } from './runner.ts'

const workspace = process.env.WORKSPACE_DIR?.trim()
if (!workspace) {
  log('scripts: WORKSPACE_DIR is not set')
  process.exit(1)
}
const root = path.resolve(workspace)
const scriptsDir = path.join(root, 'scripts')
const tmpDir = path.join(scriptsDir, 'tmp')
const outDir = path.join(scriptsDir, 'out')
const timeoutMs = Math.max(1, Number(process.env.SCRIPTS_TIMEOUT_SECONDS) || 30) * 1000
const memoryMb = Math.max(32, Number(process.env.SCRIPTS_MEMORY_MB) || 256)
const KEEP_TMP = 20
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

for (const d of [tmpDir, outDir]) fs.mkdirSync(d, { recursive: true })
// Scripts are ES modules (import, top-level await), whatever the extension.
const pkg = path.join(scriptsDir, 'package.json')
if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, '{ "type": "module" }\n')

const bwrap = findBwrap(process.env.SCRIPTS_BWRAP)
const problem = checkSandbox(bwrap)
if (problem) log(`scripts: ${problem}. Scripts won't run until it's fixed.`)

const plugin = createPlugin(
  'scripts',
  '0.1.0',
  `You can write and run small JavaScript or TypeScript programs (Node.js 24, built-in modules only: node:fs, node:path, Intl, Date, JSON, …). Use one whenever exactness matters: arithmetic beyond the trivial, dates and durations, unit conversions, counting, sorting or totalling data, turning CSV/JSON into something else, going through many files. Don't guess a number a script can compute. Scripts run in a sandbox: they can read anything in ${root}, write only in ${outDir}, and have no network and can't start other programs; ${timeoutMs / 1000} s at most. To work on a workspace file, have the script read it (fs.readFileSync with its full path) instead of pasting its contents into the code. Print the result with console.log: only what's printed comes back to you (cut after about 5,000 characters, so print summaries, not whole files). TypeScript type annotations are fine; enums and namespaces aren't. If it fails, read the error, fix the code and run it again (two or three tries at most), then tell the owner plainly. Give a script a name only when it's worth keeping (the owner asks, or it'll be needed again); list_scripts shows the saved ones.`,
)

function scriptPath(name: string, lang: 'ts' | 'js'): string {
  return path.join(scriptsDir, `${name}.${lang}`)
}

/** A saved script by name (either extension). */
function savedScript(name: string): string | null {
  for (const lang of ['ts', 'js'] as const) {
    const p = scriptPath(name, lang)
    if (fs.existsSync(p)) return p
  }
  return null
}

function pruneTmp(): void {
  try {
    const files = fs
      .readdirSync(tmpDir)
      .map((f) => ({ f, t: fs.statSync(path.join(tmpDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(KEEP_TMP)) fs.rmSync(path.join(tmpDir, f), { force: true })
  } catch {
    // nothing to tidy
  }
}

async function run(file: string, args: string[]) {
  if (problem) return failure(`Scripts can't run: ${problem}.`)
  try {
    const result = await runFile(file, args, { readDir: root, writeDir: outDir, timeoutMs, memoryMb, bwrap: bwrap ?? undefined })
    const body = report(result, outDir, file)
    return result.exitCode === 0 && !result.stopped ? text(body) : failure(body)
  } catch (err) {
    return failure(`The script couldn't be started: ${(err as Error).message}`)
  }
}

const argsSchema = z.array(z.string()).max(20).optional().describe('Command-line arguments (process.argv.slice(2)).')

plugin.registerTool(
  'run_script',
  {
    description:
      'Write a JavaScript or TypeScript program and run it in the sandbox; returns what it printed. To run a saved script again, pass only its name (no code). To save a new one for later, pass a name with the code.',
    inputSchema: {
      code: z.string().max(100_000).optional().describe('The program. Print results with console.log. Top-level await works.'),
      lang: z.enum(['ts', 'js']).optional().describe('Default ts.'),
      name: z.string().optional().describe('Save as scripts/<name>.ts (lowercase, digits, - and _), or run that saved script if no code is given.'),
      args: argsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  async ({ code, lang = 'ts', name, args = [] }) => {
    if (name !== undefined && !NAME.test(name)) return failure(`"${name}" isn't a usable name: lowercase letters, digits, - and _, starting with a letter or digit.`)
    if (!code?.trim()) {
      if (!name) return failure('Give the code to run, or the name of a saved script.')
      const saved = savedScript(name)
      return saved ? run(saved, args) : failure(`There is no saved script "${name}". list_scripts shows the saved ones.`)
    }
    let file: string
    if (name) {
      file = scriptPath(name, lang)
      const other = scriptPath(name, lang === 'ts' ? 'js' : 'ts')
      if (fs.existsSync(other)) fs.rmSync(other) // one script per name
    } else {
      file = path.join(tmpDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.${lang}`)
    }
    fs.writeFileSync(file, code.endsWith('\n') ? code : `${code}\n`)
    if (!name) pruneTmp()
    return run(file, args)
  },
)

plugin.registerTool(
  'list_scripts',
  {
    description: 'List the saved scripts, with the first comment line of each (what it does).',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const files = fs.readdirSync(scriptsDir).filter((f) => /\.(ts|js)$/.test(f)).sort()
    if (files.length === 0) return text('There are no saved scripts yet.')
    return text(
      files
        .map((f) => {
          const first = fs.readFileSync(path.join(scriptsDir, f), 'utf8').split('\n').find((l) => l.trim())?.trim() ?? ''
          const about = /^(\/\/|\/\*|\*)/.test(first) ? ` — ${first.replace(/^\/\/\s*|^\/\*+\s*|\*\/$|^\*\s*/g, '').trim()}` : ''
          return `${f.replace(/\.(ts|js)$/, '')} (${path.join(scriptsDir, f)})${about}`
        })
        .join('\n'),
    )
  },
)

await serve(plugin)
log(`scripts: serving ${scriptsDir}${problem ? ' (sandbox unavailable)' : ''}`)
