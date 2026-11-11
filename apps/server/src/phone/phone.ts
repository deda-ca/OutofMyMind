// The phone (docs/phone.md, phase 1): the line, the call in progress and its
// bridge, the owner's device as a leg of it, and the call log. One call at a
// time. When a call ends, each leg's recording is kept in the audio archive
// and transcribed into WORKSPACE_DIR/calls/, where Jarvis can read it.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { encodeOggOpus } from '../archive/oggOpus.ts'
import { transcribePcm } from '../audiocpp.ts'
import { Bridge, FRAME_MS, type Leg } from './bridge.ts'
import { type Call, Line, type LineState } from './line.ts'
import { display, sameNumber, toE164 } from './numbers.ts'
import { FRAME_SAMPLES } from './rtp.ts'
import { formatTranscript, PHONE_SAMPLE_RATE, utterances, type Line as TranscriptLine } from './transcript.ts'

export interface PhoneSettings {
  server: string
  user: string
  password: string
  did: string
  callerId: string
  ownerCell: string
  maxCallMinutes: number
  dailyMinutes: number
  ringSeconds: number
}

export interface PhoneDeps {
  settings: PhoneSettings
  dataDir: string
  workspaceDir: string
  ownerName: string
  log: (message: string, err?: unknown) => void
  /** Tells every screen something changed (they reload GET /api/phone). */
  changed: () => void
  /** A note in the active session ("Call with …: transcript in calls/…"). */
  note: (text: string) => void
  /** Puts a notification on screen (incoming and missed calls). */
  notify: (title: string, text: string) => void
  /** Transcribes 16 kHz audio; overridable in tests. */
  transcribe?: (pcm: Int16Array) => Promise<string>
}

export interface CallRecord {
  id: string
  direction: 'in' | 'out'
  number: string
  name: string
  startedAt: string
  answeredAt: string | null
  endedAt: string
  /** Seconds talking (0 if never answered). */
  seconds: number
  endReason: string
  /** Recordings, relative to DATA_DIR. */
  recordings: { who: string; file: string }[]
  /** The transcript, relative to the workspace (null until it's written, or if nothing was said). */
  transcript: string | null
  status: 'transcribing' | 'done' | 'failed'
}

export interface CallView {
  id: string
  direction: 'in' | 'out'
  number: string
  display: string
  name: string
  state: Call['state']
  startedAt: string
  answeredAt: string | null
  /** Whether a device (the web client, the Android app) is on the call. */
  deviceJoined: boolean
  muted: boolean
}

/** The owner's device as a leg: 16 kHz PCM both ways over a WebSocket. */
export class DeviceLeg implements Leg {
  readonly name: string
  private queue: Int16Array[] = []
  private pending = new Int16Array(0)
  private playing = false
  private readonly sendFrame: (frame: Int16Array) => void

  constructor(name: string, sendFrame: (frame: Int16Array) => void) {
    this.name = name
    this.sendFrame = sendFrame
  }

  /** Audio from the device, any length: cut into 20 ms frames. */
  push(samples: Int16Array): void {
    const all = new Int16Array(this.pending.length + samples.length)
    all.set(this.pending)
    all.set(samples, this.pending.length)
    let i = 0
    for (; i + FRAME_SAMPLES <= all.length; i += FRAME_SAMPLES) this.queue.push(all.slice(i, i + FRAME_SAMPLES))
    this.pending = all.slice(i)
    // Latency over completeness: at most ~200 ms queued.
    while (this.queue.length > 10) this.queue.shift()
  }

  read(): Int16Array | null {
    if (!this.playing) {
      if (this.queue.length < 3) return null
      this.playing = true
    }
    const frame = this.queue.shift() ?? null
    if (!frame) this.playing = false
    return frame
  }

  write(frame: Int16Array): void {
    this.sendFrame(frame)
  }
}

export class PhoneError extends Error {}

const LOG_KEEP = 500

