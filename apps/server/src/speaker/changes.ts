// Finds where the speaker changes inside a phrase, so back-and-forth talk
// with no pause can be split into one phrase per speaker
// (docs/speaker-recognition.md, M4). Tuned with tools/speaker-eval/src/change-eval.ts.
//
// 1. Scan: at candidate points every `hopS`, compare a voiceprint of the
//    `windowS` seconds before the point with the `windowS` seconds after it.
// 2. Change candidates: local minima of that similarity below `threshold`,
//    at least `minSegmentS` apart and from the ends.
// 3. Clean-up: compute a voiceprint per resulting segment and re-join
//    neighbours that still sound like the same person (similarity ≥ `mergeThreshold`).
// 4. Snap each cut to the quietest 20 ms within ±`snapS`, so words aren't cut.
// 5. Fold pieces shorter than `minPieceS` into the neighbour they sound more like.
//
// Pure logic around an `embed` function, so the server and the evaluation
// tool run exactly the same code.

export interface ChangeOptions {
  sampleRate: number
  /** Length of the voiceprint windows compared either side of a point. */
  windowS: number
  /** Distance between candidate points. */
  hopS: number
  /** Similarity below which a point may be a change. */
  threshold: number
  /** No segment shorter than this. */
  minSegmentS: number
  /** Neighbouring segments at or above this similarity are re-joined; null = no clean-up. */
  mergeThreshold: number | null
  /** Segments shorter than this are folded into the neighbour they sound more like. */
  minPieceS: number
  /** How far a cut may move to land on a quiet moment. */
  snapS: number
}

/**
 * Tuned on 60 back-to-back LibriSpeech conversations (docs/speaker-model-eval.md):
 * 97% of speech time attributed to the right person (52% without splitting),
 * 89% of speaker changes found, no false splits in 30 single-speaker phrases.
 */
export const DEFAULT_CHANGE_OPTIONS: ChangeOptions = {
  sampleRate: 16000,
  windowS: 1.5,
  hopS: 0.25,
  threshold: 0.3,
  minSegmentS: 1,
  mergeThreshold: 0.4,
  minPieceS: 1.5,
  snapS: 0.25,
}

/** L2-normalised voiceprint of audio in [-1, 1]. */
export type Embed = (samples: Float32Array) => Promise<Float32Array>

export interface ScanPoint {
  /** Sample offset of the candidate point. */
  at: number
  /** Similarity of the voice just before vs just after. */
  similarity: number
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

/** Similarity before vs after each candidate point. Windows are reused between points. */
export async function scan(samples: Float32Array, embed: Embed, o: ChangeOptions): Promise<ScanPoint[]> {
  const win = Math.round(o.windowS * o.sampleRate)
  const hop = Math.round(o.hopS * o.sampleRate)
  if (samples.length < 2 * win) return []
  const cache = new Map<number, Float32Array>()
  const windowAt = async (start: number) => {
    let v = cache.get(start)
    if (!v) cache.set(start, (v = await embed(samples.subarray(start, start + win))))
    return v
  }
  const points: ScanPoint[] = []
  for (let at = win; at + win <= samples.length; at += hop) {
    points.push({ at, similarity: cosine(await windowAt(at - win), await windowAt(at)) })
  }
  return points
}

/** Change candidates: local minima below the threshold, keeping segments ≥ minSegmentS. */
export function pickChanges(points: ScanPoint[], length: number, o: ChangeOptions): number[] {
  const minGap = Math.round(o.minSegmentS * o.sampleRate)
  const candidates = points
    .filter((p, i) => p.similarity < o.threshold && p.similarity <= (points[i - 1]?.similarity ?? 1) && p.similarity <= (points[i + 1]?.similarity ?? 1))
    .sort((a, b) => a.similarity - b.similarity) // strongest changes first
  const chosen: number[] = []
  for (const c of candidates) {
    if (c.at < minGap || length - c.at < minGap) continue
    if (chosen.some((x) => Math.abs(x - c.at) < minGap)) continue
    chosen.push(c.at)
  }
  return chosen.sort((a, b) => a - b)
}

/** Re-joins neighbouring segments that still sound like the same person. */
export async function mergeSimilar(samples: Float32Array, cuts: number[], embed: Embed, o: ChangeOptions): Promise<number[]> {
  if (o.mergeThreshold === null || cuts.length === 0) return cuts
  let current = [...cuts]
  for (;;) {
    const bounds = [0, ...current, samples.length]
    const prints: Float32Array[] = []
    for (let i = 0; i + 1 < bounds.length; i++) prints.push(await embed(samples.subarray(bounds[i]!, bounds[i + 1]!)))
    // Join the most similar neighbouring pair, if it's similar enough; repeat.
    let best = -1
    let bestSim = o.mergeThreshold
    for (let i = 0; i + 1 < prints.length; i++) {
      const sim = cosine(prints[i]!, prints[i + 1]!)
      if (sim >= bestSim) [best, bestSim] = [i, sim]
    }
    if (best < 0) return current
    current = current.filter((_, i) => i !== best)
    if (current.length === 0) return current
  }
}

/**
 * Folds pieces shorter than minPieceS into the neighbour they sound more like.
 * A short piece at a boundary is usually a blend of two voices, which would
 * otherwise match nobody well.
 */
export async function absorbShort(samples: Float32Array, cuts: number[], embed: Embed, o: ChangeOptions): Promise<number[]> {
  const minPiece = Math.round(o.minPieceS * o.sampleRate)
  let current = [...cuts]
  for (;;) {
    const bounds = [0, ...current, samples.length]
    const lengths = bounds.slice(1).map((b, i) => b - bounds[i]!)
    const shortest = lengths.indexOf(Math.min(...lengths))
    if (current.length === 0 || lengths[shortest]! >= minPiece) return current
    const piece = await embed(samples.subarray(bounds[shortest]!, bounds[shortest + 1]!))
    const before = shortest > 0 ? cosine(piece, await embed(samples.subarray(bounds[shortest - 1]!, bounds[shortest]!))) : -Infinity
    const after = shortest < lengths.length - 1 ? cosine(piece, await embed(samples.subarray(bounds[shortest + 1]!, bounds[shortest + 2]!))) : -Infinity
    // Remove the cut between the piece and the neighbour it joins.
    current.splice(before >= after ? shortest - 1 : shortest, 1)
  }
}

/** Moves each cut to the quietest 20 ms within ±snapS. */
export function snapToQuiet(samples: Float32Array, cuts: number[], o: ChangeOptions): number[] {
  const frame = Math.round(0.02 * o.sampleRate)
  const reach = Math.round(o.snapS * o.sampleRate)
  return cuts.map((cut) => {
    let best = cut
    let bestEnergy = Infinity
    for (let start = Math.max(0, cut - reach); start + frame <= Math.min(samples.length, cut + reach); start += frame >> 1) {
      let e = 0
      for (let i = start; i < start + frame; i++) e += samples[i]! * samples[i]!
      if (e < bestEnergy) [bestEnergy, best] = [e, start + (frame >> 1)]
    }
    return best
  })
}

/** Sample offsets where the speaker changes (empty = one speaker). */
export async function findSpeakerChanges(samples: Float32Array, embed: Embed, o: ChangeOptions = DEFAULT_CHANGE_OPTIONS): Promise<number[]> {
  const points = await scan(samples, embed, o)
  const cuts = pickChanges(points, samples.length, o)
  const merged = await mergeSimilar(samples, cuts, embed, o)
  const snapped = snapToQuiet(samples, merged, o)
  return absorbShort(samples, snapped, embed, o)
}
