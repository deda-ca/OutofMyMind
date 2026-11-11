// Marvin's voice as a leg of a call (docs/phone.md, phase 2): text-to-speech
// into the bridge, and what the others say heard live, cut into utterances
// (by loudness) and transcribed. Half duplex: while Marvin talks, it doesn't
// listen, so it never answers itself or a phone's echo.

import { transcribePcm } from '../audiocpp.ts'
import { synthesize } from '../assistant/speech.ts'
import type { Leg } from './bridge.ts'
import { FRAME_SAMPLES } from './rtp.ts'
import { PHONE_SAMPLE_RATE } from './transcript.ts'

const FRAME_MS = 20

/** s16le mono WAV (any sample rate) → 16 kHz samples. */
export function wavToPcm16k(wav: Buffer): Int16Array {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file')
  let rate = 16000
  let channels = 1
  let bits = 16
  let at = 12
  let data: Buffer | null = null
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4)
    const size = wav.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(body + 2)
      rate = wav.readUInt32LE(body + 4)
      bits = wav.readUInt16LE(body + 14)
    } else if (id === 'data') {
      data = wav.subarray(body, Math.min(wav.length, body + size))
      break
    }
    at = body + size + (size % 2)
  }
  if (!data || bits !== 16) throw new Error('expected 16-bit PCM WAV')
  const frames = Math.floor(data.length / (2 * channels))
  const src = new Float32Array(frames)
  for (let i = 0; i < frames; i++) src[i] = data.readInt16LE(i * 2 * channels)
  if (rate === PHONE_SAMPLE_RATE) return Int16Array.from(src, (v) => Math.round(v))
  // Downsampling: a short low-pass first (the phone keeps 4 kHz anyway), then linear.
  const smooth = rate > PHONE_SAMPLE_RATE ? src.map((v, i) => 0.25 * (src[i - 1] ?? v) + 0.5 * v + 0.25 * (src[i + 1] ?? v)) : src
  const n = Math.floor((frames * PHONE_SAMPLE_RATE) / rate)
  const out = new Int16Array(n)
  const step = rate / PHONE_SAMPLE_RATE
  for (let i = 0; i < n; i++) {
    const pos = i * step
    const k = Math.floor(pos)
    const a = smooth[k] ?? 0
    const b = smooth[k + 1] ?? a
    out[i] = Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * (pos - k))))
  }
  return out
}

/** A tone (the beep before a message), 16 kHz. */
export function tone(freq: number, ms: number, level = 6000): Int16Array {
  const n = Math.round((PHONE_SAMPLE_RATE * ms) / 1000)
  return Int16Array.from({ length: n }, (_, i) => Math.round(level * Math.sin((2 * Math.PI * freq * i) / PHONE_SAMPLE_RATE) * Math.min(1, i / 80, (n - i) / 80)))
}

function rms(frame: Int16Array): number {
  let sum = 0
  for (const s of frame) sum += s * s
  return Math.sqrt(sum / frame.length)
}

export interface Endpointing {
  /** Silence that ends an utterance (ms). */
  endSilenceMs: number
  /** Longest utterance (ms); cut there. */
  maxMs: number
}

const DEFAULT_ENDPOINTING: Endpointing = { endSilenceMs: 800, maxMs: 15_000 }

/**
 * Finds utterances in a stream of 20 ms frames by loudness, against a noise
 * floor it keeps learning: speech starts after two loud frames (with a little
 * of what came before), and ends after `endSilenceMs` of quiet or at `maxMs`.
 */
export class Endpointer {
  ep: Endpointing
  private floor = 200
  private loud = 0
  private quiet = 0
  private preroll: Int16Array[] = []
  private speech: Int16Array[] | null = null

  constructor(ep: Partial<Endpointing> = {}) {
    this.ep = { ...DEFAULT_ENDPOINTING, ...ep }
  }

  /** Someone is talking (an utterance has started and not ended). */
  get inSpeech(): boolean {
    return this.speech !== null
  }

  /** Adds a frame; returns the utterance it ended, if any. */
  push(frame: Int16Array): Int16Array | null {
    const level = rms(frame)
    const threshold = Math.max(350, this.floor * 3)
    if (!this.speech) {
      this.preroll.push(frame)
      if (this.preroll.length > 10) this.preroll.shift()
      if (level > threshold) {
        if (++this.loud >= 2) {
          this.speech = [...this.preroll]
          this.preroll = []
          this.quiet = 0
        }
      } else {
        this.loud = 0
        this.floor = this.floor * 0.98 + Math.min(level, 2000) * 0.02
      }
      return null
    }
    this.speech.push(frame)
    this.quiet = level > threshold ? 0 : this.quiet + 1
    if (this.quiet * FRAME_MS >= this.ep.endSilenceMs || this.speech.length * FRAME_MS >= this.ep.maxMs) return this.flush()
    return null
  }

  /** Ends the utterance in progress (if any) and returns it. */
  flush(): Int16Array | null {
    const frames = this.speech
    this.speech = null
    this.loud = 0
    this.quiet = 0
    if (!frames) return null
    const pcm = new Int16Array(frames.length * FRAME_SAMPLES)
    frames.forEach((f, i) => pcm.set(f, i * FRAME_SAMPLES))
    return pcm
  }

