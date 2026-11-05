// Access protection: one pass-key for the whole API.
//
// The key comes from ACCESS_KEY (.env.local) or, if unset, is generated once
// and kept in DATA_DIR/access-key. A browser signs in once (POST /api/login)
// and gets an HttpOnly cookie; other clients can send "Authorization: Bearer <key>".
// Everything under /api needs one or the other, except signing in itself.

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const COOKIE = 'jarvis_session'
const COOKIE_MAX_AGE_S = 365 * 24 * 3600
/** Easy to read and type on a phone: no 0/o, 1/l/i. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
/** Routes that work without signing in. */
const OPEN_ROUTES = new Set(['/api/login', '/api/auth'])

/** "KQ7M p3xa-9rth" → "kq7mp3xa9rth": case, spaces and dashes don't matter. */
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[\s-]+/g, '')
}

export function generateKey(): string {
  const chars = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)])
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-')
}

/** ACCESS_KEY if set, else the saved generated key, else a new one (saved). */
export function loadAccessKey(dataDir: string, fromEnv: string | undefined): { key: string; generated: boolean } {
  if (fromEnv?.trim()) return { key: fromEnv.trim(), generated: false }
  const file = path.join(dataDir, 'access-key')
  if (fs.existsSync(file)) return { key: fs.readFileSync(file, 'utf8').trim(), generated: false }
  const key = generateKey()
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, `${key}\n`, { mode: 0o600 })
  return { key, generated: true }
}

/** The session cookie's value: derived from the key, so changing the key signs everyone out. */
function sessionToken(key: string): string {
  return createHmac('sha256', normaliseKey(key)).update('jarvis-session-v1').digest('base64url')
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function cookieValue(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

/** Slows down guessing: after 5 wrong keys from one address, wait (and it doubles). */
class LoginThrottle {
  private readonly failures = new Map<string, { count: number; blockedUntil: number }>()

  retryAfterS(ip: string): number {
    const f = this.failures.get(ip)
    return f && f.blockedUntil > Date.now() ? Math.ceil((f.blockedUntil - Date.now()) / 1000) : 0
  }

  failed(ip: string): void {
    const f = this.failures.get(ip) ?? { count: 0, blockedUntil: 0 }
    f.count++
    if (f.count >= 5) f.blockedUntil = Date.now() + Math.min(2 ** (f.count - 5) * 30_000, 3600_000)
    this.failures.set(ip, f)
  }

  succeeded(ip: string): void {
    this.failures.delete(ip)
  }
}

export function registerAuth(app: FastifyInstance, key: string): void {
  const token = sessionToken(key)
  const normalisedKey = normaliseKey(key)
  const throttle = new LoginThrottle()

  const signedIn = (req: FastifyRequest): boolean => {
    const cookie = cookieValue(req, COOKIE)
    if (cookie && equal(cookie, token)) return true
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    return !!bearer && equal(normaliseKey(bearer), normalisedKey)
  }

  app.addHook('onRequest', async (req, reply) => {
    const pathname = req.url.split('?')[0]!
    if (!pathname.startsWith('/api/') || OPEN_ROUTES.has(pathname)) return
    if (!signedIn(req)) return reply.code(401).send({ error: 'Not signed in', signIn: true })
  })

  /** Whether this browser is signed in. */
  app.get('/api/auth', async (req) => ({ signedIn: signedIn(req) }))

  app.post<{ Body: { key?: unknown } }>('/api/login', async (req, reply: FastifyReply) => {
    const wait = throttle.retryAfterS(req.ip)
    if (wait > 0) return reply.code(429).header('Retry-After', String(wait)).send({ error: `Too many wrong keys. Try again in ${wait} s.` })
    const given = typeof req.body?.key === 'string' ? normaliseKey(req.body.key) : ''
    if (!given || !equal(given, normalisedKey)) {
      throttle.failed(req.ip)
      req.log.warn({ ip: req.ip }, 'wrong access key')
      return reply.code(401).send({ error: 'Wrong key.' })
    }
    throttle.succeeded(req.ip)
    // Secure: the client is served over HTTPS (the dev server forwards to this one).
    reply.header('Set-Cookie', `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`)
    return { signedIn: true }
  })

  app.post('/api/logout', async (_req, reply) => {
    reply.header('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`)
    return { signedIn: false }
  })
}
