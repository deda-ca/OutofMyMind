import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { chatTarget, streamChat } from '../src/assistant/llm.ts'
import { config } from '../src/config.ts'

test('LLM_API_KEY goes to the local LLM as a Bearer token; no key, no header', async (t) => {
  const seen: (string | undefined)[] = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization)
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi.' } }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const mutable = config as { llmUrl: string; llmApiKey?: string }
  const saved = { url: mutable.llmUrl, key: mutable.llmApiKey }
  t.after(() => {
    mutable.llmUrl = saved.url
    mutable.llmApiKey = saved.key
    server.close()
  })
  mutable.llmUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  mutable.llmApiKey = 'sk-test-123'
  assert.equal(await streamChat(chatTarget(), [{ role: 'user', content: 'hello' }], () => {}), 'Hi.')
  mutable.llmApiKey = undefined
  assert.equal(await streamChat(chatTarget(), [{ role: 'user', content: 'hello' }], () => {}), 'Hi.')
  assert.deepEqual(seen, ['Bearer sk-test-123', undefined])
})
