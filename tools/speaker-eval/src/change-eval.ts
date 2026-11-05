// Tunes speaker-change detection inside phrases (apps/server/src/speaker/changes.ts):
// people taking turns with no pause, all in one phrase.
//
// Usage: node src/change-eval.ts [--conversations=60] [--singles=30]
//
// Test phrases are built from LibriSpeech: 2–4 people taking 3–6 turns of
// 1.5–8 s, silence trimmed from each turn's edges, 0–0.15 s between turns,
// at most 25 s (Jarvis's maximum phrase). Plus single-speaker phrases of the
// same length, to count false splits. Every speaker is enrolled with 3 clips
// that are never used in the test phrases; each resulting piece is identified
// among all 40 speakers (best average similarity to their clips).
//
// Reported per setting:
//   time right   share of speech time attributed to the right person
//   found        speaker changes found (a cut within ±0.5 s)
//   wrong cuts   cuts that aren't near a real change
//   splits/1     false splits per single-speaker phrase
//   ms           processing time per phrase (whole pipeline)

import fs from 'node:fs'
import path from 'node:path'
import { absorbShort, mergeSimilar, pickChanges, scan, snapToQuiet, type ChangeOptions, type ScanPoint } from '../../../apps/server/src/speaker/changes.ts'
import { MODELS } from './models.ts'
import { VoiceprintModel } from './voiceprint.ts'
import { readWav } from './wav.ts'

const args = process.argv.slice(2)
const arg = (name: string, fallback: number) => Number(args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const N_CONVERSATIONS = arg('conversations', 60)
const N_SINGLES = arg('singles', 30)
const list = (name: string, fallback: (number | null)[]) => {
  const raw = args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
  return raw ? raw.split(',').map((x) => (x === 'none' ? null : Number(x))) : fallback
}
const WINDOWS = list('window', [1, 1.5, 2]) as number[]
const THRESHOLDS = list('threshold', [0.2, 0.3, 0.4, 0.5, 0.6]) as number[]
const MERGES = list('merge', [null, 0.4, 0.5, 0.6])
const SR = 16000
const ENROLL = 3
const TOLERANCE = 0.5 * SR

interface Item {
  speaker: string
  id: string
  file: string
}
const dataDir = path.resolve('data/librispeech')
const items = (JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8')) as Item[]).sort((a, b) =>
  a.speaker === b.speaker ? a.id.localeCompare(b.id) : a.speaker.localeCompare(b.speaker),
)
const speakers = [...new Set(items.map((i) => i.speaker))]
const bySpeaker = new Map(speakers.map((s) => [s, items.flatMap((it, i) => (it.speaker === s ? [i] : []))]))

function random(seed: number): () => number {
  let x = seed >>> 0
  return () => ((x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 0xffffffff)
}

/** Removes leading/trailing silence (frames more than 35 dB below the utterance's loudest). */
function trim(samples: Float32Array): Float32Array {
  const frame = 320
  const energies: number[] = []
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let e = 0
    for (let k = i; k < i + frame; k++) e += samples[k]! * samples[k]!
    energies.push(e / frame)
  }
  const floor = Math.max(...energies) * 10 ** (-35 / 10)
  const first = energies.findIndex((e) => e > floor)
  const last = energies.length - 1 - [...energies].reverse().findIndex((e) => e > floor)
  return samples.subarray(Math.max(0, first) * frame, (last + 1) * frame)
}

const audio = items.map((it) => trim(readWav(path.join(dataDir, it.file)).samples))

interface TestPhrase {
  samples: Float32Array
  /** Ground truth: [start, end, speaker] per turn. */
  turns: [number, number, string][]
}

function build(seed: number, single: boolean): TestPhrase {
  const rand = random(seed)
  const people = single ? 1 : 2 + Math.floor(rand() * 3)
  const pool = [...speakers].sort(() => rand() - 0.5).slice(0, people)
  const turnCount = single ? 4 : 3 + Math.floor(rand() * 4)
  const parts: Float32Array[] = []
  const turns: [number, number, string][] = []
  let length = 0
  let previous = ''
  for (let t = 0; t < turnCount; t++) {
    let who = pool[Math.floor(rand() * pool.length)]!
    if (!single && who === previous) who = pool[(pool.indexOf(who) + 1) % pool.length]!
    previous = who
    const usable = bySpeaker.get(who)!.slice(ENROLL)
    const src = audio[usable[Math.floor(rand() * usable.length)]!]!
    const want = Math.round((1.5 + rand() * 6.5) * SR)
    const start = Math.floor(rand() * Math.max(1, src.length - want))
    const piece = src.subarray(start, start + Math.min(want, src.length))
    if (length + piece.length > 25 * SR) break
    const gap = single ? 0 : Math.round(rand() * 0.15 * SR)
    if (t > 0) {
      parts.push(new Float32Array(gap))
      length += gap
    }
    turns.push([length, length + piece.length, who])
    parts.push(piece)
    length += piece.length
  }
  const samples = new Float32Array(length)
  let offset = 0
  for (const p of parts) {
    samples.set(p, offset)
    offset += p.length
  }
  return { samples, turns }
}

const conversations = Array.from({ length: N_CONVERSATIONS }, (_, i) => build(1000 + i, false))
const singles = Array.from({ length: N_SINGLES }, (_, i) => build(5000 + i, true))
const all = [...conversations, ...singles]
const changes = conversations.reduce((s, c) => s + c.turns.length - 1, 0)
console.log(`${conversations.length} conversations (${changes} speaker changes, ${(conversations.reduce((s, c) => s + c.samples.length, 0) / SR / 60).toFixed(1)} min), ${singles.length} single-speaker phrases`)

// ---------------------------------------------------------------- voiceprints

const model = MODELS.find((m) => m.name === '3D-Speaker CAM++')!
const vp = await VoiceprintModel.load(path.resolve('models', model.file), 4)
let embedCalls = 0
const embed = async (s: Float32Array) => {
  embedCalls++
  return vp.embed(s)
}
const cosine = (a: Float32Array, b: Float32Array) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

process.stdout.write('enrolling speakers … ')
const enrolled = new Map<string, Float32Array[]>()
for (const s of speakers) enrolled.set(s, await Promise.all(bySpeaker.get(s)!.slice(0, ENROLL).map((i) => embed(audio[i]!))))
console.log('done')

/** Best match among all enrolled speakers (mean similarity to their clips, as the server does with ≤ 3 clips). */
function identify(v: Float32Array): string {
  let best = ''
  let bestScore = -Infinity
  for (const [s, clips] of enrolled) {
    const score = clips.reduce((sum, c) => sum + cosine(c, v), 0) / clips.length
    if (score > bestScore) [bestScore, best] = [score, s]
  }
  return best
}

/** Share of speech samples whose segment was identified as the right speaker. */
async function timeRight(phrase: TestPhrase, cuts: number[], segmentCache: Map<string, string>): Promise<{ right: number; total: number }> {
  const bounds = [0, ...cuts, phrase.samples.length]
  let right = 0
  let total = 0
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [a, b] = [bounds[i]!, bounds[i + 1]!]
    const key = `${a}:${b}`
    let who = segmentCache.get(key)
    if (!who) segmentCache.set(key, (who = identify(await embed(phrase.samples.subarray(a, b)))))
    for (const [ta, tb, speaker] of phrase.turns) {
      const overlap = Math.max(0, Math.min(b, tb) - Math.max(a, ta))
      total += overlap
      if (speaker === who) right += overlap
    }
  }
  return { right, total }
}

