import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { streamChat } from '../src/assistant/llm.ts'
import { llmTap, type LlmRequestTrace, type LlmResponseTrace } from '../src/assistant/llmTap.ts'

const SSE = ['Hel', 'lo.'].map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n'

test('the debug tap copies the request and the raw response, without changing the reply', async () => {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Test': 'yes' })
      res.end(SSE)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const target = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: 'm', apiKey: 'secret-key-1234567890' }
  const requests: LlmRequestTrace[] = []
  const responses: LlmResponseTrace[] = []
  try {
    // Nobody listening: nothing copied.
    assert.equal(await streamChat(target, [{ role: 'user', content: 'hi' }], () => {}), 'Hello.')

    const onRequest = (t: LlmRequestTrace) => requests.push(t)
    const onResponse = (t: LlmResponseTrace) => responses.push(t)
    llmTap.on('request', onRequest)
    llmTap.on('response', onResponse)
    const text = await streamChat(target, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }], () => {})
    llmTap.off('request', onRequest)
    llmTap.off('response', onResponse)

    assert.equal(text, 'Hello.')
    assert.equal(requests.length, 1)
    const [request] = requests
    assert.deepEqual((request!.body as { messages: unknown[] }).messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }])
    assert.equal(request!.body.stream, true)
    assert.match(request!.headers.Authorization!, /^Bearer sec… \(hidden\)$/)
    assert.doesNotMatch(JSON.stringify(request), /1234567890/)
    await new Promise((r) => setImmediate(r))
    assert.equal(responses.length, 1)
    assert.equal(responses[0]!.id, request!.id)
    assert.equal(responses[0]!.status, 200)
    assert.equal(responses[0]!.raw, SSE)
    assert.equal(responses[0]!.headers['x-test'], 'yes')
    assert.equal(responses[0]!.ended, undefined)
  } finally {
    server.close()
  }
})

test('an unreachable server is traced too', async () => {
  const responses: LlmResponseTrace[] = []
  const onResponse = (t: LlmResponseTrace) => responses.push(t)
  llmTap.on('response', onResponse)
  await assert.rejects(streamChat({ url: 'http://127.0.0.1:1', model: 'm' }, [], () => {}))
  llmTap.off('response', onResponse)
  assert.equal(responses[0]?.status, 0)
  assert.ok(responses[0]?.ended)
})