  /** Forgets what was being heard (Marvin started talking). */
  reset(): void {
    this.speech = null
    this.preroll = []
    this.loud = 0
    this.quiet = 0
  }
}

export interface VoiceDeps {
  name: string
  /** Text → WAV (audio.cpp); overridable in tests. */
  synthesize?: (text: string) => Promise<Buffer>
  /** 16 kHz → text (audio.cpp); overridable in tests. */
  transcribe?: (pcm: Int16Array) => Promise<string>
  voice?: string
  /** Called with each thing Marvin says, as it starts saying it (for the live transcript). */
  onSay?: (text: string) => void
}

export class CallEnded extends Error {
  constructor() {
    super('the call ended')
  }
}

/** Marvin on a call: says things, and hears what the others say. */
export class VoiceLeg implements Leg {
  readonly name: string
  private readonly d: VoiceDeps
  private out: Int16Array[] = []
  private speakingDone: (() => void) | null = null
  private closed = false

  // Listening: the utterance being heard, and who's waiting for the next one.
  private readonly ears = new Endpointer()
  private waiting: ((pcm: Int16Array | null) => void) | null = null
  /** Not listening until then (ms): the echo of what Marvin just said. */
  private deafUntil = 0

  constructor(deps: VoiceDeps) {
    this.name = deps.name
    this.d = deps
  }

  get speaking(): boolean {
    return this.out.length > 0
  }

  read(): Int16Array | null {
    const frame = this.out.shift() ?? null
    if (frame && !this.out.length) this.deafUntil = Date.now() + 250
    if (!this.out.length && this.speakingDone) {
      const done = this.speakingDone
      this.speakingDone = null
      // After this last frame has gone out.
      queueMicrotask(done)
    }
    return frame
  }

  write(frame: Int16Array): void {
    // Half duplex: not while talking, and not for a moment after (the line's delay, the far end's echo).
    if (this.speaking || Date.now() < this.deafUntil) return
    const pcm = this.ears.push(frame)
    if (!pcm) return
    const w = this.waiting
    this.waiting = null
    w?.(pcm)
  }

  /** Says `text` into the call; resolves when it has been played. */
  async say(text: string): Promise<void> {
    if (this.closed) throw new CallEnded()
    const wav = await (this.d.synthesize ?? ((t: string) => synthesize(t, undefined, this.d.voice)))(text)
    if (this.closed) throw new CallEnded()
    this.d.onSay?.(text)
    await this.play(wavToPcm16k(wav))
  }

  /** Plays 16 kHz samples into the call; resolves when they've gone out. */
  play(pcm: Int16Array): Promise<void> {
    if (this.closed) return Promise.reject(new CallEnded())
    // What was being heard is cut off: Marvin is talking now.
    this.ears.reset()
    for (let i = 0; i < pcm.length; i += FRAME_SAMPLES) {
      const frame = new Int16Array(FRAME_SAMPLES)
      frame.set(pcm.subarray(i, i + FRAME_SAMPLES))
      this.out.push(frame)
    }
    if (!this.out.length) return Promise.resolve()
    return new Promise((resolve) => {
      const prev = this.speakingDone
      this.speakingDone = () => {
        prev?.()
        resolve()
      }
    })
  }

  /**
   * The next thing someone says, as audio: null if nobody starts talking
   * within `waitMs`. Throws CallEnded if the call ends first.
   */
  hear(waitMs: number, ep: Partial<Endpointing> = {}): Promise<Int16Array | null> {
    if (this.closed) return Promise.reject(new CallEnded())
    this.ears.ep = { ...DEFAULT_ENDPOINTING, ...ep }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Still talking at the deadline: wait for them to finish.
        if (this.ears.inSpeech) return
        if (this.waiting === done) this.waiting = null
        resolve(null)
      }, waitMs)
      const done = (pcm: Int16Array | null) => {
        clearTimeout(timer)
        if (pcm === null && this.closed) return reject(new CallEnded())
        resolve(pcm)
      }
      this.waiting = done
    })
  }

  /** The next thing someone says, transcribed ('' if nobody spoke within `waitMs`, or it couldn't be made out). */
  async listen(waitMs: number, ep: Partial<Endpointing> = {}): Promise<string> {
    const pcm = await this.hear(waitMs, ep)
    if (!pcm || pcm.length < FRAME_SAMPLES * 10) return ''
    return this.transcribe(pcm)
  }

  async transcribe(pcm: Int16Array): Promise<string> {
    const t = this.d.transcribe ?? ((p: Int16Array) => transcribePcm(Buffer.from(p.buffer, p.byteOffset, p.byteLength), PHONE_SAMPLE_RATE, ''))
    return (await t(pcm).catch(() => '')).trim()
  }

  /** The call ended: anything waiting gives up. */
  close(): void {
    this.closed = true
    this.out = []
    const s = this.speakingDone
    this.speakingDone = null
    s?.()
    const w = this.waiting
    this.waiting = null
    w?.(null)
  }
}
