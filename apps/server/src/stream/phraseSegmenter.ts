// Splits a stream of VAD-scored audio frames into spoken phrases.
//
// Fed one frame at a time with Silero VAD's speech probability for it. A phrase
// starts at the first confident speech frame (plus a little audio from just
// before, so the first syllable isn't clipped) and ends after a sustained pause.
// Pure logic, no browser APIs, so it can be tested on its own.

export interface SegmenterOptions {
  /** Samples per second of the frames. */
  sampleRate: number
  /** Probability at or above which a frame counts as speech. */
  speechThreshold: number
  /** Probability below which a frame counts as silence. Between the two is "unsure". */
  silenceThreshold: number
  /** How long a pause has to last to end the phrase. */
  pauseMs: number
  /** Audio kept from before the first speech frame. */
  preSpeechPadMs: number
  /** Audio kept after the last speech frame. */
  postSpeechPadMs: number
  /** Phrases with less speech than this are discarded (coughs, clicks, door bangs). */
  minSpeechMs: number
  /** Phrases are force-split at this length even without a pause. */
  maxPhraseMs: number
}

export type SegmenterEvent =
  | { type: 'start' }
  | { type: 'end'; audio: Int16Array; reason: 'pause' | 'max-length' | 'flush'; speechMs: number }
  | { type: 'discard' }

export class PhraseSegmenter {
  private readonly preFrames: Int16Array[] = []
  private preSamplesMax: number
  private preSamples = 0

  private frames: Int16Array[] = []
  private samples = 0
  private speechSamples = 0
  private silenceSamples = 0
  /** Sample count up to and including the most recent speech frame. */
  private lastSpeechEnd = 0
  private active = false

  private options: SegmenterOptions

  constructor(options: SegmenterOptions) {
    this.options = { ...options }
    this.preSamplesMax = this.toSamples(options.preSpeechPadMs)
  }

  /** Change settings on the fly; they apply from the next frame. */
  setOptions(update: Partial<Omit<SegmenterOptions, 'sampleRate'>>): void {
    this.options = { ...this.options, ...update }
    this.preSamplesMax = this.toSamples(this.options.preSpeechPadMs)
  }

  get inPhrase(): boolean {
    return this.active
  }

  /** How long the current pause inside a phrase has lasted. */
  currentSilenceMs(): number {
    return this.active ? (this.silenceSamples / this.options.sampleRate) * 1000 : 0
  }

  /** How much confident speech the current phrase contains. */
  currentSpeechMs(): number {
    return this.active ? (this.speechSamples / this.options.sampleRate) * 1000 : 0
  }

  /** Audio of the phrase in progress (empty if none). */
  currentAudio(): Int16Array {
    return concat(this.frames, this.samples)
  }

  currentDurationMs(): number {
    return (this.samples / this.options.sampleRate) * 1000
  }

  feed(frame: Int16Array, speechProbability: number): SegmenterEvent[] {
    const events: SegmenterEvent[] = []
    const isSpeech = speechProbability >= this.options.speechThreshold
    const isSilence = speechProbability < this.options.silenceThreshold

    if (!this.active) {
      if (!isSpeech) {
        this.remember(frame)
        return events
      }
      this.begin()
      events.push({ type: 'start' })
    }

    this.frames.push(frame)
    this.samples += frame.length
    if (isSpeech) {
      this.speechSamples += frame.length
      this.silenceSamples = 0
      this.lastSpeechEnd = this.samples
    } else if (isSilence) {
      this.silenceSamples += frame.length
    }

    if (this.silenceSamples >= this.toSamples(this.options.pauseMs)) {
      events.push(this.finish('pause'))
    } else if (this.samples >= this.toSamples(this.options.maxPhraseMs)) {
      // Still talking: close this phrase and carry straight on into a new one.
      events.push(this.finish('max-length'))
      this.begin(false)
      events.push({ type: 'start' })
    }
    return events
  }

  /** End the phrase in progress, e.g. when the user stops listening. */
  flush(): SegmenterEvent[] {
    return this.active ? [this.finish('flush')] : []
  }

  private begin(withPrePad = true): void {
    this.active = true
    this.frames = withPrePad ? [...this.preFrames] : []
    this.samples = withPrePad ? this.preSamples : 0
    this.speechSamples = 0
    this.silenceSamples = 0
    this.lastSpeechEnd = this.samples
    this.preFrames.length = 0
    this.preSamples = 0
  }

  private finish(reason: 'pause' | 'max-length' | 'flush'): SegmenterEvent {
    const enoughSpeech = this.speechSamples >= this.toSamples(this.options.minSpeechMs)
    const keep = Math.min(this.samples, this.lastSpeechEnd + this.toSamples(this.options.postSpeechPadMs))
    const audio = concat(this.frames, this.samples).subarray(0, keep)
    this.active = false
    this.frames = []
    this.samples = 0
    // A forced split mid-speech is kept even if short: it's part of a longer phrase.
    const speechMs = (this.speechSamples / this.options.sampleRate) * 1000
    return enoughSpeech || reason === 'max-length' ? { type: 'end', audio, reason, speechMs } : { type: 'discard' }
  }

  private remember(frame: Int16Array): void {
    this.preFrames.push(frame)
    this.preSamples += frame.length
    while (this.preFrames.length > 1 && this.preSamples - this.preFrames[0]!.length >= this.preSamplesMax) {
      this.preSamples -= this.preFrames.shift()!.length
    }
  }

  private toSamples(ms: number): number {
    return Math.round((ms / 1000) * this.options.sampleRate)
  }
}

function concat(frames: Int16Array[], total: number): Int16Array {
  const out = new Int16Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}
