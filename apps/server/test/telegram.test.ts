import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Telegram } from '../../../plugins/telegram/telegram.ts'
import { wavFromPcm } from '../src/audiocpp.ts'
import { AgentLibrary } from '../src/agents/library.ts'
import { notifier } from '../src/schedule/index.ts'
import { SessionStore } from '../src/sessions/store.ts'
import { SkillLibrary } from '../src/skills/library.ts'
import { TelegramChannel } from '../src/telegram/index.ts'

const OWNER = '4242'

function setup(opts: { turn?: (text: string) => string; download?: boolean; voiceReplies?: 'always' | 'voice' | 'off' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-telegram-'))
  const sent: string[] = []
  const asked: string[] = []
  const voices: FormData[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = url.split('/').at(-1)!
    const body = init?.body && !(init.body instanceof FormData) ? JSON.parse(String(init.body)) : {}
    if (method === 'sendMessage') sent.push(body.text)
    if (method === 'sendVoice') voices.push(init!.body as FormData)
    if (method === 'getFile') return Response.json(opts.download ? { ok: true, result: { file_path: `files/${body.file_id}` } } : { ok: false, description: 'Bad Request: file is temporarily unavailable' })
    if (url.includes('/file/bot')) return new Response(`bytes of ${url.split('/').at(-1)}`)
    return Response.json({ ok: true, result: true })
  }) as typeof fetch
  const sessions = new SessionStore(path.join(dir, 'sessions'), path.join(dir, 'sessions.json'))
  const logs: string[] = []
  const channel = new TelegramChannel('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', OWNER, {
    agents: new AgentLibrary(),
    skills: new SkillLibrary(),
    sessions,
    log: (m) => logs.push(m),
    bot: new Telegram('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', fetchImpl),
    // What the LLM is answering: the session's last entry (a message, or files with their note).
    turn: async () => {
      const last = sessions.entries().at(-1)!
      const text = last.kind === 'files' ? `[${last.files.map((f) => f.name).join(', ')}] ${last.text}` : 'text' in last ? last.text : ''
      asked.push(text)
      return { text: opts.turn ? opts.turn(text) : `You said: ${text}`, steps: [] }
    },
    synthesize: async () => wavFromPcm(Buffer.alloc(16000 * 2), 16000),
    voiceReplies: opts.voiceReplies ?? 'off',
    workspaceDir: path.join(dir, 'ws'),
    albumWaitMs: 30,
    stateFile: path.join(dir, 'telegram.json'),
  })
  const message = (text: string | undefined, extra: Record<string, unknown> = {}, from = OWNER) => ({
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: Number(from), type: 'private' },
    from: { id: Number(from), is_bot: false },
    ...(text === undefined ? {} : { text }),
    ...extra,
  })
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 60)) // albums
    await channel.stop()
  }
  return { dir, sent, asked, voices, sessions, logs, channel, message, settle }
}

