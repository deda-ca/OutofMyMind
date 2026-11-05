// Voiceprints (speaker embeddings) with ONNX Runtime and our own Kaldi features.
//
// Model: 3D-Speaker CAM++ (512-dim). Why this model and why not sherpa-onnx:
// docs/speaker-model-eval.md.

import fs from 'node:fs'
import path from 'node:path'
import ort from 'onnxruntime-node'
import { NMEL, SAMPLE_RATE, kaldiFbank } from './features.ts'

/** Shorter than this, the model has too little to go on. */
export const MIN_VOICEPRINT_SECONDS = 0.5

export class VoiceprintModel {
  readonly name: string
  private readonly session: ort.InferenceSession
  private readonly input: string
  private readonly output: string

  private constructor(name: string, session: ort.InferenceSession) {
    this.name = name
    this.session = session
    if (session.inputNames.length !== 1) throw new Error(`Expected one model input, got ${session.inputNames.join(', ')}`)
    this.input = session.inputNames[0]!
    this.output = session.outputNames.find((n) => n === 'embedding' || n === 'embs') ?? session.outputNames[0]!
  }

  /** Returns null (and logs why) if the model file isn't there: speaker recognition is then off. */
  static async load(file: string, log: (message: string) => void): Promise<VoiceprintModel | null> {
    if (!fs.existsSync(file)) {
      log(`speaker recognition off: model not found at ${file} (run: npm run fetch-models)`)
      return null
    }
    const session = await ort.InferenceSession.create(file, { intraOpNumThreads: 2, interOpNumThreads: 1 })
    return new VoiceprintModel(path.basename(file, '.onnx'), session)
  }

  /** L2-normalised voiceprint of 16 kHz mono s16le audio, or null if too short. */
  async embed(pcm: Int16Array): Promise<Float32Array | null> {
    if (pcm.length < MIN_VOICEPRINT_SECONDS * SAMPLE_RATE) return null
    const samples = Float32Array.from(pcm, (v) => v / 32768)
    const f = kaldiFbank(samples)
    const result = await this.session.run({ [this.input]: new ort.Tensor('float32', f.data, [1, f.frames, NMEL]) }, [this.output])
    const v = result[this.output]!.data as Float32Array
    let norm = 0
    for (const x of v) norm += x * x
    norm = Math.sqrt(norm) || 1
    return Float32Array.from(v, (x) => x / norm)
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
}

export function fromBlob(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob) // align
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4)
}
