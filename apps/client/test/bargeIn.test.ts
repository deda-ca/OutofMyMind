// Run: node --test test/ (Node strips the TypeScript types).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BargeIn, type BargeInAction } from '../src/audio/bargeIn.ts'

const settings = { speechThreshold: 0.5, pauseAfterMs: 400 }

/** Feed probabilities (one per 32 ms frame); return the non-null actions with the frame they happened on. */
function run(probs: number[]): string[] {
  const b = new BargeIn()
  const out: string[] = []
  probs.forEach((p, i) => {
    const a: BargeInAction = b.frame(p, settings)
    if (a) out.push(`${a}@${i}`)
  })
  return out
}
const repeat = (p: number, n: number) => Array(n).fill(p)

test('a short hiss only ducks, then fades back up', () => {
  // 3 frames of 0.45 (maybe speech, not confident), then quiet.
  assert.deepEqual(run([...repeat(0, 5), ...repeat(0.45, 3), ...repeat(0, 20)]), ['duck@6', 'unduck@23'])
})

test('a single noisy frame does nothing', () => {
  assert.deepEqual(run([0, 0.9, 0, 0, 0.9, 0, 0]), [])
})

test('real speech ducks at once, pauses after ~0.4 s of it', () => {
  const actions = run([...repeat(0, 3), ...repeat(0.9, 20)])
  assert.deepEqual(actions, ['duck@4', 'pause@15']) // 13 frames × 32 ms = 416 ms ≥ 400
})

test('a word with a short gap still adds up (sliding window)', () => {
  // "stop it": 7 speech frames, 3 quiet, 7 speech.
  const actions = run([...repeat(0.9, 7), ...repeat(0.1, 3), ...repeat(0.9, 7)])
  assert.equal(actions[0], 'duck@1')
  assert.ok(actions.includes('pause@15'), actions.join(' '))
})

test('a longer, quieter sound that never looks like confident speech never pauses', () => {
  assert.ok(!run(repeat(0.42, 60)).some((a) => a.startsWith('pause')))
})

test('the pause threshold is adjustable', () => {
  const b = new BargeIn()
  const out = repeat(0.9, 30).map((p) => b.frame(p, { speechThreshold: 0.5, pauseAfterMs: 800 }))
  assert.equal(out.indexOf('pause'), 24) // 25 frames = 800 ms
})
