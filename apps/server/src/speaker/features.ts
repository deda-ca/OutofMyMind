// Audio features for speaker-embedding (voiceprint) models, in plain TypeScript.
//
// kaldiFbank: Kaldi-compatible log-mel filterbank, as 3D-Speaker and WeSpeaker
// models were trained with. 16 kHz input in [-1, 1], 25 ms windows every 10 ms,
// 80 mel bands. Verified in tools/speaker-eval (0.1% EER with CAM++ on
// LibriSpeech test-clean).

export const SAMPLE_RATE = 16000
export const WIN = 400 // 25 ms
export const HOP = 160 // 10 ms
export const NFFT = 512
export const NMEL = 80

export interface Features {
  /** Row-major. Kaldi: [frames][80]. NeMo: [80][frames]. */
  data: Float32Array
  frames: number
}

// ------------------------------------------------------------------ shared

/** In-place iterative radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(angle * k)
        const wi = Math.sin(angle * k)
        const a = i + k
        const b = a + half
        const xr = re[b]! * wr - im[b]! * wi
        const xi = re[b]! * wi + im[b]! * wr
        re[b] = re[a]! - xr
        im[b] = im[a]! - xi
        re[a] = re[a]! + xr
        im[a] = im[a]! + xi
      }
    }
  }
}

export function powerSpectrum(frame: Float64Array): Float64Array {
  const re = new Float64Array(NFFT)
  const im = new Float64Array(NFFT)
  re.set(frame)
  fft(re, im)
  const power = new Float64Array(NFFT / 2 + 1)
  for (let k = 0; k <= NFFT / 2; k++) power[k] = re[k]! * re[k]! + im[k]! * im[k]!
  return power
}

// ------------------------------------------------------------------ Kaldi

const kaldiMel = (hz: number) => 1127 * Math.log(1 + hz / 700)

/** Kaldi mel banks: triangles in mel space, 20 Hz to Nyquist, unnormalised. */
const KALDI_BANKS: Float64Array[] = (() => {
  const lo = kaldiMel(20)
  const hi = kaldiMel(SAMPLE_RATE / 2)
  const delta = (hi - lo) / (NMEL + 1)
  return Array.from({ length: NMEL }, (_, m) => {
    const left = lo + m * delta
    const center = left + delta
    const right = center + delta
    return Float64Array.from({ length: NFFT / 2 + 1 }, (_, k) => {
      const mk = kaldiMel((k * SAMPLE_RATE) / NFFT)
      if (mk <= left || mk >= right) return 0
      return mk <= center ? (mk - left) / (center - left) : (right - mk) / (right - center)
    })
  })
})()

const POVEY = Float64Array.from({ length: WIN }, (_, i) => Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1)), 0.85))

/**
 * Kaldi-compatible fbank (torchaudio.compliance.kaldi.fbank defaults: povey
 * window, DC removal, pre-emphasis 0.97, snip edges, no dither), followed by
 * per-utterance mean normalisation, as 3D-Speaker and WeSpeaker do.
 */
export function kaldiFbank(samples: Float32Array): Features {
  const frames = samples.length < WIN ? 0 : 1 + Math.floor((samples.length - WIN) / HOP)
  const data = new Float32Array(frames * NMEL)
  const frame = new Float64Array(WIN)
  for (let t = 0; t < frames; t++) {
    let mean = 0
    for (let i = 0; i < WIN; i++) {
      frame[i] = samples[t * HOP + i]! * 32768 // Kaldi works on the 16-bit scale
      mean += frame[i]!
    }
    mean /= WIN
    for (let i = 0; i < WIN; i++) frame[i] = frame[i]! - mean
    for (let i = WIN - 1; i > 0; i--) frame[i] = frame[i]! - 0.97 * frame[i - 1]!
    frame[0] = frame[0]! * (1 - 0.97)
    for (let i = 0; i < WIN; i++) frame[i] = frame[i]! * POVEY[i]!
    const power = powerSpectrum(frame)
    for (let m = 0; m < NMEL; m++) {
      const bank = KALDI_BANKS[m]!
      let energy = 0
      for (let k = 0; k < bank.length; k++) energy += bank[k]! * power[k]!
      data[t * NMEL + m] = Math.log(Math.max(energy, 1.1920929e-7))
    }
  }
  // Cepstral mean normalisation over the utterance.
  for (let m = 0; m < NMEL; m++) {
    let sum = 0
    for (let t = 0; t < frames; t++) sum += data[t * NMEL + m]!
    const mean = sum / Math.max(1, frames)
    for (let t = 0; t < frames; t++) data[t * NMEL + m] = data[t * NMEL + m]! - mean
  }
  return { data, frames }
}
