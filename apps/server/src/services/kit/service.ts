// The kit a service imports: `import { emit, secret, state, log } from 'jarvis:service'`.
// Design: docs/services.md.

import fs from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import path from 'node:path'
import { tunnel } from './preload.ts'

const API = process.env.JARVIS_GATE ?? '/run/jarvis/api.sock'
const STATE = '/state'

function call(method: string, url: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: API, method, path: url, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * Reports an event (it must be listed under "on:" in service.md). The payload
 * is JSON, at most 32 KB; give it an `id` so the same thing is never handled
 * twice (an email's Message-ID, a post's URL).
 */
export async function emit(event: string, payload: unknown): Promise<void> {
  const r = await call('POST', '/emit', JSON.stringify({ event, payload }))
  if (r.status >= 400) throw new Error(`emit("${event}"): ${r.text}`)
}

/** A secret's value (it must be listed under "secrets:" in service.md, and set by the owner). */
export async function secret(name: string): Promise<string> {
  const r = await call('GET', `/secret/${encodeURIComponent(name)}`)
  if (r.status !== 200) throw new Error(r.text)
  return r.text
}

/** A TCP connection to host:port (listed under "hosts:"), through the gate. Wrap it in TLS yourself if needed. */
export function connect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = tunnel(host, port)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}

/** fetch, through the gate (the global one is routed through it too). */
export const fetch = globalThis.fetch

const file = (name: string) => {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name.startsWith('.')) throw new Error(`state file name "${name}": letters, digits, . - _ only`)
  return path.join(STATE, name)
}

/** Small files kept between runs (the service's own state folder). */
export const state = {
  async read(name: string): Promise<string | undefined> {
    try {
      return fs.readFileSync(file(name), 'utf8')
    } catch {
      return undefined
    }
  },
  async write(name: string, text: string): Promise<void> {
    const f = file(name)
    fs.writeFileSync(`${f}.tmp`, text)
    fs.renameSync(`${f}.tmp`, f)
  },
  async readJson<T>(name: string, fallback: T): Promise<T> {
    const text = await state.read(name)
    if (text === undefined) return fallback
    try {
      return JSON.parse(text) as T
    } catch {
      return fallback
    }
  },
  async writeJson(name: string, value: unknown): Promise<void> {
    await state.write(name, `${JSON.stringify(value, null, 2)}\n`)
  },
  async list(): Promise<string[]> {
    return fs.readdirSync(STATE).filter((n) => !n.endsWith('.tmp'))
  },
  async remove(name: string): Promise<void> {
    fs.rmSync(file(name), { force: true })
  },
}

/** A line in the service's log (console.log works too). */
export function log(...parts: unknown[]): void {
  console.log(...parts)
}