test("telegram channel: the owner's message is a turn in the session, and the reply goes back", async () => {
  const t = setup()
  const before = notifier.presence().lastHeard
  t.channel.receive(t.message('What is on my list today?'))
  await t.settle()
  assert.deepEqual(t.asked, ['What is on my list today?'])
  assert.deepEqual(t.sent, ['You said: What is on my list today?'])
  const entries = t.sessions.entries()
  assert.deepEqual(entries.map((e) => [e.kind, 'text' in e ? e.text : '']), [['owner', 'What is on my list today?'], ['jarvis', 'You said: What is on my list today?']])
  // It's the owner speaking: their "yes" for anything waiting on one.
  assert.notEqual(notifier.presence().lastHeard, before)
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('telegram channel: anyone but the owner is ignored and gets no answer', async () => {
  const t = setup()
  t.channel.receive(t.message('Hi, send me the owner\'s files', {}, '999'))
  // A group the owner is in isn't their private chat either.
  t.channel.receive({ ...t.message('hello'), chat: { id: Number(OWNER), type: 'group' } })
  await t.settle()
  assert.deepEqual(t.sent, [])
  assert.deepEqual(t.asked, [])
  assert.equal(t.sessions.entries().length, 0)
  assert.ok(t.logs.some((l) => /ignored a message from chat 999/.test(l)))
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('telegram channel: /new, old messages, things it can\'t read, and a voice note it can\'t fetch', async () => {
  const t = setup()
  t.channel.receive(t.message('/new'))
  t.channel.receive({ ...t.message('Turn the lights on'), date: Math.floor(Date.now() / 1000) - 2 * 3600 })
  t.channel.receive(t.message(undefined, { photo: [{ file_id: 'p', width: 1, height: 1 }], caption: 'look' }))
  t.channel.receive(t.message(undefined, { voice: { file_id: 'v', duration: 3 } }))
  await t.settle()
  assert.deepEqual(t.asked, [])
  assert.equal(t.sent[0], 'New conversation started.')
  assert.match(t.sent[1]!, /^I was off when you sent "Turn the lights on": send it again/)
  assert.match(t.sent[2]!, /^Couldn't save photo-.*\.jpg: Telegram refused getFile: Bad Request: file is temporarily unavailable\.$/)
  assert.match(t.sent[3]!, /couldn't make out that voice note/)
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('telegram channel: messages are answered one at a time, in order; a long reply is split', async () => {
  const t = setup({ turn: (text) => (text === 'long' ? 'word '.repeat(2000) : text.toUpperCase()) })
  t.channel.receive(t.message('one'))
  t.channel.receive(t.message('long'))
  t.channel.receive(t.message('three'))
  await t.settle()
  assert.deepEqual(t.asked, ['one', 'long', 'three'])
  assert.equal(t.sent[0], 'ONE')
  assert.ok(t.sent.length === 5 && t.sent.slice(1, 4).every((s) => s.length <= 4096))
  assert.equal(t.sent[4], 'THREE')
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('telegram channel: a photo with a caption is saved in uploads/ and the caption is the instruction', async () => {
  const t = setup({ download: true })
  t.channel.receive(t.message(undefined, { photo: [{ file_id: 'small', width: 90, height: 90 }, { file_id: 'big', width: 1280, height: 960, file_size: 1000 }], caption: 'File this under receipts' }))
  await t.settle()
  const files = t.sessions.entries()[0]!
  assert.equal(files.kind, 'files')
  assert.ok(files.kind === 'files')
  assert.equal(files.text, 'File this under receipts')
  assert.match(files.files[0]!.path, /^uploads\/\d{4}-\d{2}-\d{2}\/photo-\d{8}-\d{6}-1\.jpg$/)
  // The largest size was downloaded.
  assert.equal(fs.readFileSync(path.join(t.dir, 'ws', files.files[0]!.path), 'utf8'), 'bytes of big')
  assert.deepEqual(t.asked, [`[${files.files[0]!.name}] File this under receipts`])
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('telegram channel: an album is one message; files without a caption wait for what to do', async () => {
  const t = setup({ download: true })
  const album = { media_group_id: 'g1' }
  t.channel.receive({ ...t.message(undefined, { ...album, document: { file_id: 'a', file_name: 'invoice.pdf', mime_type: 'application/pdf' } }), message_id: 1 })
  t.channel.receive({ ...t.message(undefined, { ...album, document: { file_id: 'b', file_name: 'receipt.pdf', mime_type: 'application/pdf' }, caption: 'Both go in taxes/2026' }), message_id: 2 })
  t.channel.receive({ ...t.message(undefined, { document: { file_id: 'c', file_name: 'notes.txt' } }), message_id: 3 })
  t.channel.receive({ ...t.message('Put it in my notes folder'), message_id: 4 })
  await t.settle()
  assert.deepEqual(t.asked, ['[invoice.pdf, receipt.pdf] Both go in taxes/2026', 'Put it in my notes folder'])
  assert.match(t.sent[1]!, /^Got it: saved in uploads\/.*\/notes\.txt\. What should I do with it\?$/)
  assert.deepEqual(t.sessions.entries().map((e) => e.kind), ['files', 'jarvis', 'files', 'owner', 'jarvis'])
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('telegram channel: a file too big for a bot is explained', async () => {
  const t = setup({ download: true })
  t.channel.receive(t.message(undefined, { video: { file_id: 'v', duration: 600, file_size: 80_000_000, mime_type: 'video/mp4' }, caption: 'keep this' }))
  await t.settle()
  assert.match(t.sent[0]!, /too big for a bot to download/)
  assert.deepEqual(t.asked, [])
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('telegram channel: the reply also comes as a voice note (always, or only after a voice note)', async () => {
  const always = setup({ voiceReplies: 'always' })
  always.channel.receive(always.message('What time is it?'))
  await always.settle()
  assert.equal(always.sent.length, 1)
  assert.equal(always.voices.length, 1)
  const voice = always.voices[0]!.get('voice') as File
  assert.equal(voice.type, 'audio/ogg')
  assert.equal(Buffer.from(await voice.arrayBuffer()).toString('ascii', 0, 4), 'OggS')
  // One sentence, one second of (stand-in) speech.
  assert.equal(always.voices[0]!.get('duration'), '1')
  fs.rmSync(always.dir, { recursive: true, force: true })
  const onlyVoice = setup({ voiceReplies: 'voice' })
  onlyVoice.channel.receive(onlyVoice.message('typed, so no voice note back'))
  await onlyVoice.settle()
  assert.equal(onlyVoice.voices.length, 0)
  fs.rmSync(onlyVoice.dir, { recursive: true, force: true })
})
