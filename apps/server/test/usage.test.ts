import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { type ChatTarget, streamChat } from '../src/assistant/llm.ts'
import { costOf, priceOf, UsageLog, usageLog, withUsage } from '../src/assistant/usage.ts'

test("prices: a connection's own, llama.cpp free, Claude's list, else none", () => {
  assert.deepEqual(priceOf({ llamaCpp: true }, 'Assistant'), { input: 0, output: 0 })
  assert.deepEqual(priceOf({ kind: 'anthropic' }, 'claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
  assert.equal(priceOf({ kind: 'anthropic' }, 'claude-sonnet-5-5')!.cacheRead, 0.1)
  assert.equal(priceOf({ kind: 'openai' }, 'gpt-5'), null)
  assert.deepEqual(priceOf({ kind: 'openai', prices: { '*': { input: 1, output: 2 } } }, 'anything'), { input: 1, output: 2 })
  assert.deepEqual(priceOf({ kind: 'anthropic', prices: { 'claude-opus-5-5': { input: 1, output: 1 } } }, 'claude-opus-5-5'), { input: 1, output: 1 })
})

test('cost: fresh input, cache reads and writes, and output each at their price', () => {
  const p = priceOf({ kind: 'anthropic' }, 'claude-opus-5-5')!
  // 1M prompt tokens: 600K read from the cache, 100K written to it, 300K fresh; 10K written.
  const cost = costOf({ input: 1_000_000, cached: 600_000, cacheWrite: 100_000, output: 10_000 }, p, 'claude-opus-5-5')
  assert.equal(cost.toFixed(4), (0.3 * 4 + 0.6 * 0.2 + 0.1 * 5 + 0.01 * 20).toFixed(4))
  // Haiku 5.5: 5× above 100K prompt tokens.
  const h = priceOf({ kind: 'anthropic' }, 'claude-haiku-5-5')!
  assert.equal(costOf({ input: 200_000, cached: 0, cacheWrite: 0, output: 0 }, h, 'claude-haiku-5-5').toFixed(4), (0.2 * 0.1 * 5).toFixed(4))
})

test('counted by day, model, source, session and turn; a spent budget is said once', async () => {
  const log = new UsageLog()
  const budgets: string[] = []
  log.on('budget', (c) => budgets.push(c))
  const claude = { connection: 'claude', kind: 'anthropic', model: 'claude-opus-5-5', budget: 0.01 }
  const { turn } = await withUsage('chat', () => 's1', async () => {
    log.record(claude, { input: 1000, cached: 0, cacheWrite: 0, output: 500 })
    log.record({ connection: 'local', llamaCpp: true, model: 'Assistant' }, { input: 2000, cached: 0, cacheWrite: 0, output: 100 })
  })
  assert.equal(turn.requests, 2)
  assert.equal(turn.model, 'local/Assistant')
  assert.equal(turn.cost.toFixed(4), (0.001 * 4 + 0.0005 * 20).toFixed(4))
  await withUsage('plugin:email', undefined, async () => log.record({ connection: 'grok', model: 'grok-4' }, { input: 10, cached: 0, cacheWrite: 0, output: 10 }))
  const s = log.summary('s1')
  assert.equal(s.today!.total.requests, 3)
  assert.equal(s.today!.total.unpriced, 1)
  assert.equal(s.today!.models['claude/claude-opus-5-5']!.output, 500)
  assert.deepEqual(Object.keys(s.today!.sources).sort(), ['chat', 'plugin:email'])
  assert.equal(s.session!.requests, 2)
  assert.equal(s.month.requests, 3)
  assert.equal(log.spentToday('claude').toFixed(4), '0.0140')
  assert.deepEqual(budgets, ['claude'])
  log.record(claude, { input: 1000, cached: 0, cacheWrite: 0, output: 0 })
  assert.deepEqual(budgets, ['claude'], 'told once a day')
})

test('kept in the data folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'))
  const a = new UsageLog()
  a.open(dir)
  a.record({ connection: 'claude', kind: 'anthropic', model: 'claude-sonnet-5-5' }, { input: 100, cached: 0, cacheWrite: 0, output: 100 })
  a.flush()
  const b = new UsageLog()
  b.open(dir)
  assert.equal(b.summary().today!.total.requests, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a response's usage chunk is counted for its connection, inside the turn", async (t) => {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi.' } }] })}\n\n`)
      res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1000 } } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const target: ChatTarget = { kind: 'openai', connection: 'test-usage', url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: 'm', llamaCpp: false, prices: { m: { input: 10, output: 100, cacheRead: 1 } } }
  const before = usageLog.spentToday('test-usage')
  const { result, turn } = await withUsage('chat', undefined, () => streamChat(target, [{ role: 'user', content: 'hello' }], () => {}))
  assert.equal(result, 'Hi.')
  assert.deepEqual({ input: turn.input, cached: turn.cached, output: turn.output }, { input: 1200, cached: 1000, output: 30 })
  const cost = (200 * 10 + 1000 * 1 + 30 * 100) / 1e6
  assert.equal(turn.cost.toFixed(6), cost.toFixed(6))
  assert.equal((usageLog.spentToday('test-usage') - before).toFixed(6), cost.toFixed(6))
})
