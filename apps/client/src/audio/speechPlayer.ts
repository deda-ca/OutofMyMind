// Plays Jarvis's spoken replies: one WAV per sentence, back to back without
// gaps. A newer reply cuts off an older one.
// (No echo handling yet: assumes headphones or an earpiece.)

export class SpeechPlayer {
  private context?: AudioContext
  private replyId = 0
  /** Decodes run one after another so sentences keep their order. */
  private decoding: Promise<void> = Promise.resolve()
  private nextStart = 0
  private readonly sources = new Set<AudioBufferSourceNode>()
  private readonly onSpeaking: (speaking: boolean) => void

  constructor(onSpeaking: (speaking: boolean) => void) {
    this.onSpeaking = onSpeaking
  }

  /** Create or resume audio output; call from a user action (e.g. "Start listening") so the browser allows sound. */
  async unlock(): Promise<void> {
    this.context ??= new AudioContext()
    if (this.context.state === 'suspended') await this.context.resume()
  }

  /** Queue one spoken sentence (base64 WAV) of a reply. */
  play(replyId: number, wavBase64: string): void {
    if (replyId < this.replyId) return // from a reply that's already been superseded
    if (replyId > this.replyId) {
      this.stop()
      this.replyId = replyId
    }
    const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0))
    this.decoding = this.decoding
      .then(async () => {
        await this.unlock()
        const context = this.context!
        const buffer = await context.decodeAudioData(bytes.buffer)
        if (replyId !== this.replyId) return
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        const at = Math.max(context.currentTime + 0.02, this.nextStart)
        source.start(at)
        this.nextStart = at + buffer.duration
        this.sources.add(source)
        this.onSpeaking(true)
        source.onended = () => {
          this.sources.delete(source)
          if (this.sources.size === 0) this.onSpeaking(false)
        }
      })
      .catch(() => {
        // A sentence that can't be decoded is skipped; the rest still play.
      })
  }

  /** Stop speaking now. */
  stop(): void {
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // already stopped
      }
    }
    this.sources.clear()
    this.nextStart = 0
    this.onSpeaking(false)
  }

  close(): void {
    this.stop()
    void this.context?.close()
    this.context = undefined
  }
}
