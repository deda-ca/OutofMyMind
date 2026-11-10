// Thin live-transcription client for apps/server's /api/stream WebSocket.
//
// The client only answers "is anyone talking?": Silero VAD (running locally)
// scores every 32 ms frame, and frames are sent only while there is speech,
// plus a little audio from just before it and a hangover after it. Each frame
// crosses the network once. The server splits phrases, transcribes them and
// sends the text back. Protocol: apps/server/src/stream/protocol.ts.

import type { ContextStats } from '../context'
import type { DebugMessage } from '../debug'
import type { ToolCallInfo } from '../toolCalls'
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
  /** After Jarvis answers, how long it listens for follow-ups without "Jarvis". */
  followUpMs: number
  /** 1 = Jarvis speaks its replies, 0 = text only. */
  speakReplies: number
  /** 1 = while an answer takes a while, Jarvis says what it's doing. */
  speakProgress: number
  /** Who answers: 0 = the local LLM, 1 = Nous Hermes Agent. */
  brain: number
  /** 1 = no follow-ups: every request needs "Jarvis". */
  wakeWordOnly: number
  /** How far back the room note (who's around, what they said) reaches; 0 = off. */
  roomMemoryMs: number
  /** 1 = you can interrupt Jarvis by talking (client only; use headphones). */
  bargeIn: number
  /** Confident speech needed before Jarvis pauses for you (client only). */
  bargeInMs: number
  /** Jarvis's volume while it isn't sure yet whether you're talking (client only). */
  duckVolume: number
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
  followUpMs: 30000,
  speakReplies: 1,
  speakProgress: 1,
  brain: 0,
  wakeWordOnly: 0,
  roomMemoryMs: 5 * 60_000,
  bargeIn: 1,
  bargeInMs: 400,
  duckVolume: 0.3,
}

/** Messages from Jarvis the assistant (server: apps/server/src/assistant/assistant.ts). */
export type AssistantMessage =
  | { type: 'assistant.state'; state: 'idle' | 'conversation'; followUpEndsAt: number | null; ownerTrained: boolean }
  | { type: 'assistant.start'; replyId: number; toPhraseId: number }
  | { type: 'assistant.delta'; replyId: number; delta: string }
  | { type: 'assistant.done'; replyId: number; text: string; kind: 'reply' | 'wake' | 'dismiss' }
  | { type: 'assistant.error'; replyId: number; message: string }
  /** A reply cancelled before it said anything (the owner carried on talking): drop its line. */
  | { type: 'assistant.cancel'; replyId: number }
  | { type: 'assistant.audio'; replyId: number; seq: number; text: string; wav: string; synthMs: number }
  | { type: 'assistant.control'; action: 'stop' | 'continue' | 'repeat' | 'resume'; replyId: number }
  | { type: 'assistant.tool'; replyId: number; kind: 'tool' | 'approval' | 'notice'; label: string; emoji?: string; call?: ToolCallInfo }
  /** Jarvis opened a workspace file on screen. */
  | { type: 'assistant.show'; replyId: number; path: string }

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
  /** A phrase was created or its text changed. `final` text won't change again. `typed`: sent with sendText, not spoken. */
  onPhrase(id: number, text: string, final: boolean, typed?: boolean): void
  onPhraseDropped(id: number): void
  onError(message: string): void
  onFrame?(stats: FrameStats, upload: UploadStats): void
  onState?(state: PhraseState): void
  onRequest?(log: RequestLog): void
  /** Speaker guess (early, ~1.5 s in) or decision (final) for a phrase. */
  onSpeaker?(id: number, speaker: SpeakerTag, final: boolean): void
  /** Phrase `id` held several speakers: it is replaced by phrases `into`, in order. */
  onSplit?(id: number, into: number[]): void
  /** Jarvis: state changes and replies. */
  onAssistant?(message: AssistantMessage): void
  /** The server's view of the settings (it may change some itself, e.g. the brain by voice). */
  onServerSettings?(settings: StreamSettings): void
  /** A session was added to, renamed, switched, … (here or on another device). */
  onSessionsChanged?(activeId: string | null): void
  /** The context meter: what the last request to the local model held. */
  onContext?(stats: ContextStats): void
  /** Debug tab: an LLM request or response (after setDebug(true)). */
  onDebug?(message: DebugMessage): void

  /** Voice training mode: a clip was accepted or rejected. */
  onEnrollClip?(result: EnrollClipResult): void
}

