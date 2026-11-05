// Interrupting Jarvis by speaking, smoothly, in three steps:
//   1. Maybe speech (two frames that look like it): duck, i.e. fade Jarvis's volume down.
//   2. Real speech (enough confident speech within the last moment): pause Jarvis
//      and let the server decide what you said (stop / continue / repeat / new question).
//   3. Nothing more within ~0.5 s: it was a hiss or a click; fade back up.
// Pure logic, fed one 32 ms voice-detector frame at a time, so it can be tested.

export interface BargeInSettings {
  /** Silero speech probability counted as speech. */
  speechThreshold: number
  /** Confident speech needed before Jarvis pauses. */
  pauseAfterMs: number
}

export type BargeInAction = 'duck' | 'pause' | 'unduck' | null

const FRAME_MS = 32
/** "Maybe speech" (for ducking) is this much below the speech threshold. */
const DUCK_MARGIN = 0.1
/** Frames in a row of maybe-speech that duck Jarvis. */
const DUCK_FRAMES = 2
/** Without maybe-speech for this long while ducked, it was nothing: fade back up. */
const UNDUCK_AFTER_MS = 500
/** Speech is counted over this sliding window, so a word with a short gap still adds up. */
const WINDOW_MS = 800

export class BargeIn {
  private state: 'listening' | 'ducked' | 'paused' = 'listening'
  private maybeRun = 0
  private quietMs = 0
  /** Recent frames: whether each was confident speech. */
  private recent: boolean[] = []

  /** One voice-detector frame while Jarvis is talking (or ducked/paused by this). Returns what to do. */
  frame(probability: number, settings: BargeInSettings): BargeInAction {
    const speech = probability >= settings.speechThreshold
    const maybe = probability >= settings.speechThreshold - DUCK_MARGIN
    this.recent.push(speech)
    if (this.recent.length > WINDOW_MS / FRAME_MS) this.recent.shift()
    this.maybeRun = maybe ? this.maybeRun + 1 : 0
    this.quietMs = maybe ? 0 : this.quietMs + FRAME_MS

    if (this.state === 'listening') {
      if (this.maybeRun >= DUCK_FRAMES) {
        this.state = 'ducked'
        return this.confident(settings) ? this.pause() : 'duck'
      }
      return null
    }
    if (this.state === 'ducked') {
      if (this.confident(settings)) return this.pause()
      if (this.quietMs >= UNDUCK_AFTER_MS) {
        this.reset()
        return 'unduck'
      }
    }
    return null
  }

  /** Jarvis stopped talking, or the server decided (resume, stop, a new answer): start fresh. */
  reset(): void {
    this.state = 'listening'
    this.maybeRun = 0
    this.quietMs = 0
    this.recent = []
  }

  get ducked(): boolean {
    return this.state === 'ducked'
  }

  private confident(settings: BargeInSettings): boolean {
    return this.recent.filter(Boolean).length * FRAME_MS >= settings.pauseAfterMs
  }

  private pause(): BargeInAction {
    this.state = 'paused'
    return 'pause'
  }
}
