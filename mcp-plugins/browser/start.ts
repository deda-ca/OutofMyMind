// The browser plugin: Microsoft's Playwright MCP (@playwright/mcp), attached to
// Jarvis's Chrome (see chrome.ts): an ordinary Chrome the owner uses, which
// Jarvis helps drive. Playwright doesn't launch the browser, so it carries no
// automation flags; it connects over the Chrome DevTools Protocol.
//
// This process sits between the harness and Playwright MCP (stdio, one JSON
// message per line) only to open Jarvis's Chrome before a tool call if it
// isn't running; everything else passes straight through.
//
// Playwright MCP runs inside BROWSER_DIR: it limits file access (uploads, saved
// snapshots, screenshots) to the folder it runs in, so a page can't get it to
// upload anything else (like apps/server/.env.local). Its saved snapshots,
// screenshots and console logs go to BROWSER_DIR/output.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { browserDir, endpoint, ensureChrome } from './chrome.ts'

const output = path.join(browserDir, 'output')
fs.mkdirSync(output, { recursive: true })

// In the release binary (JARVIS_BIN), Playwright MCP is built in: `jarvis plugin playwright`.
const cli = process.env.JARVIS_BIN ? ['plugin', 'playwright'] : [fileURLToPath(new URL('../node_modules/@playwright/mcp/cli.js', import.meta.url))]
const playwright = spawn(
  process.env.JARVIS_BIN ?? process.execPath,
  [
    ...cli,
    '--cdp-endpoint',
    endpoint,
    '--output-dir',
    output,
    // The harness can't pass images to the LLM; snapshots (text) are what it reads.
    '--image-responses',
    'omit',
    // A page's own WebMCP tools would be instructions from the web: not offered.
    '--no-webmcp',
  ],
  { cwd: browserDir, stdio: ['pipe', 'inherit', 'inherit'] },
)

/** A tool-call error straight back to the harness (one line: written whole, never mixed with Playwright's). */
function refuse(id: unknown, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } })}\n`)
}

// Messages pass through in order; a tool call first makes sure the browser is open.
let queue = Promise.resolve()
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  queue = queue.then(async () => {
    let message: { method?: string; id?: unknown } | undefined
    try {
      message = JSON.parse(line)
    } catch {
      // not ours to judge: pass it on
    }
    if (message?.method === 'tools/call') {
      try {
        await ensureChrome()
      } catch (err) {
        return refuse(message.id, `${(err as Error).message} Tell the owner.`)
      }
    }
    playwright.stdin.write(`${line}\n`)
  })
})
lines.on('close', () => void queue.then(() => playwright.stdin.end()))

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => playwright.kill(signal))
playwright.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
playwright.on('error', (err) => {
  process.stderr.write(`browser: couldn't start Playwright MCP: ${err.message}\n`)
  process.exit(1)
})
