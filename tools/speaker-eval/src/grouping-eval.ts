// Tunes the rule that groups unknown voices into "Speaker A", "Speaker B", …
// (docs/speaker-recognition.md, M3), by replaying it on LibriSpeech exactly as
// the server will run it, phrase by phrase.
//
// Usage: node src/grouping-eval.ts [--model=3d-speaker cam] [--seeds=5]
//
// Per phrase, in a shuffled order (like conversations arriving over time):
//   1. owner?   best similarity to the owner's enrolled clips ≥ OWNER_THRESHOLD
//   2. too short (< 1 s of audio)?            → uncertain, not grouped
//   3. best similarity to a known group ≥ join → that group
//                                              (added to its library only if ≥ 2 s and ≥ join + addMargin)
//   4. otherwise                               → new group
//
// Reported for each setting:
//   groups/speaker  how many groups each real person ended up split into (ideal 1.00)
//   mixed           share of grouped phrases sitting in a group dominated by someone else
//   impure groups   groups holding ≥ 2 phrases from each of two or more people
//   owner missed    owner phrases not recognised as the owner
//   false owner     other people's phrases taken for the owner
//   uncertain       phrases not grouped (too short)

import fs from 'node:fs'
import path from 'node:path'
import { MODELS } from './models.ts'
import { VoiceprintModel } from './voiceprint.ts'
import { readWav } from './wav.ts'

const args = process.argv.slice(2)
const modelName = args.find((a) => a.startsWith('--model='))?.slice(8) ?? '3d-speaker cam'
const seeds = Number(args.find((a) => a.startsWith('--seeds='))?.slice(8) ?? 5)
const dataDir = path.resolve('data/librispeech')
const SAMPLE_RATE = 16000

const OWNER_THRESHOLD = 0.43
const OWNER_ENROLL_CLIPS = 3
const MIN_GROUP_SECONDS = 1
const MIN_LIBRARY_SECONDS = 2
const LIBRARY_CAP = 50

interface Item {
  speaker: string
  id: string
  file: string
}
const items = (JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8')) as Item[]).sort((a, b) =>
  a.speaker === b.speaker ? a.id.localeCompare(b.id) : a.speaker.localeCompare(b.speaker),
)
const audio = items.map((it) => readWav(path.join(dataDir, it.file)).samples)

function random(seed: number): () => number {
  let x = seed >>> 0
  return () => ((x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 0xffffffff)
}
function rms(a: Float32Array): number {
  let s = 0
  for (const v of a) s += v * v
  return Math.sqrt(s / Math.max(1, a.length))
}
function babble(target: number, length: number): Float32Array {
  const rand = random(target + 1)
  const out = new Float32Array(length)
  for (let k = 0; k < 3; k++) {
    let j: number
    do j = Math.floor(rand() * items.length)
    while (items[j]!.speaker === items[target]!.speaker)
    for (let i = 0; i < length; i++) out[i] = out[i]! + audio[j]![i % audio[j]!.length]!
  }
  return out
}
function withTalk(speech: Float32Array, i: number): Float32Array {
  const noise = babble(i, speech.length)
  const gain = rms(speech) / (rms(noise) * 10 ** (15 / 20) || 1)
  return Float32Array.from(speech, (v, k) => Math.max(-1, Math.min(1, v + noise[k]! * gain)))
}
/** A realistic conversational phrase: a random 1.5–6 s piece of the utterance. */
function shortPiece(speech: Float32Array, i: number): Float32Array {
  const rand = random(1000 + i)
  const length = Math.min(speech.length, Math.round((1.5 + rand() * 4.5) * SAMPLE_RATE))
  const start = Math.floor(rand() * (speech.length - length + 1))
  return speech.subarray(start, start + length)
}

const CONDITIONS: { name: string; audio: (i: number) => Float32Array }[] = [
  { name: 'whole phrases (4–10 s)', audio: (i) => audio[i]!.subarray(0, 10 * SAMPLE_RATE) },
  { name: 'short phrases (1.5–6 s)', audio: (i) => shortPiece(audio[i]!, i) },
  { name: 'short + background talk 15 dB', audio: (i) => withTalk(shortPiece(audio[i]!, i), i) },
]

// ---------------------------------------------------------------- voiceprints (cached)

const model = MODELS.find((m) => m.name.toLowerCase().includes(modelName.toLowerCase()))
if (!model) throw new Error(`No model matching "${modelName}"`)
const voiceprints = await VoiceprintModel.load(path.resolve('models', model.file), 4)

async function embedded(condition: (typeof CONDITIONS)[number]) {
  const cacheFile = path.resolve('data', 'cache', `${model!.file}-${condition.name.replace(/[^a-z0-9]+/gi, '_')}.json`)
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { v: number[]; seconds: number }[]
    return cached.map((c) => ({ vector: Float32Array.from(c.v), seconds: c.seconds }))
  }
  process.stdout.write(`computing voiceprints: ${condition.name} … `)
  const out: { vector: Float32Array; seconds: number }[] = []
  for (let i = 0; i < items.length; i++) {
    const a = condition.audio(i)
    out.push({ vector: await voiceprints.embed(a), seconds: a.length / SAMPLE_RATE })
  }
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
  fs.writeFileSync(cacheFile, JSON.stringify(out.map((o) => ({ v: Array.from(o.vector), seconds: o.seconds }))))
  console.log('done')
  return out
}

const cosine = (a: Float32Array, b: Float32Array) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

// ---------------------------------------------------------------- the grouping rule

interface Settings {
  join: number
  addMargin: number
  score: 'max' | 'top3'
}

function groupScore(library: Float32Array[], v: Float32Array, how: Settings['score']): number {
  const sims = library.map((l) => cosine(l, v)).sort((a, b) => b - a)
  return how === 'max' ? sims[0]! : sims.slice(0, 3).reduce((s, x) => s + x, 0) / Math.min(3, sims.length)
}

