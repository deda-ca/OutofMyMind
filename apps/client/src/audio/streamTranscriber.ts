// Thin live-transcription client for apps/server's /api/stream WebSocket.
//
// The client only answers "is anyone talking?": Silero VAD (running locally)
// scores every 32 ms frame, and frames are sent only while there is speech,
// plus a little audio from just before it and a hangover after it. Each frame
// crosses the network once. The server splits phrases, transcribes them and
// sends the text back. Protocol: apps/server/src/stream/protocol.ts.

import { MicVAD } from '@ricky0123/vad-web'

export const SAMPLE_RATE = 16000

/** Mirrors apps/server/src/stream/settings.ts. The server clamps whatever we send. */
export interface StreamSettings {
  speechThreshold: number
  pauseMs: number
  preSpeechPadMs: number
  minSpeechMs: number
  maxPhraseMs: number
  partialIntervalMs: number
  /** Voiceprint similarity at or above which a phrase is the owner's. */
  speakerThreshold: number
  /** Split a phrase where the voice changes (similarity below this); 0 = never. */
  speakerChangeThreshold: number
}

export const DEFAULT_SETTINGS: StreamSettings = {
  speechThreshold: 0.5,
  pauseMs: 1200,
  preSpeechPadMs: 300,
  minSpeechMs: 250,
  maxPhraseMs: 25000,
  partialIntervalMs: 1000,
  speakerThreshold: 0.43,
  speakerChangeThreshold: 0.3,
}

/** Who said a phrase (server: apps/server/src/speaker/speakers.ts). */
export interface SpeakerTag {
  speakerId: number | null
  /** "You", a person's name, "Speaker A" for an unnamed voice, "New voice" (early guess), or null. */
  name: string | null
  /** Whether the name was given by you (false for "Speaker A"). */
  named: boolean
  /** true = you; false = someone else; null = can't tell (voice not trained yet). */
  isOwner: boolean | null
  /** Similarity to your voice. */
  similarity: number | null
  /** Similarity to the person it was matched to. */
  match: number | null
  confidence: 'high' | 'low' | 'uncertain'
}

export interface EnrollClipResult {
  id: number
  accepted: boolean
  reason: string | null
  text: string
  clips: number
}

/** Local, per 32 ms frame. */
export interface FrameStats {
  probability: number
  levelDb: number
  /** Whether this frame was sent to the server. */
  sent: boolean
}

/** From the server: where its phrase detection is. */
export interface PhraseState {
  inPhrase: boolean
  phraseMs: number
  speechMs: number
  silenceMs: number
}

export interface RequestLog {
  seq: number
  phraseId: number
  kind: 'partial' | 'final'
  audioMs: number
  latencyMs: number
  status: 'ok' | 'stale' | 'dropped' | 'error'
  text: string
}

export interface UploadStats {
  framesTotal: number
  framesSent: number
  bytesSent: number
}

export interface TranscriberEvents {
  /** A phrase was created or its text changed. `final` text won't change again. */
  onPhrase(id: number, text: string, final: boolean): void
  onPhraseDropped(id: number): void
  onError(message: string): void
  onFrame?(stats: FrameStats, upload: UploadStats): void
  onState?(state: PhraseState): void
  onRequest?(log: RequestLog): void
  /** Speaker guess (early, ~1.5 s in) or decision (final) for a phrase. */
  onSpeaker?(id: number, speaker: SpeakerTag, final: boolean): void
  /** Phrase `id` held several speakers: it is replaced by phrases `into`, in order. */
  onSplit?(id: number, into: number[]): void
  /** Voice training mode: a clip was accepted or rejected. */
  onEnrollClip?(result: EnrollClipResult): void
}

type ServerMessage =
  | { type: 'ready' | 'settings'; settings: StreamSettings; sendHangoverMs: number }
  | { type: 'phrase'; id: number; text: string; final: boolean }
  | { type: 'phrase.dropped'; id: number }
  | { type: 'phrase.split'; id: number; into: number[] }
  | { type: 'phrase.speaker'; id: number; final: boolean; speaker: SpeakerTag }
  | ({ type: 'enroll.clip' } & EnrollClipResult)
  | ({ type: 'state' } & PhraseState)
  | ({ type: 'request' } & RequestLog)
  | { type: 'error'; message: string }
  | { type: 'stopped' }

const FRAME_MS = 32
const STOP_TIMEOUT_MS = 30000

export class StreamTranscriber {
  private vad?: MicVAD
  private socket?: WebSocket
  private settings: StreamSettings
  private hangoverFrames = 0

  // Send gate.
  private preRoll: ArrayBuffer[] = []
  private sending = false
  private hangoverLeft = 0
  private upload: UploadStats = { framesTotal: 0, framesSent: 0, bytesSent: 0 }

  private stopped?: () => void
  private closing = false

  constructor(
    private readonly options: {
      language: string
      settings: StreamSettings
      /** "enroll" = voice training: phrases become clips of the owner's voice. */
      mode?: 'conversation' | 'enroll'
      assetPath?: string
    },
    private readonly events: TranscriberEvents,
  ) {
    this.settings = { ...options.settings }
  }

