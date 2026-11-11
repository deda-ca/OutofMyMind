import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitMessage, Telegram, TelegramError } from '../telegram/telegram.ts'

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'

/** A fake Telegram: records each method and its body; answers with `reply(method)`. */
function fake(reply: (method: string, body: unknown) => unknown = () => ({ ok: true, result: true })) {
  const calls: { method: string; body: unknown }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = url.split('/').at(-1)!
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, body })
    return new Response(JSON.stringify(reply(method, body)), { status: 200 })
  }) as typeof fetch
  return { calls, bot: new Telegram(TOKEN, fetchImpl) }
}

test('telegram: a long message goes in parts, split at line breaks', async () => {
  const long = Array.from({ length: 300 }, (_, i) => `Line ${i}: ${'x'.repeat(20)}`).join('\n')
  const parts = splitMessage(long)
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4096))
  assert.equal(parts.join('\n'), long)
  const { calls, bot } = fake()
  assert.equal(await bot.sendText('42', long, { silent: true }), parts.length)
  assert.deepEqual(calls.map((c) => c.method), parts.map(() => 'sendMessage'))
  assert.deepEqual(calls[0]!.body, { chat_id: '42', text: parts[0], disable_notification: true, link_preview_options: { is_disabled: true } })
})

test("telegram: Telegram's refusal is explained, and the token never shows", async () => {
  const { bot } = fake(() => ({ ok: false, error_code: 403, description: `Forbidden: bot was blocked by the user (${TOKEN})` }))
  await assert.rejects(bot.sendText('42', 'hi'), (err: Error) => err instanceof TelegramError && /blocked by the user/.test(err.message) && !err.message.includes(TOKEN))
  const offline = new Telegram(TOKEN, (async () => {
    throw new Error(`connect ECONNREFUSED for https://api.telegram.org/bot${TOKEN}/sendMessage`)
  }) as typeof fetch)
  await assert.rejects(offline.sendText('42', 'hi'), (err: Error) => /Couldn't reach Telegram/.test(err.message) && !err.message.includes(TOKEN))
  assert.throws(() => new Telegram('not-a-token'), TelegramError)
})

test('telegram: an image goes as a photo, anything else as a document', async () => {
  const { calls, bot } = fake()
  await bot.sendFile('42', 'chart.png', new Uint8Array([1, 2, 3]), 'The chart')
  await bot.sendFile('42', 'report.pdf', new Uint8Array([4]))
  assert.deepEqual(calls.map((c) => c.method), ['sendPhoto', 'sendDocument'])
  const form = calls[0]!.body as FormData
  assert.equal(form.get('chat_id'), '42')
  assert.equal(form.get('caption'), 'The chart')
  assert.equal((form.get('photo') as File).name, 'chart.png')
})
