// Compares speaker-embedding models on a labelled dataset (default: the
// LibriSpeech sample from fetch-librispeech.ts).
//
// Usage: node src/eval.ts [dataDir=data/librispeech] [--models=substring,…] [--out=results.json]
//
// For each model and each audio condition it reports:
//   EER          equal error rate over all same-speaker / different-speaker pairs
//   owner@1%     Jarvis's case: each speaker in turn is the "owner", enrolled with
//                3 clean clips; share of the owner's other phrases recognised when
//                at most 1% of everyone else's phrases are let through
//   ident        closed-set identification accuracy (who of N is this?), 3 clips each
//   ms/phrase    time to compute one voiceprint (features + model, single CPU thread)

import fs from 'node:fs'
import path from 'node:path'
import { OggOpusDecoder } from 'ogg-opus-decoder'
import { encodeOggOpus } from '../../../apps/server/src/archive/oggOpus.ts'
import { MODELS } from './models.ts'
import { VoiceprintModel } from './voiceprint.ts'
import { readWav } from './wav.ts'

const args = process.argv.slice(2)
const dataDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'data/librispeech')
const modelFilter = args.find((a) => a.startsWith('--models='))?.slice(9).split(',')
const outFile = args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'results.json'
const conditionFilter = args.find((a) => a.startsWith('--conditions='))?.slice(13).split(',')

const SAMPLE_RATE = 16000
const MAX_SECONDS = 10
const ENROLL_CLIPS = 3

interface Item {
  speaker: string
  id: string
  file: string
}
const items = (JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8')) as Item[]).sort((a, b) =>
  a.speaker === b.speaker ? a.id.localeCompare(b.id) : a.speaker.localeCompare(b.speaker),
)
const speakers = [...new Set(items.map((i) => i.speaker))]

// ---------------------------------------------------------------- audio conditions

const audio = items.map((item) => {
  const { samples, sampleRate } = readWav(path.join(dataDir, item.file))
  if (sampleRate !== SAMPLE_RATE) throw new Error(`${item.file}: expected 16 kHz`)
  return samples.subarray(0, MAX_SECONDS * SAMPLE_RATE)
})

async function opusRoundTrip(samples: Float32Array): Promise<Float32Array> {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767)))
  const decoder = new OggOpusDecoder()
  await decoder.ready
  const decoded = (await decoder.decodeFile(await encodeOggOpus(pcm))).channelData[0]!
  decoder.free()
  // Decoded at 48 kHz; Opus band-limits to 8 kHz at this bitrate, so every 3rd sample is a fair 16 kHz version.
  const out = new Float32Array(Math.floor(decoded.length / 3))
  for (let i = 0; i < out.length; i++) out[i] = decoded[i * 3]!
  return out
}

process.stdout.write('preparing Opus round-trip audio … ')
const opusAudio = await Promise.all(audio.map(opusRoundTrip))
console.log('done')

// ---------------------------------------------------------------- noise

