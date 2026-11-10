// Plays Jarvis's spoken replies, one sentence (WAV) at a time, with controls:
//   duck / unduck    fade the volume down / back up (maybe someone's talking)
//   pause / resume   quick fade, then freeze mid-word / carry on (barge-in)
//   stop             stops; "continue" restarts the interrupted sentence and carries on
//   continue         plays whatever is left of the current reply
//   repeat           plays a whole earlier reply again (the last few are kept)
//   playFetched      plays speech fetched on demand (replaying a reply whose audio isn't kept)
// A newer reply replaces an older one. (No echo handling yet: assumes headphones.)

export type PlayerState = 'idle' | 'playing' | 'paused' | 'stopped'

interface Reply {
  id: number
  /** Decoded sentences, by sequence number (null: couldn't be decoded, skipped). */
  sentences: (AudioBuffer | null | undefined)[]
  /** Next sentence to play. */
  next: number
  /** How many sentences there are, when known (a repeat or a replay); then `done` is called after the last. */
  total?: number
  /** Settles a repeat/replay: it finished, or something else took over. */
  done?: () => void
  /** Stops a replay's fetching. */
  abort?: AbortController
}

/** The id of a replay (speech fetched on demand): lower than any live reply, so any new reply replaces it. */
const REPLAY_ID = Number.MIN_SAFE_INTEGER

const KEEP_REPLIES = 5
/** Fade times (seconds): ducking, pausing, and coming back. */
const DUCK_FADE_S = 0.15
const PAUSE_FADE_S = 0.08
const RESTORE_FADE_S = 0.3

export class SpeechPlayer {
  private context?: AudioContext
  /** All speech goes through this, so the volume can be faded. */
  private gain?: GainNode
  private current?: Reply
  /** The newest live reply seen: an older one's late sentences are dropped. */
  private latest = -Infinity
  private readonly replies = new Map<number, Reply>()
  private source?: AudioBufferSourceNode
  private state: PlayerState = 'idle'
  /** Decodes run one after another so sentences keep their order. */
  private decoding: Promise<void> = Promise.resolve()
  private readonly onState: (state: PlayerState) => void

  constructor(onState: (state: PlayerState) => void) {
    this.onState = onState
  }

  get playerState(): PlayerState {
    return this.state
  }

  /** The live reply being spoken (or last spoken); undefined during a replay of fetched speech. */
  get currentReplyId(): number | undefined {
    return this.current && this.current.id !== REPLAY_ID ? this.current.id : undefined
  }

  /** Create or resume audio output; call from a user action (e.g. "Start listening") so the browser allows sound. */
  async unlock(): Promise<void> {
    this.output()
    if (this.context!.state === 'suspended' && this.state !== 'paused') await this.context!.resume()
  }

  /** Fade the volume to `level` (0–1): someone may be talking. */
  duck(level: number): void {
    this.fadeTo(level, DUCK_FADE_S)
  }

  /** Fade back to full volume. */
  unduck(): void {
    this.fadeTo(1, RESTORE_FADE_S)
  }

  private output(): { context: AudioContext; gain: GainNode } {
    if (!this.context) {
      this.context = new AudioContext()
      this.gain = this.context.createGain()
      this.gain.connect(this.context.destination)
    }
    return { context: this.context, gain: this.gain! }
  }

  private fadeTo(level: number, seconds: number): void {
    if (!this.context || !this.gain) return
    const now = this.context.currentTime
    this.gain.gain.cancelScheduledValues(now)
    this.gain.gain.setValueAtTime(this.gain.gain.value, now)
    this.gain.gain.linearRampToValueAtTime(level, now + seconds)
  }

  /** Full volume straight away (a new reply, repeat, continue). */
  private fullVolume(): void {
    if (!this.context || !this.gain) return
    this.gain.gain.cancelScheduledValues(this.context.currentTime)
    this.gain.gain.setValueAtTime(1, this.context.currentTime)
  }

