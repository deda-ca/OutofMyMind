// WebSocket protocol for /api/stream. Documented in the server README; any
// client (web, Android) implements the client side of this.
//
// Client → server
//   text   {"type":"start","sampleRate":16000,"language":"English","device":"web","mode":"conversation"|"enroll","settings":{…}}   first message
//   text   {"type":"settings","settings":{…}}                                       any time
//   text   {"type":"stop"}                                                          finish and close
//   text   {"type":"playback","state":"playing"|"paused"|"stopped"|"idle"}          the client's speech player (Jarvis talking)
//   text   {"type":"text","text":"…"}                                               typed (or edited) text for Jarvis, from the owner
//   binary [float32 LE speech probability][s16le mono PCM samples]                  one VAD frame
//
// Server → client
//   {"type":"ready","settings":{…},"sendHangoverMs":1500}
//   {"type":"settings","settings":{…},"sendHangoverMs":1500}
//   {"type":"phrase","id":3,"text":"…","final":false}
//   {"type":"phrase","id":4,"text":"…","final":true,"typed":true}   echo of a "text" message (always final, always the owner)
//   {"type":"phrase.dropped","id":3}
//   {"type":"phrase.split","id":3,"into":[7,8,9]}   phrase 3 had several speakers: it is now phrases 7, 8, 9 (in order)
//   {"type":"phrase.speaker","id":3,"final":false,"speaker":{"speakerId":1,"isOwner":true,"similarity":0.71,"confidence":"high"}}
//   {"type":"enroll.clip","id":3,"accepted":true,"reason":null,"text":"…","clips":4}   (enroll mode only)
//   {"type":"state","inPhrase":true,"phraseMs":2300,"speechMs":1800,"silenceMs":400}
//   {"type":"request", …RequestLog}
//   {"type":"error","message":"…"}
//   {"type":"stopped"}
//   {"type":"assistant.state","state":"idle"|"conversation","followUpEndsAt":1762370000000|null,"ownerTrained":true}
//   {"type":"assistant.start","replyId":1,"toPhraseId":3}
//   {"type":"assistant.delta","replyId":1,"delta":"Ottawa"}
//   {"type":"assistant.done","replyId":1,"text":"…","kind":"reply"|"wake"|"dismiss"}
//   {"type":"assistant.error","replyId":1,"message":"…"}
//   {"type":"assistant.audio","replyId":1,"seq":0,"text":"…","wav":"<base64 WAV>","synthMs":290}   one spoken sentence
//   {"type":"assistant.control","action":"stop"|"continue"|"repeat"|"resume","replyId":1}   playback control
//   {"type":"assistant.tool","replyId":1,"kind":"tool"|"approval"|"notice","label":"…","emoji":"🔎"}   agent activity (shown, not spoken)

import type { ContextStats } from '../assistant/context.ts'
import type { LlmRequestTrace, LlmResponseTrace } from '../assistant/llmTap.ts'
import type { AssistantMessage } from '../assistant/assistant.ts'
import type { SpeakerTag } from '../speaker/speakers.ts'
import type { StreamSettings } from './settings.ts'

export const STREAM_SAMPLE_RATE = 16000

export interface RequestLog {
  seq: number
  phraseId: number
  kind: 'partial' | 'final'
  audioMs: number
  latencyMs: number
  /** ok = shown; stale = a newer result arrived first; dropped = empty/noise; error = failed. */
  status: 'ok' | 'stale' | 'dropped' | 'error'
  text: string
}

export interface PhraseState {
  inPhrase: boolean
  phraseMs: number
  speechMs: number
  silenceMs: number
}

export type ClientMessage =
  | {
      type: 'start'
      sampleRate: number
      language?: string
      device?: string
      /** "enroll": the owner is training their voice; phrases become library clips. */
      mode?: 'conversation' | 'enroll'
      settings?: Partial<StreamSettings>
    }
  | { type: 'settings'; settings: Partial<StreamSettings> }
  | { type: 'stop' }
  /** The client muted its mic: it stops sending audio until unmuted, so finish the phrase in progress now. */
  | { type: 'mute' }
  | { type: 'playback'; state: 'playing' | 'paused' | 'stopped' | 'idle' }
  | { type: 'text'; text: string }
  /** The Debug tab: send (or stop sending) a copy of every LLM request and response. */
  | { type: 'debug'; enabled: boolean }

export type ServerMessage =
  | { type: 'ready'; settings: StreamSettings; sendHangoverMs: number }
  /** A session was added to, renamed, pinned, deleted, or another one became active (GET /api/sessions for the details). */
  | { type: 'sessions.changed'; activeId: string | null }
  /** The context meter: what the last request to the local model held, by section. */
  | { type: 'context'; stats: ContextStats }
  /** Debug tab (only after { type: 'debug', enabled: true }): an LLM request exactly as sent, and its response as received. */
  | ({ type: 'debug.llm.request' } & LlmRequestTrace)
  | ({ type: 'debug.llm.response' } & LlmResponseTrace)
  | { type: 'settings'; settings: StreamSettings; sendHangoverMs: number }
  | { type: 'phrase'; id: number; text: string; final: boolean; typed?: boolean }
  | { type: 'phrase.dropped'; id: number }
  | { type: 'phrase.split'; id: number; into: number[] }
  | { type: 'phrase.speaker'; id: number; final: boolean; speaker: SpeakerTag }
  | { type: 'enroll.clip'; id: number; accepted: boolean; reason: string | null; text: string; clips: number }
  | ({ type: 'state' } & PhraseState)
  | ({ type: 'request' } & RequestLog)
  | { type: 'error'; message: string }
  | { type: 'stopped' }
  | AssistantMessage

/** Parses a binary audio frame. Returns null if malformed. */
export function parseFrame(data: Buffer): { probability: number; pcm: Int16Array } | null {
  if (data.length < 6 || (data.length - 4) % 2 !== 0) return null
  const probability = data.readFloatLE(0)
  if (!Number.isFinite(probability)) return null
  const pcm = new Int16Array((data.length - 4) / 2)
  for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(4 + i * 2)
  return { probability: Math.min(1, Math.max(0, probability)), pcm }
}
