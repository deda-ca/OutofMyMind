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
/** Utterances kept while nobody listens. */
const MAX_UNHEARD = 5
/**
 * Barge-in: while Marvin talks, the other side talking over it for this long
 * (ms, continuously) stops Marvin, which then listens. Their voice must be
 * louder than BARGE_MIN_RMS and than BARGE_ECHO_RATIO times how loud Marvin's
 * own voice has been lately: the line's echo of Marvin comes back quieter, so
 * it doesn't count. Tuned by hand for VoIP.ms calls; check on a real call.
 */
export const BARGE_MS = 300
export const BARGE_MIN_RMS = 1500
export const BARGE_ECHO_RATIO = 0.5
/** How far back (frames) Marvin's own loudness is remembered for the echo check: 0.5 s, covering the line's delay. */
const OWN_LEVEL_FRAMES = 25

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
  /** The speech model, "connection/model" (default audio.tts). */
  model?: string
  /** Called with what Marvin actually said (the whole thing, or the part before it was talked over), when it's done. */
  onSay?: (text: string, atMs: number) => void
  /** The call's clock (ms), for when each thing was said. */
  clockMs?: () => number
}

export class CallEnded extends Error {
  constructor() {
    super('the call ended')
  }
}

/** The first part of a text, by share (0..1) of its words (a cut sentence's part before the cut). */
export function cutText(text: string, share: number): string {
  const words = text.trim().split(/\s+/)
  const k = Math.max(0, Math.min(words.length, Math.floor(words.length * share)))
  return words.slice(0, k).join(' ')
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
  /**
   * What was said while nobody was listening (Marvin thinking, or the other
   * side talking as Marvin finished): kept for the next listen, oldest first.
   */
  private unheard: Int16Array[] = []
  /** Not listening until then (ms): the echo of what Marvin just said. */
  private deafUntil = 0
  /** Barge-in: how loud Marvin has been lately, and the other side's talk over it so far. */
  private ownLevels: number[] = []
  private talkingRun = 0
  private heardWhileTalking: Int16Array[] = []
  /** Times Marvin stopped talking because the other side talked over it. */
  interrupted = 0
  /** The sentence going out (its frames), and where it was cut off, if it was. */
  private playing: { total: number } | null = null
  private cut: { played: number; total: number } | null = null

  constructor(deps: VoiceDeps) {
    this.name = deps.name
    this.d = deps
  }

  get speaking(): boolean {
    return this.out.length > 0
  }

  read(): Int16Array | null {
    const frame = this.out.shift() ?? null
    if (frame) {
      this.ownLevels.push(rms(frame))
      if (this.ownLevels.length > OWN_LEVEL_FRAMES) this.ownLevels.shift()
    }
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
    // While Marvin talks: only watching for the other side talking over it (barge-in).
    if (this.speaking) return this.watchForTalkOver(frame)
    // Not for a moment after talking (the line's delay, the far end's echo).
    if (Date.now() < this.deafUntil) return
    const pcm = this.ears.push(frame)
    if (pcm) this.deliver(pcm)
  }

  /** An utterance heard: to whoever is waiting, else kept for the next listen. */
  private deliver(pcm: Int16Array): void {
    const w = this.waiting
    if (!w) {
      // Nobody is listening yet: keep it (a few utterances at most; the oldest go first).
      this.unheard.push(pcm)
      if (this.unheard.length > MAX_UNHEARD) this.unheard.shift()
      return
    }
    this.waiting = null
    w(pcm)
  }

  /** Marvin talking: a loud run of the other side's voice (not its echo) stops Marvin, and that voice is what it hears next. */
  private watchForTalkOver(frame: Int16Array): void {
    const level = rms(frame)
    this.heardWhileTalking.push(frame)
    if (this.heardWhileTalking.length > BARGE_MS / FRAME_MS + 5) this.heardWhileTalking.shift()
    const ownLoudest = this.ownLevels.length ? Math.max(...this.ownLevels) : 0
    const echoCeiling = Math.max(BARGE_MIN_RMS, BARGE_ECHO_RATIO * ownLoudest)
    this.talkingRun = level > echoCeiling ? this.talkingRun + 1 : 0
    if (this.talkingRun * FRAME_MS >= BARGE_MS) this.interrupt()
  }

  /** Stops Marvin mid-sentence: what was playing is dropped, and the talk over it goes to the ears. */
  private interrupt(): void {
    this.interrupted++
    // How much of the sentence went out (its frames not yet read are dropped).
    if (this.playing) this.cut = { played: this.playing.total - this.out.length, total: this.playing.total }
    this.out = []
    const done = this.speakingDone
    this.speakingDone = null
    this.ears.reset()
    for (const f of this.heardWhileTalking) {
      const pcm = this.ears.push(f)
      if (pcm) this.deliver(pcm)
    }
    this.heardWhileTalking = []
    this.talkingRun = 0
    this.ownLevels = []
    this.deafUntil = Date.now() + 150
    done?.()
  }

  /**
   * Says `text` into the call; resolves when it has been played, or when the
   * other side talks over it (barge-in). Returns what was actually said: the
   * whole text, or the part of it before Marvin was cut off (by share of time).
   */
  async say(text: string): Promise<string> {
    if (this.closed) throw new CallEnded()
    const wav = await (this.d.synthesize ?? ((t: string) => synthesize(t, undefined, this.d.voice, this.d.model)))(text)
    if (this.closed) throw new CallEnded()
    const pcm = wavToPcm16k(wav)
    const total = Math.max(1, Math.ceil(pcm.length / FRAME_SAMPLES))
    const at = this.d.clockMs?.() ?? 0
    this.cut = null
    await this.play(pcm)
    const cut = this.cut as { played: number; total: number } | null
    this.cut = null
    const spoken = cut ? cutText(text, cut.played / Math.min(cut.total, total)) : text
    if (spoken.trim()) this.d.onSay?.(spoken, at)
    return spoken
  }

  /** Plays 16 kHz samples into the call; resolves when they've gone out (or Marvin is cut off). */
  play(pcm: Int16Array): Promise<void> {
    if (this.closed) return Promise.reject(new CallEnded())
    // What was being heard is cut off: Marvin is talking now.
    this.ears.reset()
    const before = this.out.length
    for (let i = 0; i < pcm.length; i += FRAME_SAMPLES) {
      const frame = new Int16Array(FRAME_SAMPLES)
      frame.set(pcm.subarray(i, i + FRAME_SAMPLES))
      this.out.push(frame)
    }
    if (!this.out.length) return Promise.resolve()
    this.playing = { total: this.out.length - before }
    return new Promise((resolve) => {
      const prev = this.speakingDone
      this.speakingDone = () => {
        prev?.()
        this.playing = null
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
    const kept = this.unheard.shift()
    if (kept) return Promise.resolve(kept)
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
