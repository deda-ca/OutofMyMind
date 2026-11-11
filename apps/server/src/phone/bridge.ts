// The bridge: joins the legs of a call (a phone call, the owner's device,
// later Marvin's voice). Every 20 ms it takes each leg's next frame (silence
// if there is none), gives each leg the sum of all the others (never its own),
// and keeps what each leg said, on its own track, for the recording and the
// transcript. It is the call's only clock.

import { FRAME_SAMPLES } from './rtp.ts'

export const FRAME_MS = 20

export interface Leg {
  /** Who this is in the transcript: "Owner", "+1 613 555 0123". */
  name: string
  /** Its next 20 ms (16 kHz), or null if it has nothing yet. */
  read(): Int16Array | null
  /** What it should hear for the next 20 ms. */
  write(frame: Int16Array): void
}

interface Track {
  leg: Leg
  /** Recorded frames, from `startFrame` on (silence where it said nothing). */
  frames: Int16Array[]
  startFrame: number
  /** Muted: it hears everything but nobody hears it (still recorded as silence). */
  muted: boolean
}

const SILENCE = new Int16Array(FRAME_SAMPLES)
/** After a stall (a blocked event loop), at most this many frames are caught up; the rest are skipped. */
const MAX_CATCH_UP = 5

export class Bridge {
  private tracks: Track[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private frame = 0
  private started = 0
  /** Every leg ever joined, for the recording (kept after they leave). */
  private readonly history: Track[] = []

  private readonly maxFrames: number

  constructor(maxFrames = Number.POSITIVE_INFINITY) {
    this.maxFrames = maxFrames
  }

  join(leg: Leg): void {
    if (this.tracks.some((t) => t.leg === leg)) return
    const existing = this.history.find((t) => t.leg === leg)
    const track = existing ?? { leg, frames: [], startFrame: this.frame, muted: false }
    this.tracks.push(track)
    if (!existing) this.history.push(track)
  }

  leave(leg: Leg): void {
    this.tracks = this.tracks.filter((t) => t.leg !== leg)
  }

  mute(leg: Leg, muted: boolean): void {
    const t = this.tracks.find((x) => x.leg === leg)
    if (t) t.muted = muted
  }

  has(leg: Leg): boolean {
    return this.tracks.some((t) => t.leg === leg)
  }

  start(): void {
    if (this.timer) return
    this.started = Date.now() - this.frame * FRAME_MS
    this.timer = setInterval(() => this.catchUp(), FRAME_MS / 2)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Seconds since the bridge started. */
  get seconds(): number {
    return (this.frame * FRAME_MS) / 1000
  }

  /** One frame, by hand (tests; the timer calls it). */
  tick(): void {
    if (this.frame >= this.maxFrames) return this.stop()
    const inputs = this.tracks.map((t) => {
      const got = t.leg.read()
      const frame = got && got.length === FRAME_SAMPLES ? got : SILENCE
      return t.muted ? SILENCE : frame
    })
    for (const [i, t] of this.tracks.entries()) {
      // Recorded aligned with the bridge's clock: a leg that joined late starts later.
      while (t.startFrame + t.frames.length < this.frame) t.frames.push(SILENCE)
      t.frames.push(inputs[i]!)
    }
    for (const [i, t] of this.tracks.entries()) {
      const out = new Int16Array(FRAME_SAMPLES)
      for (let s = 0; s < FRAME_SAMPLES; s++) {
        let sum = 0
        for (let j = 0; j < inputs.length; j++) if (j !== i) sum += inputs[j]![s]!
        out[s] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum
      }
      t.leg.write(out)
    }
    this.frame++
  }

  /** Each leg's recording: 16 kHz from the bridge's start, and where in the call it begins. */
  recordings(): { name: string; offsetMs: number; pcm: Int16Array }[] {
    return this.history.map((t) => {
      const pcm = new Int16Array(t.frames.length * FRAME_SAMPLES)
      t.frames.forEach((f, i) => pcm.set(f, i * FRAME_SAMPLES))
      return { name: t.leg.name, offsetMs: t.startFrame * FRAME_MS, pcm }
    })
  }

  private catchUp(): void {
    const due = Math.floor((Date.now() - this.started) / FRAME_MS)
    let n = 0
    while (this.frame < due && n++ < MAX_CATCH_UP) this.tick()
    // Too far behind: skip ahead rather than play a burst.
    if (this.frame < due) this.started = Date.now() - this.frame * FRAME_MS
  }
}
