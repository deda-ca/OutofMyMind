// Plays Jarvis's spoken replies, one sentence (WAV) at a time, with controls:
//   duck / unduck    fade the volume down / back up (maybe someone's talking)
//   pause / resume   quick fade, then freeze mid-word / carry on (barge-in)
//   stop             stops; "continue" restarts the interrupted sentence and carries on
//   continue         plays whatever is left of the current reply
//   repeat           plays a whole earlier reply again (the last few are kept)
// A newer reply replaces an older one. (No echo handling yet: assumes headphones.)

export type PlayerState = 'idle' | 'playing' | 'paused' | 'stopped'

interface Reply {
  id: number
  /** Decoded sentences, by sequence number. */
  sentences: (AudioBuffer | undefined)[]
  /** Next sentence to play. */
  next: number
}

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
    if (this.current && replyId < this.current.id && !this.replies.has(replyId)) return // superseded
    if (!this.current || replyId > this.current.id) {
      // A new reply: it replaces whatever was playing (or stopped).
      this.stopSource()
      this.current = { id: replyId, sentences: [], next: 0 }
      this.replies.set(replyId, this.current)
      for (const id of [...this.replies.keys()].sort((a, b) => a - b).slice(0, -KEEP_REPLIES)) this.replies.delete(id)
      if (this.context?.state === 'suspended') void this.context.resume()
      this.fullVolume()
      this.setState('idle')
    }
    const reply = this.replies.get(replyId)!
    const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0))
    this.decoding = this.decoding
      .then(async () => {
        reply.sentences[seq] = await this.output().context.decodeAudioData(bytes.buffer)
        if (reply === this.current) this.pump()
      })
      .catch(() => {
        // A sentence that can't be decoded is skipped.
        reply.sentences[seq] ??= undefined
      })
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

  /** Play reply `replyId` again from the start. */
  repeat(replyId: number): void {
    const reply = this.replies.get(replyId) ?? this.current
    if (!reply) return
    this.stopSource()
    this.current = reply
    reply.next = 0
    void this.context?.resume()
    this.fullVolume()
    this.setState('idle')
    this.pump()
  }

  /** Stop everything and forget the current reply (e.g. "Stop listening"). */
  cancel(): void {
    this.stopSource()
    this.current = undefined
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

  private pump(): void {
    if (this.state === 'paused' || this.state === 'stopped' || this.source || !this.context || !this.current) return
    const reply = this.current
    const buffer = reply.sentences[reply.next]
    if (!buffer) {
      if (this.state === 'playing') this.setState('idle')
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
