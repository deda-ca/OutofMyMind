// The phone (server: apps/server/src/phone, design: docs/phone.md): the line,
// the call in progress, recent calls, and this device's audio on a call.
// Reloaded whenever the server says something changed (notifications stream).
//
// Call audio: the microphone (with the browser's echo cancellation) goes to
// the server and the other side comes back, 16 kHz 16-bit mono over
// /api/phone/audio. An AudioWorklet converts between the device's own sample
// rate and 16 kHz both ways, and smooths playback with a small buffer.

import { reactive } from 'vue'

export interface CallView {
  id: string
  direction: 'in' | 'out'
  number: string
  display: string
  name: string
  state: 'dialing' | 'ringing' | 'active' | 'ended'
  startedAt: string
  answeredAt: string | null
  deviceJoined: boolean
  muted: boolean
  /** Marvin has the call: what it's doing (null once the owner has it, or Marvin never answered). */
  marvin: 'greeting' | 'asking' | 'ringing owner' | 'announcing' | 'connected' | 'taking a message' | 'done' | null
  /** What the caller said when Marvin asked who they are (their words). */
  said: string
  /** The live transcript so far (latest lines, in call order). */
  live: { atMs: number; who: string; text: string }[]
  /** Its file in the workspace, written as the call goes. */
  transcript: string | null
}

export interface CallRecord {
  id: string
  direction: 'in' | 'out'
  number: string
  name: string
  startedAt: string
  answeredAt: string | null
  endedAt: string
  seconds: number
  endReason: string
  recordings: { who: string; file: string }[]
  transcript: string | null
  status: 'transcribing' | 'done' | 'failed'
  outcome?: 'connected' | 'message' | 'hung up' | 'picked up' | 'blocked'
  said?: string
  message?: string
  recordingOff?: boolean
}

export interface Contact {
  number: string
  name: string
}

/** Who Marvin puts through (server: phone/rules.ts). */
export interface PhoneRules {
  answer: 'marvin' | 'screens'
  always: Contact[]
  blocked: Contact[]
  quietFrom: string
  quietTo: string
  recordingNotice: boolean
}

export interface Text {
  id: string
  direction: 'in' | 'out'
  contact: string
  message: string
  at: string
}

export const phone = reactive({
  /** Whether the server has a phone line set up. */
  enabled: false,
  line: { state: 'off' as 'off' | 'registering' | 'registered' | 'failed', detail: '', number: '' },
  call: null as CallView | null,
  calls: [] as CallRecord[],
  /** Texts (VoIP.ms API): off without the API settings; error: why the API refused (e.g. the IP isn't allowed). */
  texts: { enabled: false, error: '', list: [] as Text[] },
  rules: null as PhoneRules | null,
  /** OWNER_CELL is set (Marvin can ring it). */
  ownerCell: false,
  /** What the assistant calls itself on the phone. */
  assistant: 'Marvin',
  error: '',
  /** This device is on the call (sending and playing audio). */
  audioOn: false,
  /** This tab placed or answered the call: it should carry the audio. */
  wantAudio: false,
})

export async function loadPhone(): Promise<void> {
  try {
    const response = await fetch('/api/phone')
    const body = (await response.json().catch(() => ({}))) as { enabled?: boolean; line?: typeof phone.line; call?: CallView | null; calls?: CallRecord[]; texts?: typeof phone.texts; rules?: PhoneRules | null; ownerCell?: boolean; assistant?: string; error?: string }
    if (!response.ok) {
      phone.error = body.error ?? `HTTP ${response.status}`
      return
    }
    phone.enabled = body.enabled === true
    if (body.line) phone.line = body.line
    phone.call = body.call ?? null
    phone.calls = body.calls ?? []
    phone.texts = body.texts ?? { enabled: false, error: '', list: [] }
    phone.rules = body.rules ?? null
    phone.ownerCell = body.ownerCell === true
    if (body.assistant) phone.assistant = body.assistant
    if (!phone.call) {
      phone.wantAudio = false
      leaveAudio()
    }
    ring(phone.call?.direction === 'in' && phone.call.state === 'ringing')
  } catch (err) {
    phone.error = (err as Error).message
  }
}