/** Deterministic pseudo-random numbers, so every run mixes the same noise. */
function random(seed: number): () => number {
  let x = seed >>> 0
  return () => ((x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 0xffffffff)
}

function rms(a: Float32Array): number {
  let s = 0
  for (const v of a) s += v * v
  return Math.sqrt(s / Math.max(1, a.length))
}

/** speech + noise scaled so the speech is `snrDb` louder. */
function mix(speech: Float32Array, noise: Float32Array, snrDb: number): Float32Array {
  const gain = rms(speech) / (rms(noise) * 10 ** (snrDb / 20) || 1)
  return Float32Array.from(speech, (v, i) => Math.max(-1, Math.min(1, v + noise[i % noise.length]! * gain)))
}

/** Car-like rumble: brown (integrated white) noise. */
function brownNoise(length: number, seed: number): Float32Array {
  const rand = random(seed)
  const out = new Float32Array(length)
  let b = 0
  for (let i = 0; i < length; i++) out[i] = b = 0.995 * b + (rand() - 0.5)
  return out
}

/** TV / background talk: three other speakers' utterances summed. */
function babble(target: number, length: number): Float32Array {
  const rand = random(target + 1)
  const out = new Float32Array(length)
  for (let k = 0; k < 3; k++) {
    let j: number
    do j = Math.floor(rand() * items.length)
    while (items[j]!.speaker === items[target]!.speaker)
    const other = audio[j]!
    for (let i = 0; i < length; i++) out[i] = out[i]! + other[i % other.length]!
  }
  return out
}

const CONDITIONS: { name: string; audio: (i: number) => Float32Array }[] = [
  { name: 'whole phrase', audio: (i) => audio[i]! },
  { name: 'first 3 s', audio: (i) => audio[i]!.subarray(0, 3 * SAMPLE_RATE) },
  { name: 'first 1.5 s', audio: (i) => audio[i]!.subarray(0, 1.5 * SAMPLE_RATE) },
  { name: 'whole, via Opus', audio: (i) => opusAudio[i]! },
  { name: 'car noise 10 dB', audio: (i) => mix(audio[i]!, brownNoise(audio[i]!.length, i), 10) },
  { name: 'background talk 15 dB', audio: (i) => mix(audio[i]!, babble(i, audio[i]!.length), 15) },
]

// ---------------------------------------------------------------- metrics

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

/** Equal error rate and the threshold where false accepts = false rejects. */
function eer(target: number[], nonTarget: number[]): { eer: number; threshold: number } {
  const t = [...target].sort((a, b) => a - b)
  const n = [...nonTarget].sort((a, b) => a - b)
  let best = { eer: 1, threshold: 0, gap: Infinity }
  // Sweep candidate thresholds over all observed scores.
  const candidates = [...t, ...n].sort((a, b) => a - b)
  let ti = 0
  let ni = 0
  for (const th of candidates) {
    while (ti < t.length && t[ti]! < th) ti++
    while (ni < n.length && n[ni]! < th) ni++
    const frr = ti / t.length // targets rejected
    const far = (n.length - ni) / n.length // non-targets accepted
    const gap = Math.abs(frr - far)
    if (gap < best.gap) best = { eer: (frr + far) / 2, threshold: th, gap }
  }
  return { eer: best.eer, threshold: best.threshold }
}

/** Highest threshold-free operating point: share of targets accepted when at most `maxFar` of non-targets are. */
function tprAtFar(target: number[], nonTarget: number[], maxFar: number): { tpr: number; threshold: number } {
  const n = [...nonTarget].sort((a, b) => b - a)
  const allowed = Math.floor(n.length * maxFar)
  const threshold = (n[allowed] ?? -1) + 1e-9 // strictly above the (allowed+1)-th highest impostor score
  return { tpr: target.filter((s) => s >= threshold).length / target.length, threshold }
}

// ---------------------------------------------------------------- run

interface ConditionResult {
  condition: string
  eer: number
  eerThreshold: number
  ownerTprAt1: number
  ownerThresholdAt1: number
  ownerEer: number
  identification: number
}
interface ModelResult {
  model: string
  file: string
  dim: number
  msPerPhrase: number
  realTimeFactor: number
  conditions: ConditionResult[]
}

const results: ModelResult[] = []
const models = MODELS.filter((m) => !modelFilter || modelFilter.some((f) => m.name.toLowerCase().includes(f.toLowerCase())))

for (const model of models) {
  const voiceprints = await VoiceprintModel.load(path.resolve('models', model.file), 1)
  const embedAll = async (list: Float32Array[]) => {
    const out: Float32Array[] = []
    for (const a of list) out.push(await voiceprints.embed(a))
    return out
  }

  // Clean whole-phrase embeddings: used for enrollment and the speed measurement.
  const started = performance.now()
  const clean = await embedAll(audio)
  const elapsed = performance.now() - started
  const dim = clean[0]!.length
  const audioSeconds = audio.reduce((s, a) => s + a.length / SAMPLE_RATE, 0)

  const conditions: ConditionResult[] = []
  for (const condition of CONDITIONS.filter((c) => !conditionFilter || conditionFilter.some((f) => c.name.includes(f)))) {
    const test = condition.name === 'whole phrase' ? clean : await embedAll(items.map((_, i) => condition.audio(i)))

    // All pairs within the condition.
    const target: number[] = []
    const nonTarget: number[] = []
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        ;(items[i]!.speaker === items[j]!.speaker ? target : nonTarget).push(cosine(test[i]!, test[j]!))
      }
    }
    const pairs = eer(target, nonTarget)

    // Owner scenario and identification: enroll each speaker with their first 3 clean clips,
    // score test phrases (the condition) by the best match among a speaker's clips.
    const enrolled = new Map(
      speakers.map((s) => [s, items.flatMap((it, i) => (it.speaker === s ? [i] : [])).slice(0, ENROLL_CLIPS)]),
    )
    const enrolledSet = new Set([...enrolled.values()].flat())
    const score = (speaker: string, i: number) => Math.max(...enrolled.get(speaker)!.map((e) => cosine(clean[e]!, test[i]!)))

    const ownerTarget: number[] = []
    const ownerNonTarget: number[] = []
    let correct = 0
    let tested = 0
    for (let i = 0; i < items.length; i++) {
      if (enrolledSet.has(i)) continue
      let bestSpeaker = ''
      let bestScore = -Infinity
      for (const s of speakers) {
        const sc = score(s, i)
        ;(s === items[i]!.speaker ? ownerTarget : ownerNonTarget).push(sc)
        if (sc > bestScore) [bestScore, bestSpeaker] = [sc, s]
      }
      tested++
      if (bestSpeaker === items[i]!.speaker) correct++
    }
    const owner = tprAtFar(ownerTarget, ownerNonTarget, 0.01)

    conditions.push({
      condition: condition.name,
      eer: pairs.eer,
      eerThreshold: pairs.threshold,
      ownerTprAt1: owner.tpr,
      ownerThresholdAt1: owner.threshold,
      ownerEer: eer(ownerTarget, ownerNonTarget).eer,
      identification: correct / tested,
    })
  }

  results.push({
    model: model.name,
    file: model.file,
    dim,
    msPerPhrase: elapsed / audio.length,
    realTimeFactor: elapsed / 1000 / audioSeconds,
    conditions,
  })

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6)
  console.log(`\n${model.name}  (dim ${dim}, ${(elapsed / audio.length).toFixed(0)} ms/phrase, RTF ${(elapsed / 1000 / audioSeconds).toFixed(3)})`)
  console.log('  condition          EER    owner@1%FA  owner EER  ident   thr(EER)  thr(owner@1%)')
  for (const c of conditions) {
    console.log(
      `  ${c.condition.padEnd(16)} ${pct(c.eer)}    ${pct(c.ownerTprAt1)}     ${pct(c.ownerEer)}  ${pct(c.identification)}   ${c.eerThreshold.toFixed(3)}     ${c.ownerThresholdAt1.toFixed(3)}`,
    )
  }
}

fs.writeFileSync(
  outFile,
  JSON.stringify({ dataset: dataDir, speakers: speakers.length, utterances: items.length, enrollClips: ENROLL_CLIPS, results }, null, 1),
)
console.log(`\n${speakers.length} speakers, ${items.length} utterances. Results → ${outFile}`)
