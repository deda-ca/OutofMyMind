// A call's transcript, after it ends: each leg's recording is cut into
// utterances where it has speech (by loudness against that leg's own noise
// floor), each utterance is transcribed, and the legs are interleaved by time.
// Each leg is one person, so who said what needs no guessing.

import { FRAME_SAMPLES } from './rtp.ts'

const FRAME_MS = 20
const SAMPLE_RATE = 16000

export interface Utterance {
  /** Milliseconds from the start of the call. */
  startMs: number
  pcm: Int16Array
}

/** Where a leg's recording has speech. */
export function utterances(pcm: Int16Array, offsetMs = 0, o: { gapMs?: number; minMs?: number; maxMs?: number; padMs?: number } = {}): Utterance[] {
  const gap = Math.round((o.gapMs ?? 700) / FRAME_MS)
  const min = Math.round((o.minMs ?? 300) / FRAME_MS)
  const max = Math.round((o.maxMs ?? 25_000) / FRAME_MS)
  const pad = Math.round((o.padMs ?? 160) / FRAME_MS)
  const frames = Math.floor(pcm.length / FRAME_SAMPLES)
  if (!frames) return []
  const levels = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * FRAME_SAMPLES; i < (f + 1) * FRAME_SAMPLES; i++) sum += pcm[i]! * pcm[i]!
    levels[f] = Math.sqrt(sum / FRAME_SAMPLES)
  }
  // The noise floor: the 20th percentile of the frames' loudness.
  const sorted = [...levels].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0
  const threshold = Math.max(300, floor * 4)

  const regions: [number, number][] = []
  let start = -1
  let last = -1
  for (let f = 0; f < frames; f++) {
    if (levels[f]! < threshold) continue
    if (start >= 0 && f - last <= gap && f - start < max) {
      last = f
      continue
    }
    if (start >= 0) regions.push([start, last])
    start = f
    last = f
  }
  if (start >= 0) regions.push([start, last])

  return regions
    .filter(([a, b]) => b - a + 1 >= min)
    .map(([a, b]) => {
      const from = Math.max(0, a - pad)
      const to = Math.min(frames, b + 1 + pad)
      return { startMs: offsetMs + from * FRAME_MS, pcm: pcm.subarray(from * FRAME_SAMPLES, to * FRAME_SAMPLES) }
    })
}

export interface Line {
  atMs: number
  who: string
  text: string
}

export function formatTranscript(lines: Line[]): string {
  const time = (ms: number) => {
    const s = Math.floor(ms / 1000)
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }
  return [...lines]
    .sort((a, b) => a.atMs - b.atMs)
    .map((l) => `- [${time(l.atMs)}] **${l.who}:** ${l.text}`)
    .join('\n')
}

export const PHONE_SAMPLE_RATE = SAMPLE_RATE
