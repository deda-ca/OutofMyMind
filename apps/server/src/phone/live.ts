// The live transcript (docs/phone.md): each leg of a call cut into utterances
// as it's heard (the same loudness endpointing Marvin listens with), each
// transcribed as soon as it ends, one at a time in order. Marvin's own lines
// come from what it says, not from transcribing its voice. The screens see
// the lines as they arrive; the transcript file in calls/ grows with them, so
// Jarvis can be asked what was said while the call is still going.

import type { Leg } from './bridge.ts'
import { FRAME_SAMPLES } from './rtp.ts'
import type { Line } from './transcript.ts'
import { Endpointer } from './voice.ts'

const FRAME_MS = 20
/** Shorter than an utterance needs to be to be worth transcribing (a cough, a click). */
const MIN_FRAMES = 12

export interface LiveDeps {
  transcribe: (pcm: Int16Array) => Promise<string>
  /** Legs not transcribed from audio (Marvin: its lines are added as it says them). */
  skip?: (leg: Leg) => boolean
  /** A new line (they arrive in the order they were transcribed). */
  onLine?: (line: Line) => void
}

export class LiveTranscript {
  private readonly d: LiveDeps
  private readonly ears = new Map<Leg, Endpointer>()
  private queue: Promise<void> = Promise.resolve()
  private stopped = false
  readonly lines: Line[] = []
  /** Pieces that couldn't be transcribed (audio.cpp down, an error). */
  failed = 0

  constructor(deps: LiveDeps) {
    this.d = deps
  }

  /** A frame from a leg, at `atMs` in the call (the bridge's tap). */
  feed(leg: Leg, frame: Int16Array, atMs: number): void {
    if (this.stopped || this.d.skip?.(leg)) return
    let ears = this.ears.get(leg)
    if (!ears) {
      ears = new Endpointer({ endSilenceMs: 700, maxMs: 15_000 })
      this.ears.set(leg, ears)
    }
    const pcm = ears.push(frame)
    if (pcm) this.transcribe(leg.name, pcm, atMs + FRAME_MS - (pcm.length / FRAME_SAMPLES) * FRAME_MS)
  }

  /** A line said by someone whose words are known (Marvin). */
  add(who: string, text: string, atMs: number): void {
    if (this.stopped || !text.trim()) return
    // In order behind what's being transcribed, so the file reads in sequence.
    this.queue = this.queue.then(() => this.push({ atMs, who, text: text.trim() }))
  }

  private transcribe(who: string, pcm: Int16Array, atMs: number): void {
    if (pcm.length < MIN_FRAMES * FRAME_SAMPLES) return
    this.queue = this.queue.then(async () => {
      if (this.stopped) return
      const text = (
        await this.d.transcribe(pcm).catch(() => {
          this.failed++
          return ''
        })
      ).trim()
      if (text) this.push({ atMs, who, text })
    })
  }

  private push(line: Line): void {
    if (this.stopped) return
    this.lines.push(line)
    this.d.onLine?.(line)
  }

  /** The lines in call order (transcription can finish out of order across legs). */
  sorted(): Line[] {
    return [...this.lines].sort((a, b) => a.atMs - b.atMs)
  }

  /** The call ended at `endMs`: what was still being said is transcribed too; resolves when everything is. */
  async finish(endMs: number): Promise<void> {
    for (const [leg, ears] of this.ears) {
      const pcm = ears.flush()
      if (pcm) this.transcribe(leg.name, pcm, Math.max(0, endMs - (pcm.length / FRAME_SAMPLES) * FRAME_MS))
    }
    await this.queue
  }

  /** The caller asked not to be recorded: nothing more, and what there was is dropped. */
  discard(): void {
    this.stopped = true
    this.lines.length = 0
    this.ears.clear()
  }
}