// ---------------------------------------------------------------- sweep

const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6)
const segmentCaches = all.map(() => new Map<string, string>())
const mergeCaches = all.map(() => new Map<string, Float32Array>())
const cachedEmbed = (i: number, phrase: TestPhrase) => async (s: Float32Array) => {
  const key = `${s.byteOffset}:${s.length}`
  let v = mergeCaches[i]!.get(key)
  if (!v) mergeCaches[i]!.set(key, (v = await embed(s)))
  return v
}

// Baseline: no splitting (today's behaviour).
let baseRight = 0
let baseTotal = 0
for (let i = 0; i < conversations.length; i++) {
  const r = await timeRight(conversations[i]!, [], segmentCaches[i]!)
  baseRight += r.right
  baseTotal += r.total
}
console.log(`\nNo splitting (today): ${pct(baseRight / baseTotal)} of speech time attributed to the right person`)

const rows: Record<string, number | string | null>[] = []
for (const windowS of WINDOWS) {
  const hopS = 0.25
  process.stdout.write(`\nscanning with ${windowS} s windows … `)
  const started = performance.now()
  const scans: ScanPoint[][] = []
  for (const p of all) scans.push(await scan(p.samples, embed, { ...baseOptions(), windowS, hopS }))
  const scanMs = (performance.now() - started) / all.length
  console.log(`${scanMs.toFixed(0)} ms per phrase`)
  console.log('  thresh  merge    time right   found  wrong cuts  splits/1   ms')
  for (const threshold of THRESHOLDS) {
    for (const mergeThreshold of MERGES) {
      const o: ChangeOptions = { ...baseOptions(), windowS, hopS, threshold, mergeThreshold }
      let right = 0
      let total = 0
      let found = 0
      let wrong = 0
      let falseSplits = 0
      const t0 = performance.now()
      for (let i = 0; i < all.length; i++) {
        const phrase = all[i]!
        const picked = pickChanges(scans[i]!, phrase.samples.length, o)
        const merged = await mergeSimilar(phrase.samples, picked, cachedEmbed(i, phrase), o)
        const cuts = await absorbShort(phrase.samples, snapToQuiet(phrase.samples, merged, o), cachedEmbed(i, phrase), o)
        if (i >= conversations.length) {
          falseSplits += cuts.length
          continue
        }
        const truth = phrase.turns.slice(1).map((t) => t[0])
        found += truth.filter((b) => cuts.some((c) => Math.abs(c - b) <= TOLERANCE)).length
        wrong += cuts.filter((c) => !truth.some((b) => Math.abs(c - b) <= TOLERANCE)).length
        const r = await timeRight(phrase, cuts, segmentCaches[i]!)
        right += r.right
        total += r.total
      }
      const ms = scanMs + (performance.now() - t0) / all.length
      const row = { windowS, threshold, mergeThreshold, timeRight: right / total, found: found / changes, wrongCuts: wrong, splitsPerSingle: falseSplits / singles.length, ms }
      rows.push(row)
      console.log(
        `  ${threshold.toFixed(2)}    ${mergeThreshold === null ? ' none' : mergeThreshold.toFixed(2).padStart(5)}    ${pct(row.timeRight)}     ${pct(row.found)}  ${String(wrong).padStart(10)}  ${row.splitsPerSingle.toFixed(2).padStart(8)}  ${ms.toFixed(0).padStart(4)}`,
      )
    }
  }
}

function baseOptions(): ChangeOptions {
  return { sampleRate: SR, windowS: 1.5, hopS: 0.25, threshold: 0.3, minSegmentS: 1, mergeThreshold: 0.4, minPieceS: 1.5, snapS: 0.25 }
}

fs.writeFileSync('results-changes.json', JSON.stringify({ conversations: conversations.length, changes, singles: singles.length, baseline: baseRight / baseTotal, rows }, null, 1))
console.log(`\n${embedCalls} voiceprints computed. Results → results-changes.json`)
