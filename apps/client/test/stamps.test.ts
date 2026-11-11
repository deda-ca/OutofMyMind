// Run: node --test test/ (Node strips the TypeScript types).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GAP_MS, stampLabel, stampsFor, startsGroup } from '../src/stamps.ts'

const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime()
const NOW = at(2026, 11, 11, 18)

test('a group starts at the first message, after a pause, and on a new day', () => {
  assert.equal(startsGroup(undefined, NOW), true)
  assert.equal(startsGroup(NOW - GAP_MS + 1000, NOW), false)
  assert.equal(startsGroup(NOW - GAP_MS, NOW), true)
  assert.equal(startsGroup(at(2026, 11, 10, 23, 58), at(2026, 11, 11, 0, 1)), true)
})

test('today shows just the time; another day the date too; another year the year too', () => {
  const today = stampLabel(at(2026, 11, 11, 14, 34), NOW)
  assert.match(today, /34/)
  assert.doesNotMatch(today, /Nov|11/)
  const yesterday = stampLabel(at(2026, 11, 10, 14, 34), NOW)
  assert.match(yesterday, /Nov/)
  assert.match(yesterday, /10/)
  assert.match(yesterday, /34/)
  assert.doesNotMatch(yesterday, /2026/)
  assert.match(stampLabel(at(2025, 12, 31, 9), NOW), /2025/)
})

test('stamps go before the first message of each group; untimed messages are skipped', () => {
  const stamps = stampsFor(
    [
      { key: 'a', at: at(2026, 11, 11, 9) },
      { key: 'b', at: at(2026, 11, 11, 9, 2) },
      { key: 'c', at: undefined },
      { key: 'd', at: at(2026, 11, 11, 9, 5) },
      { key: 'e', at: at(2026, 11, 11, 10) },
    ],
    NOW,
  )
  assert.deepEqual([...stamps.keys()], ['a', 'e'])
})