export class Phone extends EventEmitter<{ change: [] }> {
  readonly line: Line
  private readonly d: PhoneDeps
  private call: Call | null = null
  private bridge: Bridge | null = null
  private device: DeviceLeg | null = null
  private muted = false
  private ringTimer: ReturnType<typeof setTimeout> | null = null
  private readonly logFile: string
  private log: CallRecord[] = []

  constructor(deps: PhoneDeps) {
    super()
    this.d = deps
    const s = deps.settings
    this.line = new Line({ server: s.server, user: s.user, password: s.password, callerId: this.e164(s.callerId || s.did), log: deps.log })
    this.line.on('state', (state, detail) => {
      deps.log(`phone: line ${state}${detail ? ` (${detail})` : ''}`)
      this.changed()
    })
    this.line.on('incoming', (call) => this.onIncoming(call))
    this.logFile = path.join(deps.dataDir, 'phone', 'calls.json')
    try {
      this.log = JSON.parse(fs.readFileSync(this.logFile, 'utf8')) as CallRecord[]
      // Transcribing when the server stopped: the recordings are there, the transcript isn't.
      for (const r of this.log) if (r.status === 'transcribing') r.status = 'failed'
    } catch {
      // none yet
    }
  }

  private e164(n: string): string {
    try {
      return n ? toE164(n) : ''
    } catch {
      return n.replace(/\D/g, '')
    }
  }

  async start(): Promise<void> {
    await this.line.start()
  }

  async stop(): Promise<void> {
    if (this.ringTimer) clearTimeout(this.ringTimer)
    await this.line.stop()
  }

  private changed(): void {
    this.emit('change')
    this.d.changed()
  }

  // ------------------------------------------------------------------ status

  status(): { line: { state: LineState; detail: string; number: string }; call: CallView | null; calls: CallRecord[] } {
    return {
      line: { state: this.line.state, detail: this.line.detail, number: this.d.settings.did ? display(this.e164(this.d.settings.did)) : '' },
      call: this.view(),
      calls: this.log.slice(0, 50),
    }
  }

  view(): CallView | null {
    const c = this.call
    if (!c) return null
    return {
      id: c.id,
      direction: c.direction,
      number: c.number,
      display: display(c.number),
      name: c.name,
      state: c.state,
      startedAt: new Date(c.createdAt).toISOString(),
      answeredAt: c.answeredAt ? new Date(c.answeredAt).toISOString() : null,
      deviceJoined: Boolean(this.device && this.bridge?.has(this.device)),
      muted: this.muted,
    }
  }

  recent(limit = 10): CallRecord[] {
    return this.log.slice(0, limit)
  }

  /** Minutes of outgoing calls today (local time), the one in progress included. */
  minutesToday(now = new Date()): number {
    const day = now.toDateString()
    const past = this.log.filter((r) => r.direction === 'out' && new Date(r.startedAt).toDateString() === day).reduce((sum, r) => sum + r.seconds, 0)
    const current = this.call?.direction === 'out' && this.call.answeredAt ? (Date.now() - this.call.answeredAt) / 1000 : 0
    return (past + current) / 60
  }

  // ------------------------------------------------------------------ calls

  /** Places a call to `number` (any North American format). The caller ID is the owner's (VOIPMS_CALLER_ID), or the DID when calling the owner. */
  async dial(number: string): Promise<CallView> {
    const e164 = toE164(number)
    if (this.call) throw new PhoneError('There is already a call: hang it up first.')
    const { dailyMinutes, ownerCell, did, callerId } = this.d.settings
    if (dailyMinutes > 0 && this.minutesToday() >= dailyMinutes) throw new PhoneError(`Today's ${dailyMinutes} minutes of outgoing calls are used up (PHONE_DAILY_MINUTES).`)
    // Calling the owner's own cell with their own number as caller ID gets it blocked: the DID instead.
    const from = this.e164(sameNumber(e164, ownerCell) ? did : callerId || did)
    const call = await this.line.call(e164, from)
    this.track(call)
    this.connect(call)
    return this.view()!
  }