type ServerMessage =
  | { type: 'ready' | 'settings'; settings: StreamSettings; sendHangoverMs: number }
  | { type: 'phrase'; id: number; text: string; final: boolean; typed?: boolean }
  | { type: 'phrase.dropped'; id: number }
  | { type: 'phrase.split'; id: number; into: number[] }
  | { type: 'phrase.speaker'; id: number; final: boolean; speaker: SpeakerTag }
  | ({ type: 'enroll.clip' } & EnrollClipResult)
  | ({ type: 'state' } & PhraseState)
  | ({ type: 'request' } & RequestLog)
  | { type: 'error'; message: string }
  | { type: 'stopped' }
  | { type: 'sessions.changed'; activeId: string | null }
  | { type: 'context'; stats: ContextStats }
  | DebugMessage
  | AssistantMessage

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
  /** Muted: the mic stays open (instant to unmute, conversation kept) but no audio is sent. */
  private muted = false

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

  /** Tell the server what Jarvis's speech player is doing. */
  sendPlayback(state: 'idle' | 'playing' | 'paused' | 'stopped'): void {
    this.sendJson({ type: 'playback', state })
  }

  /** Send typed (or corrected) text straight to Jarvis. Returns false if not connected. */
  sendText(text: string): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN || this.closing) return false
    this.sendJson({ type: 'text', text })
    return true
  }

  /**
   * Mute or unmute. Muting drops the phrase being sent and any buffered
   * pre-roll, and tells the server to finish that phrase now. Unlike stop(),
   * the connection, the conversation and Jarvis's speech carry on.
   */
  setMuted(muted: boolean): void {
    if (muted === this.muted) return
    this.muted = muted
    if (!muted) return
    this.sending = false
    this.hangoverLeft = 0
    this.preRoll = []
    this.sendJson({ type: 'mute' })
  }

  /** Debug tab: ask the server for a copy of every LLM request and response (or stop). */
  setDebug(enabled: boolean): void {
    this.sendJson({ type: 'debug', enabled })
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
        // Settings changed on the server's side too (e.g. "Jarvis, use Hermes").
        this.events.onServerSettings?.(message.settings)
        break
      case 'phrase':
        this.events.onPhrase(message.id, message.text, message.final, message.typed)
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
      case 'debug.llm.request':
      case 'debug.llm.response':
        this.events.onDebug?.(message)
        break
      case 'context':
        this.events.onContext?.(message.stats)
        break
      case 'sessions.changed':
        this.events.onSessionsChanged?.(message.activeId)
        break
      case 'stopped':
        this.stopped?.()
        break
      case 'assistant.state':
      case 'assistant.start':
      case 'assistant.delta':
      case 'assistant.done':
      case 'assistant.error':
      case 'assistant.cancel':
      case 'assistant.audio':
      case 'assistant.control':
      case 'assistant.tool':
      case 'assistant.show':
        this.events.onAssistant?.(message)
        break
    }
  }

  /** The send gate: speech, plus pre-roll before it and a hangover after it. */
  private handleFrame(frame: Float32Array, probability: number): void {
    const level = levelDb(frame)
    if (this.muted) {
      // Nothing leaves the browser. Speech probability 0, so barge-in can't pause Jarvis either.
      this.upload.framesTotal++
      this.events.onFrame?.({ probability: 0, levelDb: level, sent: false }, { ...this.upload })
      return
    }
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
    this.events.onFrame?.({ probability, levelDb: level, sent }, { ...this.upload })
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
