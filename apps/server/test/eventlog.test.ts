import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { EventLog } from '../src/plugins/eventlog.ts'

test("event log: a subscriber that wasn't running gets what it missed, in order, once, and never its own", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-eventlog-'))
  const log = new EventLog(dir)
  log.append('email', 'email.address-seen', { address: 'a@example.com' })
  log.append('email', 'email.received', { subject: 'hi' })
  const seen = log.append('email', 'email.address-seen', { address: 'b@example.com' })
  log.append('contacts', 'email.address-seen', { address: 'own@example.com' })
  assert.deepEqual(log.missed('contacts', ['email.address-seen']).map((e) => e.payload.address), ['a@example.com', 'b@example.com'])
  log.sent('contacts', seen.seq)
  log.flush()
  // After a restart: the log and where each subscriber got to are kept.
  const again = new EventLog(dir)
  assert.deepEqual(again.missed('contacts', ['email.address-seen']), [])
  const later = again.append('email', 'email.address-seen', { address: 'c@example.com' })
  assert.equal(later.seq, 5)
  assert.deepEqual(again.missed('contacts', ['email.address-seen']).map((e) => e.payload.address), ['c@example.com'])
  // Another subscriber starting fresh gets everything of its types.
  assert.equal(again.missed('calendar', ['email.received']).length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})
