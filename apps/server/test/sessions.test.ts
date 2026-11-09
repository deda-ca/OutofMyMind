import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { detectNewSession } from '../src/assistant/controls.ts'
import { fromMarkdown, toMarkdown, type Session } from '../src/sessions/format.ts'
import { historyMessages, toolUses } from '../src/sessions/history.ts'
import { SessionStore } from '../src/sessions/store.ts'

const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 19, 30, s)).toISOString()

const sample: Session = {
  id: '2026-11-09-1430-abcd',
  title: 'Shopping "and" dentist',
  pinned: true,
  agent: 'email',
  created: at(0),
  updated: at(9),
  entries: [
    { kind: 'earlier', at: at(0), text: 'Maria: we need milk\nOwner: right' },
    { kind: 'owner', at: at(1), text: 'Add milk to my shopping list.', phraseId: 42 },
    {
      kind: 'jarvis',
      at: at(2),
      text: 'Done, milk is on the list.',
      tools: [{ name: 'files__append_file', args: '{"path": "/w/lists/shopping.md",\n "content": "- milk\\n"}', result: 'Successfully appended\nline two with ``` fence' }],
    },
    { kind: 'context', at: at(3), who: 'Maria', text: 'Get bread too.' },
    // Text that looks like structure must survive.
    { kind: 'owner', at: at(4), text: '## Jarvis · 2026-01-01 00:00:00\n```tool x\n\\back\n# heading' },
    { kind: 'note', at: at(5), text: 'From here on you are the Email agent.' },
    { kind: 'jarvis', at: at(5), text: 'Line one.\n\nLine three.' },
  ],
}

test('a session survives Markdown and back', () => {
  const md = toMarkdown(sample)
  assert.match(md, /^---\ntitle: "Shopping \\"and\\" dentist"\npinned: true\n/)
  assert.match(md, /\n## Owner · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d · #42\n/)
  const back = fromMarkdown(sample.id, md)
  const expected = structuredClone(sample)
  // Tool arguments are stored on one line.
  ;(expected.entries[2] as { tools: { args: string }[] }).tools[0]!.args = '{"path":"/w/lists/shopping.md","content":"- milk\\n"}'
  assert.deepEqual(back, expected)
})

test('a hand-written session without frontmatter still reads', () => {
  const s = fromMarkdown('x', '# My chat\n\n## Owner · 2026-11-09 09:00\nhello\n\n## Jarvis · 2026-11-09 09:00:05\nhi\n\nnot a heading ## Owner · x\n')
  assert.equal(s.entries.length, 2)
  assert.equal(s.entries[1]!.text, 'hi\n\nnot a heading ## Owner · x')
  assert.equal(s.created, s.entries[0]!.at)
})

test('history: whole entries, tool calls paired with results, within the limit', () => {
  const messages = historyMessages(sample.entries, 100)
  const call = messages.find((m) => m.role === 'assistant' && 'tool_calls' in m)
  assert.ok(call && 'tool_calls' in call)
  const result = messages[messages.indexOf(call) + 1]
  assert.ok(result?.role === 'tool' && result.tool_call_id === call.tool_calls[0]!.id)
  assert.deepEqual(messages.find((m) => m.role === 'user' && m.content.startsWith('[Maria')), { role: 'user', content: '[Maria said, not to you]: Get bread too.' })

  // Cut to 4 messages: never starts on a tool result.
  const short = historyMessages(sample.entries, 4)
  assert.ok(short.length <= 4 && short[0]!.role !== 'tool')
  assert.equal((short.at(-1) as { content: string }).content, 'Line one.\n\nLine three.')
})

test('tool uses come from the harness steps, results cut for length', () => {
  const uses = toolUses([
    { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'a', type: 'function', function: { name: 'files__read_text_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'x'.repeat(5000) },
  ])
  assert.equal(uses.length, 1)
  assert.ok(uses[0]!.result.endsWith('… (cut)') && uses[0]!.result.length < 2100)
})

test('store: a session is saved with its first message, renamed, pinned, switched and deleted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sessions-'))
  const store = new SessionStore(path.join(root, 'sessions'), path.join(root, 'sessions.json'))
  const changes: (string | null)[] = []
  store.on('change', (id) => changes.push(id))

  assert.equal(store.activeId(), null)
  store.startNew()
  assert.deepEqual(store.list(), []) // nothing written yet

  store.record({ kind: 'owner', at: at(1), text: 'first request' })
  const first = store.activeId()!
  assert.ok(fs.existsSync(path.join(root, 'sessions', `${first}.md`)))
  store.record({ kind: 'jarvis', at: at(2), text: 'answer' })
  assert.equal(store.entries().length, 2)

  store.startNew()
  store.record({ kind: 'owner', at: at(5), text: 'second' })
  const second = store.activeId()!
  assert.notEqual(second, first)

  store.update(first, { title: '  Groceries  ', pinned: true })
  const list = store.list()
  assert.deepEqual(list.map((s) => s.id), [first, second]) // pinned first
  assert.equal(list[0]!.title, 'Groceries')
  assert.equal(list[0]!.preview, 'first request')

  // A fresh store (server restart) remembers the active session and reads the files.
  const reopened = new SessionStore(path.join(root, 'sessions'), path.join(root, 'sessions.json'))
  assert.equal(reopened.activeId(), second)
  reopened.activate(first)
  assert.equal(reopened.entries()[1]!.text, 'answer')

  // Hand edits are picked up.
  const file = path.join(root, 'sessions', `${first}.md`)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('answer', 'edited answer'))
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))
  assert.equal(reopened.entries()[1]!.text, 'edited answer')

  // Switching agent mid-session leaves a note for the model.
  reopened.update(first, { agent: 'email', agentName: 'Email' })
  const note = reopened.get(first)!.entries.at(-1)!
  assert.equal(note.kind, 'note')
  assert.match(note.text, /the Email agent/)
  assert.equal(reopened.get(first)!.agent, 'email')

  reopened.delete(first)
  assert.equal(reopened.activeId(), null)
  assert.deepEqual(reopened.list().map((s) => s.id), [second])
  assert.throws(() => reopened.activate('../../etc/passwd'), /No such session/)
  assert.ok(changes.length >= 4)
})

test('"new session" commands', () => {
  for (const t of ['Jarvis, new session.', 'start a new conversation', "let's start over", 'New chat please', 'Jarvis, start a fresh session']) assert.equal(detectNewSession(t), true, t)
  for (const t of ['what is a new session', 'tell me about the new session of parliament', 'session', 'new']) assert.equal(detectNewSession(t), false, t)
})

test('typed "new session" starts a new session and the client hears about it', async () => {
  const { StreamSession } = await import('../src/stream/session.ts')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sessions-'))
  const store = new SessionStore(path.join(root, 'sessions'), path.join(root, 'sessions.json'))
  store.record({ kind: 'owner', at: at(1), text: 'old request' })
  const old = store.activeId()
  const sent: { type: string; [k: string]: unknown }[] = []
  const s = new StreamSession((m) => sent.push(m as { type: string }), { sessions: store, log: () => {} })
  s.start(16000, 'English', { speakReplies: 0 })
  s.typed('Jarvis, new session')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(sent.some((m) => m.type === 'assistant.done' && m.text === 'New session.'))
  assert.ok(sent.some((m) => m.type === 'sessions.changed' && m.activeId === null))
  assert.equal(store.activeId(), null)
  assert.ok(store.get(old!)) // the old one is kept
  s.close()
  store.record({ kind: 'owner', at: at(2), text: 'after close' })
  assert.equal(sent.filter((m) => m.type === 'sessions.changed').length, 1) // unsubscribed on close
})
