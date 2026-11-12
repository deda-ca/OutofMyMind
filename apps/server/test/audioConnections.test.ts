import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { AudioConfigError, defaultAudioRef, fixWavSizes, readAudioConnections, resolveAudio, speakWav, transcribeWav } from '../src/audioConnections.ts'
import { wavFromPcm } from '../src/audiocpp.ts'
import { config } from '../src/config.ts'
import { SessionStore } from '../src/sessions/store.ts'

test('no audio.connections: one audio.cpp "local" from audio.url, on asrModel and ttsModel', () => {
  const list = readAudioConnections({}, { url: 'http://127.0.0.1:5552' })
  assert.deepEqual(list, [{ id: 'local', label: 'audio.cpp', kind: 'audiocpp', url: 'http://127.0.0.1:5552', stt: [], tts: [], voices: [] }])
  assert.equal(defaultAudioRef('stt', list, ''), `local/${config.asrModel}`)
  assert.equal(defaultAudioRef('tts', list, ''), `local/${config.ttsModel}`)
})

test('audio.connections: defaults, "connection/model" picks, mistakes said', () => {
  const list = readAudioConnections({
    audio: {
      connections: [
        { id: 'local', url: 'http://127.0.0.1:5552' },
        { id: 'openai', kind: 'openai', apiKey: 'k', stt: ['gpt-4o-transcribe'], tts: ['gpt-4o-mini-tts'], voices: ['alloy', 'nova'] },
      ],
    },
  })
  assert.equal(list[1]!.url, 'https://api.openai.com')
  // Nothing chosen: the first connection that lists models of that kind.
  assert.equal(defaultAudioRef('tts', list, ''), 'openai/gpt-4o-mini-tts')
  assert.equal(defaultAudioRef('tts', list, 'local/Qwen3-TTS'), 'local/Qwen3-TTS')
  assert.equal(resolveAudio('tts', 'local/Other-TTS', list).model, 'Other-TTS')
  assert.match(resolveAudio('stt', 'gone/x', list).note!, /"gone" isn't in audio.connections/)
  const bad = (connections: unknown, says: RegExp) => assert.throws(() => readAudioConnections({ audio: { connections } }), (e: Error) => e instanceof AudioConfigError && says.test(e.message))
  bad([{ id: 'x' }], /needs its "url"/)
  bad([{ id: 'x', kind: 'openai', tts: ['t'] }], /voices/)
  bad([{ id: 'x', kind: 'openai' }], /models/)
  bad([{ id: 'x', kind: 'whisper', url: 'u' }], /kind/)
  bad([{ id: 'a', url: 'u' }, { id: 'a', url: 'v' }], /two connections/)
})

test('an OpenAI-style server: transcription as a form upload with the ISO language, speech asked for as WAV', async (t) => {
  const asked: { url: string; auth?: string; type?: string; body: string }[] = []
  const fake = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('latin1')
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      asked.push({ url: req.url!, auth: req.headers.authorization, type: req.headers['content-type'], body })
      if (req.url === '/v1/audio/transcriptions') return res.end(JSON.stringify({ text: ' hello there ' }))
      // A streamed WAV: sizes unknown in the header.
      const wav = wavFromPcm(Buffer.alloc(320), 24000)
      wav.writeUInt32LE(0xffffffff, 4)
      wav.writeUInt32LE(0xffffffff, 40)
      res.end(wav)
    })
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
  t.after(() => fake.close())
  const url = `http://127.0.0.1:${(fake.address() as { port: number }).port}`
  const list = readAudioConnections({ audio: { connections: [{ id: 'cloud', kind: 'openai', url, apiKey: 'sk-test', stt: ['whisper-1'], tts: ['tts-1'], voices: ['nova'] }] } })

  assert.equal(await transcribeWav(wavFromPcm(Buffer.alloc(320), 16000), 'English', undefined, list), 'hello there')
  assert.equal(asked[0]!.auth, 'Bearer sk-test')
  assert.match(asked[0]!.type!, /^multipart\/form-data/)
  assert.match(asked[0]!.body, /name="model"\r\n\r\nwhisper-1/)
  assert.match(asked[0]!.body, /name="language"\r\n\r\nen/)

  const wav = await speakWav('Hi.', 'nova', undefined, undefined, list)
  assert.deepEqual(JSON.parse(asked[1]!.body), { model: 'tts-1', input: 'Hi.', voice: 'nova', response_format: 'wav' })
  assert.equal(wav.readUInt32LE(4), wav.length - 8)
  assert.equal(wav.readUInt32LE(40), 320)
})

test('a WAV with real sizes is left as it is', () => {
  const wav = wavFromPcm(Buffer.alloc(100), 16000)
  assert.deepEqual(fixWavSizes(Buffer.from(wav)), wav)
})

test("a session's own model: kept in its file, '' back to the agent's, a new session starts on its agent's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-model-'))
  const store = new SessionStore(path.join(dir, 'sessions'), path.join(dir, 'sessions.json'))
  store.setNewModel('claude/claude-opus-5-5')
  assert.equal(store.model(), 'claude/claude-opus-5-5')
  store.record({ kind: 'owner', at: new Date().toISOString(), text: 'hello' })
  const id = store.activeId()!
  assert.equal(store.get(id)!.model, 'claude/claude-opus-5-5')
  assert.match(fs.readFileSync(path.join(dir, 'sessions', `${id}.md`), 'utf8'), /^model: claude\/claude-opus-5-5$/m)
  store.update(id, { model: '' })
  assert.equal(store.model(), '')
  store.update(id, { model: 'local/Assistant' })
  store.startNew()
  assert.equal(store.model(), '')
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a session's own voice: kept in its file, '' back to the agent's, a new session starts on its agent's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-voice-'))
  const store = new SessionStore(path.join(dir, 'sessions'), path.join(dir, 'sessions.json'))
  store.setNewVoice('zoe')
  store.record({ kind: 'owner', at: new Date().toISOString(), text: 'hello' })
  const id = store.activeId()!
  assert.equal(store.voice(), 'zoe')
  assert.match(fs.readFileSync(path.join(dir, 'sessions', `${id}.md`), 'utf8'), /^voice: zoe$/m)
  // Read back from the file by a fresh store.
  assert.equal(new SessionStore(path.join(dir, 'sessions'), path.join(dir, 'sessions.json')).voice(), 'zoe')
  store.update(id, { voice: '' })
  assert.equal(store.voice(), '')
  store.update(id, { voice: 'jarvis' })
  store.startNew()
  assert.equal(store.voice(), '')
  fs.rmSync(dir, { recursive: true, force: true })
})
