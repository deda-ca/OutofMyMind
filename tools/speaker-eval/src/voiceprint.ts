// Runs a speaker-embedding ONNX model with ONNX Runtime and our own features.
// The model's input names tell us which feature recipe it was trained with.

import ort from 'onnxruntime-node'
import { kaldiFbank, nemoMel } from './features.ts'

export class VoiceprintModel {
  private readonly session: ort.InferenceSession
  private readonly kind: 'kaldi' | 'nemo'
  private readonly input: string
  private readonly output: string

  private constructor(session: ort.InferenceSession) {
    this.session = session
    const names = session.inputNames
    if (names.includes('audio_signal')) {
      this.kind = 'nemo'
      this.input = 'audio_signal'
    } else if (names.length === 1) {
      this.kind = 'kaldi'
      this.input = names[0]!
    } else {
      throw new Error(`Unrecognised model inputs: ${names.join(', ')}`)
    }
    this.output = session.outputNames.includes('embs') ? 'embs' : session.outputNames.includes('embedding') ? 'embedding' : session.outputNames[0]!
  }

  static async load(file: string, threads = 1): Promise<VoiceprintModel> {
    return new VoiceprintModel(await ort.InferenceSession.create(file, { intraOpNumThreads: threads, interOpNumThreads: 1 }))
  }

  /** L2-normalised voiceprint of 16 kHz mono audio in [-1, 1]. */
  async embed(samples: Float32Array): Promise<Float32Array> {
    let feeds: Record<string, ort.Tensor>
    if (this.kind === 'kaldi') {
      const f = kaldiFbank(samples)
      if (f.frames < 10) throw new Error('Audio too short for a voiceprint')
      feeds = { [this.input]: new ort.Tensor('float32', f.data, [1, f.frames, 80]) }
    } else {
      const f = nemoMel(samples)
      feeds = {
        audio_signal: new ort.Tensor('float32', f.data, [1, 80, f.frames]),
        length: new ort.Tensor('int64', BigInt64Array.from([BigInt(f.frames)]), [1]),
      }
    }
    const result = await this.session.run(feeds, [this.output])
    const v = result[this.output]!.data as Float32Array
    let norm = 0
    for (const x of v) norm += x * x
    norm = Math.sqrt(norm) || 1
    return Float32Array.from(v, (x) => x / norm)
  }
}
