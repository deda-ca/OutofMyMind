// Audio features for speaker-embedding models.
//
//   kaldiFbank  — 3D-Speaker and WeSpeaker models: shared with apps/server
//   nemoMel     — NVIDIA NeMo TitaNet (NeMo's AudioToMelSpectrogramPreprocessor), evaluation only

import { HOP, NFFT, NMEL, SAMPLE_RATE, WIN, powerSpectrum, type Features } from '../../../apps/server/src/speaker/features.ts'

export { kaldiFbank, type Features } from '../../../apps/server/src/speaker/features.ts'

// ------------------------------------------------------------------ NeMo

/** Slaney mel scale (librosa default, htk=False). */
function slaneyMel(hz: number): number {
  const fSp = 200 / 3
  const minLogHz = 1000
  const minLogMel = minLogHz / fSp
  const logStep = Math.log(6.4) / 27
  return hz < minLogHz ? hz / fSp : minLogMel + Math.log(hz / minLogHz) / logStep
}
function slaneyHz(mel: number): number {
  const fSp = 200 / 3
  const minLogHz = 1000
  const minLogMel = minLogHz / fSp
  const logStep = Math.log(6.4) / 27
  return mel < minLogMel ? mel * fSp : minLogHz * Math.exp(logStep * (mel - minLogMel))
}

/** librosa.filters.mel(sr=16000, n_fft=512, n_mels=80, fmin=0, fmax=8000), Slaney-normalised. */
const NEMO_BANKS: Float64Array[] = (() => {
  const melPoints = Array.from({ length: NMEL + 2 }, (_, i) =>
    slaneyHz(slaneyMel(0) + ((slaneyMel(SAMPLE_RATE / 2) - slaneyMel(0)) * i) / (NMEL + 1)),
  )
  const fftFreqs = Array.from({ length: NFFT / 2 + 1 }, (_, k) => (k * SAMPLE_RATE) / NFFT)
  return Array.from({ length: NMEL }, (_, m) => {
    const [left, center, right] = [melPoints[m]!, melPoints[m + 1]!, melPoints[m + 2]!]
    const norm = 2 / (right - left)
    return Float64Array.from(fftFreqs, (f) => Math.max(0, Math.min((f - left) / (center - left), (right - f) / (right - center))) * norm)
  })
})()

/** Symmetric Hann window (torch.hann_window(400, periodic=False)), centred in the 512-point frame. */
const NEMO_WINDOW = (() => {
  const w = new Float64Array(NFFT)
  const offset = (NFFT - WIN) >> 1
  for (let i = 0; i < WIN; i++) w[offset + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1))
  return w
})()

/**
 * NeMo AudioToMelSpectrogramPreprocessor as configured for TitaNet:
 * pre-emphasis 0.97, centred STFT (zero padding), Hann window, power
 * spectrum, Slaney mel, log(x + 2^-24), per-feature normalisation. No dither.
 */
export function nemoMel(samples: Float32Array): Features {
  const x = new Float64Array(samples.length)
  x[0] = samples[0] ?? 0
  for (let i = 1; i < samples.length; i++) x[i] = samples[i]! - 0.97 * samples[i - 1]!

  const pad = NFFT >> 1
  const frames = 1 + Math.floor(samples.length / HOP)
  const data = new Float32Array(NMEL * frames)
  const frame = new Float64Array(NFFT)
  for (let t = 0; t < frames; t++) {
    const start = t * HOP - pad
    for (let i = 0; i < NFFT; i++) {
      const j = start + i
      frame[i] = (j >= 0 && j < x.length ? x[j]! : 0) * NEMO_WINDOW[i]!
    }
    const power = powerSpectrum(frame)
    for (let m = 0; m < NMEL; m++) {
      const bank = NEMO_BANKS[m]!
      let energy = 0
      for (let k = 0; k < bank.length; k++) energy += bank[k]! * power[k]!
      data[m * frames + t] = Math.log(energy + 2 ** -24)
    }
  }
  // Per-feature normalisation: zero mean, unit (sample) standard deviation per band.
  for (let m = 0; m < NMEL; m++) {
    const row = data.subarray(m * frames, (m + 1) * frames)
    let mean = 0
    for (const v of row) mean += v
    mean /= frames
    let variance = 0
    for (const v of row) variance += (v - mean) ** 2
    const std = Math.sqrt(variance / Math.max(1, frames - 1)) + 1e-5
    for (let t = 0; t < frames; t++) row[t] = (row[t]! - mean) / std
  }
  return { data, frames }
}
