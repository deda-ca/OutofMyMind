import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import Fastify from 'fastify'
import { siteRoutes } from '../src/site.ts'

function site() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-site-'))
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>app')
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'console.log(1)')
  fs.writeFileSync(path.join(dir, '..', `${path.basename(dir)}-secret.txt`), 'secret')
  const app = Fastify()
  siteRoutes(app, dir)
  return app
}

test('serves the client, with index.html for app pages and long caching for hashed assets', async () => {
  const app = site()
  const index = await app.inject('/')
  assert.equal(index.statusCode, 200)
  assert.match(index.headers['content-type'] as string, /^text\/html/)
  assert.equal(index.headers['cache-control'], 'no-cache')
  assert.equal(index.body, '<!doctype html>app')
  const asset = await app.inject('/assets/index-abc.js')
  assert.match(asset.headers['content-type'] as string, /^text\/javascript/)
  assert.match(asset.headers['cache-control'] as string, /immutable/)
  assert.equal((await app.inject('/settings')).body, '<!doctype html>app')
  assert.equal((await app.inject('/missing.js')).statusCode, 404)
})

test('never serves outside the folder, and leaves /api alone', async () => {
  const app = site()
  for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
    const r = await app.inject(url)
    assert.ok(!r.body.includes('secret'), url)
  }
  const api = await app.inject('/api/nothing')
  assert.equal(api.statusCode, 404)
  assert.match(api.headers['content-type'] as string, /json/)
})

test('refuses a folder without the built client', () => {
  assert.throws(() => siteRoutes(Fastify(), fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-site-'))), /no index\.html/)
})
