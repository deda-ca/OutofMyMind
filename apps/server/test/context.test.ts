import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { contextMonitor, type ContextStats } from '../src/assistant/context.ts'
import { postChat, readSse } from '../src/assistant/llm.ts'

test('the context meter: sections counted with the tokenizer, the rest is chat formatting, the limit from /props', async () => {
  let sentBody: Record<string, unknown> = {}
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url!.startsWith('/props')) return res.end(JSON.stringify({ default_generation_settings: { n_ctx: 32768 } }))
      if (req.url === '/tokenize') {
        // One token per word: easy to check.
        const words = (JSON.parse(body) as { content: string }).content.split(/\s+/).filter(Boolean).length
        return res.end(JSON.stringify({ tokens: Array.from({ length: words }, () => 1) }))
      }
      sentBody = JSON.parse(body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi.' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 60 } } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const target = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: 'm' }
  try {
    const system = 'one two three\n\nfour five'
    contextMonitor.labelSystem(system, [
      { label: 'SYSTEM.md', text: 'one two three' },
      { label: 'Date & time', text: 'four five' },
    ])
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: 'earlier question here' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'files__read_text_file', arguments: '{"path":"x"}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'file contents here' },
      { role: 'user', content: '(Room note from Jarvis: nobody else)' },
      { role: 'user', content: 'what now' },
    ]
    const tools = [
      { type: 'function', function: { name: 'files__read_text_file', parameters: {} } },
      { type: 'function', function: { name: 'jarvis__show_file', parameters: {} } },
    ]
    const update = new Promise<ContextStats>((resolve) => contextMonitor.once('update', resolve))
    const response = await postChat(target, { messages, tools })
    for await (const _ of readSse(response.body!)) {
      // drain
    }
    const stats = await update
    assert.deepEqual(sentBody.stream_options, { include_usage: true })
    assert.equal(stats.limit, 32768)
    assert.equal(stats.used, 100)
    assert.equal(stats.cached, 60)
    assert.equal(stats.reply, 2)
    const by = Object.fromEntries(stats.sections.map((s) => [s.key, s]))
    assert.deepEqual(by.system!.items, [
      { label: 'SYSTEM.md', tokens: 3 },
      { label: 'Date & time', tokens: 2 },
    ])
    assert.equal(by.tools!.items!.length, 2)
    assert.equal(by.history!.tokens, 5) // "earlier question here" + "earlier answer"
    assert.equal(by.history!.label, 'Conversation (2 messages)')
    assert.match(by.toolcalls!.label, /\(2 messages\)/)
    assert.equal(by.notes!.tokens, 6)
    assert.equal(by.latest!.tokens, 2)
    const counted = stats.sections.filter((s) => s.key !== 'format').reduce((n, s) => n + s.tokens, 0)
    assert.equal(by.format!.tokens, 100 - counted)
  } finally {
    server.close()
  }
})
