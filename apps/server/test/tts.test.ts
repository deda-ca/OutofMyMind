import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import Fastify from 'fastify'
import { ttsRoutes } from '../src/assistant/ttsRoutes.ts'
import { config } from '../src/config.ts'

test('read aloud: voices from audio.cpp, speech in the chosen voice, unknown voices and bad text refused', async () => {
  const asked: { input: string; voice: string }[] = []
  const fake = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      // Asked per speech model (audio.cpp: ?model=…).
      if (req.url === `/v1/audio/voices?model=${config.ttsModel}`) return res.end(JSON.stringify({ voices: ['jarvis', 'reader'] }))
      asked.push(JSON.parse(body))
      res.writeHead(200, { 'Content-Type': 'audio/wav' })
      res.end(Buffer.from('RIFFfake'))
    })
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
  const saved = config.audiocppUrl
  ;(config as { audiocppUrl: string }).audiocppUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`
  const app = Fastify()
  await app.register(ttsRoutes)
  try {
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/tts/voices' })).json(), { voices: ['jarvis', 'reader'], jarvis: config.ttsVoice })
    const ok = await app.inject({ method: 'POST', url: '/api/tts', payload: { text: '  Hello   there. ', voice: 'reader' } })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.headers['content-type'], 'audio/wav')
    assert.equal(ok.body, 'RIFFfake')
    assert.deepEqual({ input: asked[0]!.input, voice: asked[0]!.voice }, { input: 'Hello there.', voice: 'reader' })
    assert.equal((await app.inject({ method: 'POST', url: '/api/tts', payload: { text: 'x', voice: 'nobody' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/api/tts', payload: { text: '' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/api/tts', payload: { text: 'a'.repeat(1001) } })).statusCode, 400)
    const sentences = await app.inject({ method: 'POST', url: '/api/tts/sentences', payload: { text: '## Today\n\nIt is **sunny** in Ottawa. See [the forecast](https://x.y).\n\n```js\nlet a = 1\n```\n- Take a hat' } })
    assert.deepEqual(sentences.json(), { sentences: ['Today', 'It is sunny in Ottawa.', 'See the forecast.', 'Take a hat'] })
    assert.equal((await app.inject({ method: 'POST', url: '/api/tts/sentences', payload: { text: ' ' } })).statusCode, 400)
  } finally {
    ;(config as { audiocppUrl: string }).audiocppUrl = saved
    await app.close()
    fake.close()
  }
})