async function post(path: string, body: unknown = {}): Promise<boolean> {
  phone.error = ''
  const response = await fetch(`/api/phone/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch((err: Error) => {
    phone.error = err.message
    return null
  })
  if (!response) return false
  if (!response.ok) {
    const b = (await response.json().catch(() => ({}))) as { error?: string }
    phone.error = b.error ?? `HTTP ${response.status}`
    return false
  }
  await loadPhone()
  return true
}

export async function dial(number: string): Promise<void> {
  phone.wantAudio = true
  // Started from a click, so the browser lets the audio start too.
  await joinAudio()
  if (!(await post('call', { number }))) {
    phone.wantAudio = false
    leaveAudio()
  }
}

export async function answer(): Promise<void> {
  phone.wantAudio = true
  ring(false)
  if (phone.call?.marvin) {
    // Taking it from Marvin: it steps back first, then this device joins.
    if (await post('answer')) await joinAudio()
    return
  }
  await joinAudio()
  await post('answer')
}

/** Saves the rules for incoming calls. */
export async function saveRules(rules: PhoneRules): Promise<boolean> {
  phone.error = ''
  const response = await fetch('/api/phone/rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules }) }).catch((err: Error) => {
    phone.error = err.message
    return null
  })
  if (!response) return false
  const body = (await response.json().catch(() => ({}))) as { rules?: PhoneRules; error?: string }
  if (!response.ok) {
    phone.error = body.error ?? `HTTP ${response.status}`
    return false
  }
  if (body.rules) phone.rules = body.rules
  return true
}

export const decline = () => post('decline')
export const hangUp = () => post('hangup')
export const sendDigit = (digit: string) => post('dtmf', { digit })
export const setMuted = (muted: boolean) => post('mute', { muted })
export const sendText = (number: string, message: string) => post('texts', { number, message })

// ------------------------------------------------------------------ audio

const WORKLET = `
const RATE = 16000
const FRAME = 320
class PhoneAudio extends AudioWorkletProcessor {
  constructor() {
    super()
    this.inStep = sampleRate / RATE   // device samples per 16 kHz sample
    this.inPos = 0
    this.inPrev = 0
    this.out16 = new Float32Array(FRAME)
    this.outN = 0
    this.queue = []
    this.cur = null
    this.curPos = 0
    this.playing = false
    this.port.onmessage = (e) => {
      this.queue.push(e.data)
      if (this.queue.length > 12) this.queue.splice(0, this.queue.length - 6)
    }
  }
  /** The next 16 kHz sample to play (linear between frames' samples), or 0. */
  next16() {
    if (!this.cur || this.curPos >= this.cur.length) {
      if (!this.playing && this.queue.length < 3) return null
      this.playing = true
      this.cur = this.queue.shift() || null
      this.curPos = 0
      if (!this.cur) { this.playing = false; return null }
    }
    return this.cur[this.curPos++]
  }
  process(inputs, outputs) {
    // Microphone: device rate → 16 kHz (linear), posted in 20 ms frames.
    const input = inputs[0] && inputs[0][0]
    if (input) {
      for (let i = 0; i < input.length; i++) {
        const s = input[i]
        while (this.inPos <= 1) {
          this.out16[this.outN++] = this.inPrev + (s - this.inPrev) * this.inPos
          if (this.outN === FRAME) { this.port.postMessage(this.out16.slice()); this.outN = 0 }
          this.inPos += this.inStep
        }
        this.inPos -= 1
        this.inPrev = s
      }
    }
    // Speaker: 16 kHz → device rate, linear between consecutive 16 kHz samples.
    const out = outputs[0] && outputs[0][0]
    if (out) {
      const step = RATE / sampleRate
      if (this.a === undefined) { this.a = 0; this.b = 0; this.t = 0 }
      for (let i = 0; i < out.length; i++) {
        out[i] = this.a + (this.b - this.a) * this.t
        this.t += step
        while (this.t >= 1) { this.t -= 1; this.a = this.b; const v = this.next16(); this.b = v === null ? 0 : v }
      }
    }
    return true
  }
}
registerProcessor('jarvis-phone-audio', PhoneAudio)
`

let ctx: AudioContext | null = null
let node: AudioWorkletNode | null = null
let mic: MediaStream | null = null
let socket: WebSocket | null = null

/** Puts this device on the call: microphone up, the other side down. */
export async function joinAudio(): Promise<void> {
  if (phone.audioOn || socket) return
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
    ctx = new AudioContext()
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    await ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    node = new AudioWorkletNode(ctx, 'jarvis-phone-audio', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    ctx.createMediaStreamSource(mic).connect(node)
    node.connect(ctx.destination)
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/phone/audio`)
    socket.binaryType = 'arraybuffer'
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (socket?.readyState !== WebSocket.OPEN) return
      const f = e.data
      const pcm = new Int16Array(f.length)
      for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f[i]! * 32767)))
      socket.send(pcm.buffer)
    }
    socket.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const pcm = new Int16Array(e.data)
      const f = new Float32Array(pcm.length)
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i]! / 32768
      node?.port.postMessage(f, [f.buffer])
    }
    socket.onclose = (e) => {
      if (e.code === 1008 && e.reason) phone.error = e.reason
      leaveAudio()
    }
    phone.audioOn = true
  } catch (err) {
    phone.error = `Call audio: ${(err as Error).message}`
    leaveAudio()
  }
}

export function leaveAudio(): void {
  const s = socket
  socket = null
  if (s && s.readyState <= WebSocket.OPEN) s.close()
  node?.disconnect()
  node = null
  for (const t of mic?.getTracks() ?? []) t.stop()
  mic = null
  void ctx?.close().catch(() => {})
  ctx = null
  phone.audioOn = false
}

// ------------------------------------------------------------------ ringing (an incoming call)

let ringer: { ctx: AudioContext; timer: ReturnType<typeof setInterval> } | null = null

/** The North American ring: 440 + 480 Hz, 2 s on, 4 s off. Browsers may keep it silent until the page has been clicked once. */
function ring(on: boolean): void {
  if (!on) {
    if (ringer) {
      clearInterval(ringer.timer)
      void ringer.ctx.close().catch(() => {})
      ringer = null
    }
    return
  }
  if (ringer) return
  const rctx = new AudioContext()
  const burst = () => {
    const gain = rctx.createGain()
    gain.gain.value = 0.08
    gain.connect(rctx.destination)
    for (const freq of [440, 480]) {
      const osc = rctx.createOscillator()
      osc.frequency.value = freq
      osc.connect(gain)
      osc.start()
      osc.stop(rctx.currentTime + 2)
    }
  }
  burst()
  ringer = { ctx: rctx, timer: setInterval(burst, 6000) }
}
