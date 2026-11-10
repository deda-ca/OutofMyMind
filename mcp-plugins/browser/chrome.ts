// Jarvis's Chrome: an ordinary Google Chrome with its own profile, started the
// normal way (no automation flags, so no "unsupported command-line flag" bar),
// with remote control switched on for this machine only. The owner uses it as
// a browser; Jarvis attaches to it (Playwright MCP over the Chrome DevTools
// Protocol) when asked to help. Whoever needs it first opens it: the owner
// (`npm run browser`) or Jarvis (on its first browser tool call). It's started
// detached, so it stays open when the Jarvis server restarts.
//
//   BROWSER_DIR         profile in BROWSER_DIR/profile (default data/browser)
//   BROWSER_PORT        remote-control port on 127.0.0.1 (default 9333)
//   BROWSER_EXECUTABLE  Chrome to run (default google-chrome)
//   BROWSER_HEADLESS=1  no window (a machine with no screen)
//
// Remote control is only on 127.0.0.1, but any program on this machine can use
// it (and so the signed-in accounts): fine on a personal machine. Chrome only
// allows it with a profile of its own, never your everyday one.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const browserDir = path.resolve(process.env.BROWSER_DIR?.trim() || 'data/browser')
export const profileDir = path.join(browserDir, 'profile')
export const port = Number(process.env.BROWSER_PORT) || 9333
export const endpoint = `http://127.0.0.1:${port}`

const STARTUP_MS = 15_000

/** Whether Jarvis's Chrome is running with remote control on. */
export async function chromeRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })
    return response.ok
  } catch {
    return false
  }
}

/** Opens Jarvis's Chrome if it isn't running (and `urls` in it); waits until it can be controlled. */
export async function ensureChrome(urls: string[] = []): Promise<'running' | 'started'> {
  if (await chromeRunning()) return 'running'
  fs.mkdirSync(profileDir, { recursive: true })
  const executable = process.env.BROWSER_EXECUTABLE?.trim() || 'google-chrome'
  const args = [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check']
  if (/^(1|true|yes)$/i.test(process.env.BROWSER_HEADLESS?.trim() ?? '')) args.push('--headless=new')
  const child = spawn(executable, [...args, ...urls], { detached: true, stdio: 'ignore' })
  const failed = new Promise<Error>((resolve) => child.once('error', resolve))
  child.unref()
  const deadline = Date.now() + STARTUP_MS
  while (Date.now() < deadline) {
    const err = await Promise.race([failed, new Promise<null>((r) => setTimeout(() => r(null), 250))])
    if (err) throw new Error(`Chrome couldn't be started (${executable}): ${err.message}`)
    if (await chromeRunning()) return 'started'
  }
  throw new Error(
    `Jarvis's browser didn't come up with remote control on port ${port}. If a window of it is already open (started some other way), close it and try again.`,
  )
}
