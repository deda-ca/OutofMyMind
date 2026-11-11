import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadPluginConfig } from '../src/harness/config.ts'
import { McpHub, type PluginEvent } from '../src/harness/mcp.ts'

const fixture = path.resolve(import.meta.dirname, 'fixtures', 'echo-plugin')

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-platform-'))
  const file = path.join(dir, 'mcp.json')
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { echo: { plugin: fixture } } }))
  process.env.ECHO_SETTING = 'given'
  process.env.SECRET_NOT_NAMED = 'leaked'
  const events: [string, PluginEvent][] = []
  const requests: [string, string, Record<string, unknown>][] = []
  const hub = new McpHub(loadPluginConfig(file), () => {})
  hub.link = {
    event: (plugin, e) => void events.push([plugin, e]),
    request: async (plugin, method, params) => {
      requests.push([plugin, method, params])
      return {}
    },
  }
  let heard: number | null = null
  hub.ownerHeard = () => heard
  await hub.start()
  return { hub, events, requests, hear: () => (heard = Date.now() + 1), cleanup: async () => (await hub.close(), fs.rmSync(dir, { recursive: true, force: true })) }
}

test('platform: a plugin with plugin.json gets only its named settings, and its events and requests reach the server', async () => {
  const t = await start()
  try {
    assert.deepEqual(t.hub.manifests().map((m) => [m.manifest.name, m.connected]), [['echo', true]])
    const r = await t.hub.call('echo__say', { words: 'hello' })
    assert.equal(r.text, 'said hello (data yes, setting given, secret none)')
    await new Promise((res) => setTimeout(res, 100))
    assert.deepEqual(t.events.map(([p, e]) => [p, e.type, e.id, (e.payload as { words: string }).words]), [['echo', 'echo.said', 'said-hello', 'hello'], ['echo', 'echo.undeclared', undefined, 'hello']])
    assert.deepEqual(t.requests, [['echo', 'jarvis/notify', { title: 'Echo', text: 'heard: hello', urgency: 'info' }]])
  } finally {
    await t.cleanup()
  }
})

test("platform: a tool marked confirm needs a code and the owner's yes after it; tab-only tools are hidden from the LLM", async () => {
  const t = await start()
  try {
    const names = t.hub.tools().map((x) => x.function.name)
    assert.deepEqual(names.sort(), ['echo__say', 'echo__send'])
    const send = t.hub.tools().find((x) => x.function.name === 'echo__send')!
    assert.ok('confirm' in (send.function.parameters.properties as object))
    // First: not done, a code.
    const first = await t.hub.call('echo__send', { to: 'bob' })
    const code = /confirm "([0-9a-f]{6})"/.exec(first.text)?.[1]
    assert.ok(code && /Not done yet/.test(first.text), first.text)
    // The code without the owner's yes; with other arguments; then right.
    assert.match((await t.hub.call('echo__send', { to: 'bob', confirm: code })).text, /hasn't answered/)
    t.hear()
    assert.match((await t.hub.call('echo__send', { to: 'eve', confirm: code })).text, /unknown, expired, or for something else/)
    assert.equal((await t.hub.call('echo__send', { to: 'bob', confirm: code })).text, 'sent to bob')
    // Used once.
    assert.match((await t.hub.call('echo__send', { to: 'bob', confirm: code })).text, /unknown/)
    // The tab: its own tools, no gate.
    assert.match((await t.hub.call('echo__tab_only', {})).text, /only for the echo tab/)
    assert.equal((await t.hub.callAsOwner('echo', 'tab_only', {})).text, 'tab data')
    assert.equal((await t.hub.callAsOwner('echo', 'send', { to: 'carol' })).text, 'sent to carol')
  } finally {
    await t.cleanup()
  }
})