function run(prints: { vector: Float32Array; seconds: number }[], settings: Settings, seed: number) {
  const speakers = [...new Set(items.map((i) => i.speaker))]
  const owner = speakers[seed % speakers.length]!
  const ownerIdx = items.flatMap((it, i) => (it.speaker === owner ? [i] : []))
  // Enrollment uses clean whole clips, like the voice-training screen.
  const ownerLibrary = ownerIdx.slice(0, OWNER_ENROLL_CLIPS).map((i) => wholePrints[i]!.vector)
  const rand = random(seed * 7919)
  const order = items.map((_, i) => i).filter((i) => !ownerIdx.slice(0, OWNER_ENROLL_CLIPS).includes(i))
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }

  const groups: { library: Float32Array[]; members: string[] }[] = []
  let ownerMissed = 0
  let ownerTotal = 0
  let falseOwner = 0
  let othersTotal = 0
  let uncertain = 0
  for (const i of order) {
    const { vector, seconds } = prints[i]!
    const truth = items[i]!.speaker
    const isOwner = Math.max(...ownerLibrary.map((l) => cosine(l, vector))) >= OWNER_THRESHOLD
    if (truth === owner) {
      ownerTotal++
      if (!isOwner) ownerMissed++
    } else {
      othersTotal++
      if (isOwner) falseOwner++
    }
    if (isOwner) continue
    if (seconds < MIN_GROUP_SECONDS) {
      uncertain++
      continue
    }
    let best = -1
    let bestScore = -Infinity
    groups.forEach((g, k) => {
      const s = groupScore(g.library, vector, settings.score)
      if (s > bestScore) [bestScore, best] = [s, k]
    })
    if (best >= 0 && bestScore >= settings.join) {
      const g = groups[best]!
      g.members.push(truth)
      if (seconds >= MIN_LIBRARY_SECONDS && bestScore >= settings.join + settings.addMargin && g.library.length < LIBRARY_CAP) {
        g.library.push(vector)
      }
    } else {
      groups.push({ library: [vector], members: [truth] })
    }
  }

  // Metrics over grouped phrases from people other than the owner.
  const groupsPerSpeaker = new Map<string, Set<number>>()
  let mixed = 0
  let grouped = 0
  let impure = 0
  groups.forEach((g, k) => {
    const counts = new Map<string, number>()
    for (const m of g.members) counts.set(m, (counts.get(m) ?? 0) + 1)
    const majority = [...counts].sort((a, b) => b[1] - a[1])[0]![0]
    for (const m of g.members) {
      if (m === owner) continue // owner phrases that slipped through: counted as "owner missed"
      grouped++
      if (m !== majority) mixed++
      if (!groupsPerSpeaker.has(m)) groupsPerSpeaker.set(m, new Set())
      groupsPerSpeaker.get(m)!.add(k)
    }
    if ([...counts.values()].filter((c) => c >= 2).length >= 2) impure++
  })
  const fragmentation = [...groupsPerSpeaker.values()].reduce((s, g) => s + g.size, 0) / Math.max(1, groupsPerSpeaker.size)
  return {
    groupsPerSpeaker: fragmentation,
    mixed: mixed / Math.max(1, grouped),
    impureGroups: impure,
    groups: groups.length,
    ownerMissed: ownerMissed / Math.max(1, ownerTotal),
    falseOwner: falseOwner / Math.max(1, othersTotal),
    uncertain: uncertain / Math.max(1, othersTotal),
  }
}

// ---------------------------------------------------------------- sweep

const wholePrints = await embedded(CONDITIONS[0]!)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6)
console.log(`\nModel: ${model.name}. ${new Set(items.map((i) => i.speaker)).size} speakers (one is the owner), ${items.length} phrases, ${seeds} shuffled orders each.`)

const summary: Record<string, unknown>[] = []
for (const condition of CONDITIONS) {
  const prints = condition === CONDITIONS[0] ? wholePrints : await embedded(condition)
  console.log(`\n${condition.name}`)
  console.log('  score  join  add+  groups/speaker  mixed  impure groups  groups  owner missed  false owner  uncertain')
  for (const score of ['max', 'top3'] as const) {
    for (const join of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55]) {
      for (const addMargin of [0, 0.1]) {
        const runs = Array.from({ length: seeds }, (_, s) => run(prints, { join, addMargin, score }, s + 1))
        const avg = (k: keyof (typeof runs)[number]) => runs.reduce((s, r) => s + r[k], 0) / runs.length
        const row = {
          condition: condition.name,
          score,
          join,
          addMargin,
          groupsPerSpeaker: avg('groupsPerSpeaker'),
          mixed: avg('mixed'),
          impureGroups: avg('impureGroups'),
          groups: avg('groups'),
          ownerMissed: avg('ownerMissed'),
          falseOwner: avg('falseOwner'),
          uncertain: avg('uncertain'),
        }
        summary.push(row)
        console.log(
          `  ${score.padEnd(5)}  ${join.toFixed(2)}  ${addMargin.toFixed(2)}  ${row.groupsPerSpeaker.toFixed(2).padStart(14)}  ${pct(row.mixed)}  ${row.impureGroups.toFixed(1).padStart(13)}  ${row.groups.toFixed(0).padStart(6)}  ${pct(row.ownerMissed).padStart(12)}  ${pct(row.falseOwner).padStart(11)}  ${pct(row.uncertain).padStart(9)}`,
        )
      }
    }
  }
}
fs.writeFileSync('results-grouping.json', JSON.stringify({ model: model.name, seeds, rows: summary }, null, 1))
console.log('\nResults → results-grouping.json')
