import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Before config is read: this file's process has vision on.
process.env.LLM_VISION = 'on'
const { attachImages, imageMark } = await import('../src/assistant/vision.ts')
const { filesMessage } = await import('../src/sessions/history.ts')

test('vision: the newest images the owner added are attached, at most three; older ones say so', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-vision-'))
  fs.mkdirSync(path.join(ws, 'uploads'))
  for (const n of [1, 2, 3, 4]) fs.writeFileSync(path.join(ws, 'uploads', `p${n}.jpg`), `jpeg ${n}`)
  fs.writeFileSync(path.join(os.tmpdir(), 'outside.jpg'), 'secret')
  const messages = [
    { role: 'system', content: `rules ${imageMark('uploads/p1.jpg')}` },
    { role: 'user', content: `first ${imageMark('uploads/p1.jpg')}` },
    { role: 'tool', content: `a page said ${imageMark('uploads/p2.jpg')}` },
    { role: 'user', content: `two ${imageMark('uploads/p2.jpg')} ${imageMark('uploads/p3.jpg')}` },
    { role: 'user', content: `${imageMark('../outside.jpg')} ${imageMark('uploads/p4.jpg')}` },
    { role: 'user', content: 'What do you see?' },
  ]
  const sent = attachImages(messages, ws)
  // Untouched: not the owner's (system, tool), or nothing marked.
  assert.equal(sent[0], messages[0])
  assert.equal(sent[2], messages[2])
  assert.equal(sent[5], messages[5])
  // The newest three: p4, then p2 and p3; the one outside the workspace never.
  const urls = (m: (typeof sent)[number]) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map((p) => Buffer.from(p.image_url.url.split(',')[1], 'base64').toString()) : [])
  assert.deepEqual(urls(sent[4]!), ['jpeg 4'])
  assert.deepEqual(urls(sent[3]!), ['jpeg 2', 'jpeg 3'])
  assert.match((sent[4]!.content as unknown as { text: string }[])[0]!.text, /^\(an earlier image: no longer attached.*\(the image is attached: you can see it\)$/)
  assert.equal(typeof sent[1]!.content, 'string')
  assert.match(sent[1]!.content as string, /^first \(an earlier image: no longer attached/)
  fs.rmSync(ws, { recursive: true, force: true })
})

test("vision: a files message marks images to attach, and doesn't say images can't be seen", () => {
  const text = filesMessage([{ path: 'uploads/2026-11-11/photo.jpg', name: 'photo.jpg', type: 'image/jpeg', size: 1000 }], 'What do you see?')
  assert.match(text, /\[image attached: uploads\/2026-11-11\/photo\.jpg\]/)
  assert.doesNotMatch(text, /can't see inside/)
  const both = filesMessage([
    { path: 'uploads/a.jpg', name: 'a.jpg', type: 'image/jpeg', size: 1 },
    { path: 'uploads/b.pdf', name: 'b.pdf', type: 'application/pdf', size: 1 },
  ])
  assert.match(both, /can't see inside audio, video or PDFs yet/)
})
