// Speaker-change detection logic, with fake voiceprints: each "speaker" is
// audio at a constant level (1, 2, 3 …), and the fake voiceprint of a window
// points in a direction set by the mix of levels it contains.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CHANGE_OPTIONS, findSpeakerChanges, pickChanges, snapToQuiet } from '../src/speaker/changes.ts'

const SR = 16000

/** Turns: [speaker number (1–4), seconds]. Speakers are constant-level signals; 0 = silence. */
function audio(turns: [number, number][]): Float32Array {
  const parts = turns.map(([speaker, seconds]) => new Float32Array(Math.round(seconds * SR)).fill(speaker * 0.1))
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Fake voiceprint: one dimension per speaker, weighted by how much of the window they fill. */
async function embed(samples: Float32Array): Promise<Float32Array> {
  const v = new Float32Array(4)
  for (const x of samples) {
    const speaker = Math.round(x * 10)
    if (speaker >= 1 && speaker <= 4) v[speaker - 1]! += 1
  }
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
}

const near = (actual: number[], expected: number[], tolerance = 0.3 * SR) =>
  actual.length === expected.length && actual.every((a, i) => Math.abs(a - expected[i]!) <= tolerance)

test('one speaker: no cuts', async () => {
  assert.deepEqual(await findSpeakerChanges(audio([[1, 12]]), embed), [])
})

test('four speakers back to back: a cut at each change', async () => {
  const cuts = await findSpeakerChanges(audio([[1, 4], [2, 4], [3, 4], [4, 4]]), embed)
  assert.ok(near(cuts, [4 * SR, 8 * SR, 12 * SR]), `cuts at ${cuts.map((c) => (c / SR).toFixed(2))} s`)
})

test('the same speaker returning is still split (A, B, A)', async () => {
  const cuts = await findSpeakerChanges(audio([[1, 5], [2, 5], [1, 5]]), embed)
  assert.ok(near(cuts, [5 * SR, 10 * SR]), `cuts at ${cuts.map((c) => (c / SR).toFixed(2))} s`)
})

test('too short to split (under two windows)', async () => {
  assert.deepEqual(await findSpeakerChanges(audio([[1, 1], [2, 1]]), embed), [])
})

test('no segment shorter than minSegmentS: dips near an edge are ignored, and of two close dips the deeper wins', () => {
  const points = [
    { at: 0.5 * SR, similarity: 0 }, // a dip, but only 0.5 s from the start
    { at: 1.5 * SR, similarity: 0.25 },
    { at: 2 * SR, similarity: 0.1 }, // a dip …
    { at: 2.25 * SR, similarity: 0.3 },
    { at: 2.5 * SR, similarity: 0.05 }, // … and a deeper one 0.5 s later
    { at: 3 * SR, similarity: 0.35 },
  ]
  assert.deepEqual(pickChanges(points, 6 * SR, DEFAULT_CHANGE_OPTIONS), [2.5 * SR])
})

test('cuts snap to the quietest moment nearby', () => {
  const samples = audio([[1, 2], [0, 0.1], [2, 2]]) // 100 ms of silence at 2.0–2.1 s
  const [cut] = snapToQuiet(samples, [2.2 * SR], DEFAULT_CHANGE_OPTIONS)
  assert.ok(cut! >= 2 * SR && cut! <= 2.1 * SR, `snapped to ${(cut! / SR).toFixed(3)} s`)
})