  async start(): Promise<void> {
    await this.connect()
    const assetPath = this.options.assetPath ?? '/vad/'
    this.vad = await MicVAD.new({
      model: 'v5',
      baseAssetPath: assetPath,
      onnxWASMBasePath: assetPath,
      startOnLoad: false,
      onFrameProcessed: (probs, frame) => this.handleFrame(frame, probs.isSpeech),
    })
    await this.vad.start()
  }

  updateSettings(settings: StreamSettings): void {
    this.settings = { ...settings }
    this.sendJson({ type: 'settings', settings })
  }

  /** Stop listening. Resolves once the server has sent the last final text. */
  async stop(): Promise<void> {
    await this.releaseMic()
    if (this.socket?.readyState !== WebSocket.OPEN) return
    const done = new Promise<void>((resolve) => {
      this.stopped = resolve
      setTimeout(resolve, STOP_TIMEOUT_MS)
    })
    this.closing = true
    this.sendJson({ type: 'stop' })
    await done
    this.socket.close()
  }

  /** Abort immediately; pending results are ignored. */
  cancel(): void {
    this.closing = true
    void this.releaseMic()
    this.socket?.close()
  }

  private connect(): Promise<void> {
    const url = new URL('/api/stream', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    this.socket = socket

    return new Promise((resolve, reject) => {
      let ready = false
      socket.onopen = () =>
        this.sendJson({
          type: 'start',
          sampleRate: SAMPLE_RATE,
          language: this.options.language,
          device: 'web',
          mode: this.options.mode ?? 'conversation',
          settings: this.settings,
        })
      socket.onerror = () => {
        if (!ready) reject(new Error('Could not connect to the Jarvis server. Is apps/server running?'))
      }
      socket.onclose = (event) => {
        this.stopped?.()
        if (!ready) reject(new Error(`Connection to the Jarvis server closed (${event.code}).`))
        else if (!this.closing) this.events.onError('Connection to the Jarvis server was lost.')
        void this.releaseMic()
      }
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage
        if (message.type === 'ready' && !ready) {
          ready = true
          resolve()
        }
        this.handleMessage(message)
      }
    })
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'ready':
      case 'settings':
        // The server may have clamped values; it decides how long we keep sending after speech.
        this.hangoverFrames = Math.ceil(message.sendHangoverMs / FRAME_MS)
        break
      case 'phrase':
        this.events.onPhrase(message.id, message.text, message.final)
        break
      case 'phrase.dropped':
        this.events.onPhraseDropped(message.id)
        break
      case 'phrase.split':
        this.events.onSplit?.(message.id, message.into)
        break
      case 'phrase.speaker':
        this.events.onSpeaker?.(message.id, message.speaker, message.final)
        break
      case 'enroll.clip':
        this.events.onEnrollClip?.(message)
        break
      case 'state':
        this.events.onState?.(message)
        break
      case 'request':
        this.events.onRequest?.(message)
        break
      case 'error':
        this.events.onError(message.message)
        break
      case 'stopped':
        this.stopped?.()
        break
    }
  }

  /** The send gate: speech, plus pre-roll before it and a hangover after it. */
  private handleFrame(frame: Float32Array, probability: number): void {
    const packet = encodeFrame(frame, probability)
    const isSpeech = probability >= this.settings.speechThreshold
    let sent = false

    if (isSpeech) {
      if (!this.sending) {
        for (const earlier of this.preRoll) this.sendPacket(earlier)
        this.preRoll = []
        this.sending = true
      }
      this.hangoverLeft = this.hangoverFrames
    }

    if (this.sending) {
      this.sendPacket(packet)
      sent = true
      if (!isSpeech && --this.hangoverLeft <= 0) this.sending = false
    } else {
      this.preRoll.push(packet)
      const keep = Math.ceil(this.settings.preSpeechPadMs / FRAME_MS)
      while (this.preRoll.length > keep) this.preRoll.shift()
    }

    this.upload.framesTotal++
    this.events.onFrame?.({ probability, levelDb: levelDb(frame), sent }, { ...this.upload })
  }

  private sendPacket(packet: ArrayBuffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(packet)
    this.upload.framesSent++
    this.upload.bytesSent += packet.byteLength
  }

  private sendJson(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  private async releaseMic(): Promise<void> {
    const vad = this.vad
    this.vad = undefined
    if (!vad) return
    await vad.pause()
    await vad.destroy()
  }
}

/** [float32 LE speech probability][s16le PCM] */
function encodeFrame(frame: Float32Array, probability: number): ArrayBuffer {
  const buffer = new ArrayBuffer(4 + frame.length * 2)
  const view = new DataView(buffer)
  view.setFloat32(0, probability, true)
  for (let i = 0; i < frame.length; i++) {
    const s = Math.max(-1, Math.min(1, frame[i]!))
    view.setInt16(4 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}

function levelDb(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!
  return 10 * Math.log10(sum / Math.max(1, frame.length) + 1e-10)
}
