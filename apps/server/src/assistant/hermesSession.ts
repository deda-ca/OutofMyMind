// One long-lived Hermes session for Jarvis.
//
// Without a session header, Hermes's /v1/chat/completions derives a session
// from the system prompt + first user message. Jarvis's system prompt carries
// the time and its history restarts with every conversation, so each one
// landed in a new Hermes session. Instead, Jarvis names its session with
// X-Hermes-Session-Id: Hermes keeps the transcript (and compresses it when it
// grows; the id stays valid) and loads history from it, so the conversation
// carries on across follow-up windows, reconnects and server restarts.
//
// The id is kept in DATA_DIR/hermes-session.json. If the session is deleted
// in Hermes, its id is retired there (404), and a new one is made.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.ts'

/** X-Hermes-Session-Key: names the conversation for Hermes's long-term memory scope (stable even if the id changes). */
export const HERMES_SESSION_KEY = 'jarvis'

const file = () => path.join(config.dataDir, 'hermes-session.json')

let current: string | undefined

/** Jarvis's Hermes session id (made on first use). HERMES_SESSION_ID overrides it. */
export function hermesSessionId(): string {
  if (config.hermesSessionId) return config.hermesSessionId
  if (current) return current
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8')) as { sessionId?: unknown }
    if (typeof saved.sessionId === 'string' && /^[\w-]{1,128}$/.test(saved.sessionId)) return (current = saved.sessionId)
  } catch {
    // None yet (or unreadable): make one.
  }
  return newHermesSession()
}

/** Start a fresh Hermes session (the old one was deleted in Hermes, or the owner asked for a clean slate). */
export function newHermesSession(): string {
  current = `jarvis-${randomUUID()}`
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
    fs.writeFileSync(file(), `${JSON.stringify({ sessionId: current, createdAt: new Date().toISOString() }, null, 2)}\n`)
  } catch (err) {
    // Still works until the server restarts.
    console.error('hermes: could not save the session id:', err)
  }
  return current
}