  answer(): void {
    const c = this.call
    if (!c || c.direction !== 'in' || c.state !== 'ringing') throw new PhoneError('No call is ringing.')
    if (this.ringTimer) clearTimeout(this.ringTimer)
    c.answer()
    this.connect(c)
  }

  decline(): void {
    const c = this.call
    if (!c || c.direction !== 'in' || c.state !== 'ringing') throw new PhoneError('No call is ringing.')
    c.decline(486, 'Busy Here')
  }

  async hangUp(): Promise<void> {
    if (!this.call) throw new PhoneError('There is no call.')
    await this.call.hangUp()
  }

  dtmf(digit: string): void {
    if (!this.call || this.call.state !== 'active') throw new PhoneError('There is no call in progress.')
    if (!/^[0-9*#A-D]$/i.test(digit)) throw new PhoneError(`Not a keypad key: ${digit}`)
    this.call.sendDtmf(digit)
  }

  mute(muted: boolean): void {
    this.muted = muted
    if (this.device) this.bridge?.mute(this.device, muted)
    this.changed()
  }

  /** The owner's device joins the call (one at a time); returns how to leave. */
  attachDevice(sendFrame: (frame: Int16Array) => void): { leg: DeviceLeg; leave: () => void } {
    if (this.device && this.bridge?.has(this.device)) throw new PhoneError('Another device is already on the call.')
    const leg = new DeviceLeg(this.d.ownerName || 'Owner', sendFrame)
    this.device = leg
    this.bridge?.join(leg)
    if (this.muted) this.bridge?.mute(leg, true)
    this.changed()
    return {
      leg,
      leave: () => {
        this.bridge?.leave(leg)
        if (this.device === leg) this.device = null
        this.changed()
      },
    }
  }

  private onIncoming(call: Call): void {
    if (this.call) {
      call.decline(486, 'Busy Here')
      return
    }
    this.track(call)
    const who = call.name ? `${call.name} (${display(call.number)})` : display(call.number)
    this.d.notify('Phone', `Incoming call from ${who}.`)
    this.ringTimer = setTimeout(() => {
      if (call.state === 'ringing') call.decline(480, 'Temporarily Unavailable')
    }, this.d.settings.ringSeconds * 1000)
  }

  private track(call: Call): void {
    this.call = call
    this.muted = false
    call.on('state', (state) => {
      this.changed()
      if (state === 'ended') void this.finish(call)
    })
    this.changed()
  }

  /** The bridge starts at once (silence going out opens the router for the answer's audio). */
  private connect(call: Call): void {
    if (this.bridge) return
    const maxFrames = (this.d.settings.maxCallMinutes * 60_000) / FRAME_MS
    const bridge = new Bridge(maxFrames)
    const phoneLeg: Leg = { name: call.name || display(call.number), read: () => call.rtp?.read() ?? null, write: (f) => call.rtp?.write(f) }
    bridge.join(phoneLeg)
    if (this.device) bridge.join(this.device)
    this.bridge = bridge
    bridge.start()
    // The longest call: hang up when the bridge stops at its limit.
    const limit = setInterval(() => {
      if (call.state === 'ended') return clearInterval(limit)
      if (call.answeredAt && Date.now() - call.answeredAt > this.d.settings.maxCallMinutes * 60_000) {
        clearInterval(limit)
        void call.hangUp(`longer than ${this.d.settings.maxCallMinutes} minutes (PHONE_MAX_CALL_MINUTES)`)
      }
    }, 5000)
  }

  // ------------------------------------------------------------------ after the call

  private async finish(call: Call): Promise<void> {
    if (this.ringTimer) clearTimeout(this.ringTimer)
    const bridge = this.bridge
    bridge?.stop()
    this.bridge = null
    this.call = null
    const record: CallRecord = {
      id: call.id,
      direction: call.direction,
      number: call.number,
      name: call.name,
      startedAt: new Date(call.createdAt).toISOString(),
      answeredAt: call.answeredAt ? new Date(call.answeredAt).toISOString() : null,
      endedAt: new Date(call.endedAt ?? Date.now()).toISOString(),
      seconds: call.answeredAt ? Math.round(((call.endedAt ?? Date.now()) - call.answeredAt) / 1000) : 0,
      endReason: call.endReason,
      recordings: [],
      transcript: null,
      status: call.answeredAt && bridge ? 'transcribing' : 'done',
    }
    this.log.unshift(record)
    this.log = this.log.slice(0, LOG_KEEP)
    this.save()
    this.changed()
    const who = call.name ? `${call.name} (${display(call.number)})` : display(call.number)
    if (call.direction === 'in' && !call.answeredAt) {
      this.d.notify('Phone', `Missed call from ${who}.`)
      this.d.note(`Missed call from ${who}.`)
    }
    if (!call.answeredAt || !bridge) return
    try {
      await this.keep(record, bridge, who)
      record.status = 'done'
    } catch (err) {
      record.status = 'failed'
      this.d.log('phone: keeping the call failed', err)
    }
    this.save()
    this.changed()
  }

  /** Recordings into the audio archive, the transcript into the workspace, a note in the session. */
  private async keep(record: CallRecord, bridge: Bridge, who: string): Promise<void> {
    const dir = path.join(this.d.dataDir, 'audio', 'calls', record.id)
    fs.mkdirSync(dir, { recursive: true })
    const transcribe = this.d.transcribe ?? ((pcm: Int16Array) => transcribePcm(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), PHONE_SAMPLE_RATE, ''))
    const lines: TranscriptLine[] = []
    let failed = 0
    for (const [i, rec] of bridge.recordings().entries()) {
      const file = path.join(dir, `${i + 1}.ogg`)
      fs.writeFileSync(file, await encodeOggOpus(rec.pcm, { TITLE: `Call ${record.direction === 'out' ? 'to' : 'from'} ${who}: ${rec.name}`, DATE: record.startedAt }))
      record.recordings.push({ who: rec.name, file: path.relative(this.d.dataDir, file) })
      for (const u of utterances(rec.pcm, rec.offsetMs)) {
        const text = (await transcribe(u.pcm).catch(() => {
          failed++
          return ''
        })).trim()
        if (text) lines.push({ atMs: u.startMs, who: rec.name, text })
      }
    }
    const started = new Date(record.startedAt)
    const stamp = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, '0')}-${String(started.getDate()).padStart(2, '0')} ${String(started.getHours()).padStart(2, '0')}${String(started.getMinutes()).padStart(2, '0')}`
    const name = `${stamp} ${record.direction === 'out' ? 'to' : 'from'} ${display(record.number).replace(/[^\w +-]/g, '')}.md`
    const minutes = Math.max(1, Math.round(record.seconds / 60))
    const body = [
      `# Call ${record.direction === 'out' ? 'to' : 'from'} ${who}`,
      '',
      `${started.toLocaleString()} · ${minutes} min · ended: ${record.endReason}`,
      '',
      lines.length ? formatTranscript(lines) : '_Nothing was said that could be transcribed._',
      ...(failed ? ['', `_${failed} part${failed === 1 ? '' : 's'} couldn't be transcribed (is audio.cpp running?)._`] : []),
      '',
    ].join('\n')
    const calls = path.join(this.d.workspaceDir, 'calls')
    fs.mkdirSync(calls, { recursive: true })
    fs.writeFileSync(path.join(calls, name), body)
    record.transcript = `calls/${name}`
    this.d.note(`Phone call ${record.direction === 'out' ? 'to' : 'from'} ${who}, ${minutes} min (${record.endReason}). Transcript: ${record.transcript}`)
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true })
    const tmp = `${this.logFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.log, null, 1))
    fs.renameSync(tmp, this.logFile)
  }
}