  /** One spoken sentence (base64 WAV) of reply `replyId`. */
  add(replyId: number, seq: number, wavBase64: string): void {
    let reply = this.replies.get(replyId)
    if (!reply) {
      if (replyId < this.latest) return // superseded
      // A new reply: it replaces whatever was playing (or stopped), a replay too.
      this.stopSource()
      reply = { id: replyId, sentences: [], next: 0 }
      this.use(reply)
      this.latest = replyId
      this.replies.set(replyId, reply)
      for (const id of [...this.replies.keys()].sort((a, b) => a - b).slice(0, -KEEP_REPLIES)) this.replies.delete(id)
      if (this.context?.state === 'suspended') void this.context.resume()
      this.fullVolume()
      this.setState('idle')
    }
    const target = reply
    const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0))
    this.decoding = this.decoding
      .then(async () => {
        target.sentences[seq] = await this.output().context.decodeAudioData(bytes.buffer)
      })
      .catch(() => {
        // A sentence that can't be decoded is skipped.
        target.sentences[seq] = null
      })
      .then(() => {
        if (target === this.current) this.pump()
      })
  }

  /** Whether the audio of live reply `replyId` is still kept (`repeat` can play it). */
  has(replyId: number): boolean {
    return this.replies.has(replyId)
  }

  /**
   * Speak `count` sentences fetched on demand (`load(i)`: sentence i's WAV), as
   * soon as each arrives; fetching runs one sentence ahead of playing. Replaces
   * what's playing, and any new live reply replaces it. Resolves when it's
   * finished or replaced; rejects if a sentence can't be fetched.
   */
  playFetched(count: number, load: (index: number, signal: AbortSignal) => Promise<ArrayBuffer>): Promise<void> {
    this.stopSource()
    const abort = new AbortController()
    const reply: Reply = { id: REPLAY_ID, sentences: [], next: 0, total: count, abort }
    const finished = new Promise<void>((resolve, reject) => {
      reply.done = resolve
      const context = this.output().context
      void (async () => {
        for (let i = 0; i < count; i++) {
          // Keep at most one sentence ready ahead of the one playing.
          while (!abort.signal.aborted && i > reply.next + 1) await new Promise((r) => setTimeout(r, 100))
          if (abort.signal.aborted) return
          let wav: ArrayBuffer
          try {
            wav = await load(i, abort.signal)
          } catch (err) {
            if (abort.signal.aborted) return
            reject(err) // first, so stopping below doesn't settle it as finished
            if (reply === this.current) this.cancel()
            return
          }
          if (abort.signal.aborted) return
          reply.sentences[i] = await context.decodeAudioData(wav).catch(() => null)
          if (reply === this.current) this.pump()
        }
      })()
    })
    this.use(reply)
    void this.context?.resume()
    this.fullVolume()
    this.setState('idle')
    this.pump()
    return finished
  }

  /** Barge-in: a quick fade, then freeze mid-word. */
  pause(): void {
    if (this.state !== 'playing' || !this.context) return
    const context = this.context
    this.fadeTo(0, PAUSE_FADE_S)
    this.setState('paused')
    setTimeout(() => {
      if (this.state === 'paused') void context.suspend()
    }, PAUSE_FADE_S * 1000 + 10)
  }

  /** After a barge-in that wasn't for Jarvis: carry on from where it paused, fading back in. */
  resume(): void {
    if (this.state !== 'paused') return
    void this.context?.resume().then(() => this.fadeTo(1, RESTORE_FADE_S))
    this.setState(this.source ? 'playing' : 'idle')
    this.pump()
  }

  /** Stop talking; `continueSpeaking` picks up from the interrupted sentence. */
  stop(): void {
    if (this.state !== 'playing' && this.state !== 'paused') return
    this.stopSource()
    void this.context?.resume()
    this.fullVolume()
    this.setState('stopped')
  }

  /** Play the rest of the current reply. */
  continueSpeaking(): void {
    if (!this.current) return
    void this.context?.resume()
    this.fullVolume()
    if (this.state === 'stopped' || this.state === 'paused') this.setState(this.source ? 'playing' : 'idle')
    this.pump()
  }

  /** Play reply `replyId` again from the start. Resolves when it's finished or replaced. */
  repeat(replyId: number): Promise<void> {
    const reply = this.replies.get(replyId) ?? this.current
    if (!reply) return Promise.resolve()
    this.stopSource()
    this.use(reply)
    const finished = new Promise<void>((resolve) => (reply.done = resolve))
    // Its sentences so far (any still arriving play on after it's settled).
    reply.total = reply.sentences.length
    reply.next = 0
    void this.context?.resume()
    this.fullVolume()
    this.setState('idle')
    this.pump()
    return finished
  }

  /** Stop everything and forget the current reply (e.g. "Stop listening", or ■ on a replay). */
  cancel(): void {
    this.stopSource()
    this.use(undefined)
    void this.context?.resume()
    this.fullVolume()
    this.setState('idle')
  }

  close(): void {
    this.cancel()
    void this.context?.close()
    this.context = undefined
    this.gain = undefined
  }

  /** Make `reply` the current one; the one it replaces is settled (and stops fetching). */
  private use(reply: Reply | undefined): void {
    const before = this.current
    this.current = reply
    if (before && before !== reply) this.settle(before)
  }

  private settle(reply: Reply): void {
    reply.abort?.abort()
    const done = reply.done
    reply.done = undefined
    done?.()
  }

  private pump(): void {
    if (this.state === 'paused' || this.state === 'stopped' || this.source || !this.context || !this.current) return
    const reply = this.current
    while (reply.sentences[reply.next] === null) reply.next++ // couldn't be decoded: skip it
    const buffer = reply.sentences[reply.next]
    if (!buffer) {
      if (this.state === 'playing') this.setState('idle')
      if (reply.total !== undefined && reply.next >= reply.total) this.settle(reply)
      return
    }
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.output().gain)
    source.onended = () => {
      if (this.source !== source) return
      this.source = undefined
      reply.next++
      this.pump()
    }
    this.source = source
    source.start()
    this.setState('playing')
  }

  private stopSource(): void {
    const source = this.source
    this.source = undefined
    if (!source) return
    source.onended = null
    try {
      source.stop()
    } catch {
      // already stopped
    }
  }

  private setState(state: PlayerState): void {
    if (state === this.state) return
    this.state = state
    this.onState(state)
  }
}
