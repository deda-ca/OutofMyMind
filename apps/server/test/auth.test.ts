import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import Fastify from 'fastify'
import { generateKey, loadAccessKey, normaliseKey, registerAuth } from '../src/auth.ts'

const KEY = 'kq7m-p3xa-9rth-wd4c'

function app() {
  const a = Fastify()
  registerAuth(a, KEY)
  a.get('/api/secret', async () => ({ ok: true }))
  a.get('/not-api', async () => ({ ok: true }))
  return a
}

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!

test('API routes need signing in; non-API paths and the login itself do not', async () => {
  const a = app()
  assert.equal((await a.inject({ url: '/api/secret' })).statusCode, 401)
  assert.equal((await a.inject({ url: '/not-api' })).statusCode, 200)
  assert.deepEqual((await a.inject({ url: '/api/auth' })).json(), { signedIn: false })
})

test('signing in sets a cookie that unlocks the API; case and dashes in the key do not matter', async () => {
  const a = app()
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { key: 'KQ7M P3XA 9RTH WD4C' } })
  assert.equal(res.statusCode, 200)
  const setCookie = String(res.headers['set-cookie'])
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(setCookie.includes(attr), attr)
  const cookie = cookieOf(res)
  assert.equal((await a.inject({ url: '/api/secret', headers: { cookie } })).statusCode, 200)
  assert.deepEqual((await a.inject({ url: '/api/auth', headers: { cookie } })).json(), { signedIn: true })
})

test('a wrong key or a made-up cookie does not', async () => {
  const a = app()
  assert.equal((await a.inject({ method: 'POST', url: '/api/login', payload: { key: 'nope' } })).statusCode, 401)
  assert.equal((await a.inject({ url: '/api/secret', headers: { cookie: 'jarvis_session=forged' } })).statusCode, 401)
})

test('native clients can send the key as a bearer token', async () => {
  const a = app()
  assert.equal((await a.inject({ url: '/api/secret', headers: { authorization: `Bearer ${KEY}` } })).statusCode, 200)
  assert.equal((await a.inject({ url: '/api/secret', headers: { authorization: 'Bearer wrong' } })).statusCode, 401)
})

test('guessing is throttled after 5 wrong keys, even for the right key', async () => {
  const a = app()
  for (let i = 0; i < 5; i++) await a.inject({ method: 'POST', url: '/api/login', payload: { key: 'guess' } })
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { key: KEY } })
  assert.equal(res.statusCode, 429)
  assert.ok(Number(res.headers['retry-after']) > 0)
})

test('changing the key signs everyone out', async () => {
  const cookie = cookieOf(await app().inject({ method: 'POST', url: '/api/login', payload: { key: KEY } }))
  const other = Fastify()
  registerAuth(other, 'another-key-here')
  other.get('/api/secret', async () => ({ ok: true }))
  assert.equal((await other.inject({ url: '/api/secret', headers: { cookie } })).statusCode, 401)
})

test('generated keys are readable and saved once', () => {
  assert.match(generateKey(), /^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-auth-'))
  const first = loadAccessKey(dir, undefined)
  assert.equal(first.generated, true)
  assert.equal((fs.statSync(path.join(dir, 'access-key')).mode & 0o777).toString(8), '600')
  assert.deepEqual(loadAccessKey(dir, undefined), { key: first.key, generated: false })
  assert.deepEqual(loadAccessKey(dir, ' my-own-key '), { key: 'my-own-key', generated: false })
  assert.equal(normaliseKey('AB-cd ef'), 'abcdef')
  fs.rmSync(dir, { recursive: true })
})
