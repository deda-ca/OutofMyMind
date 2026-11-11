// RTP (RFC 3550) for one call: G.711 μ-law in 20 ms packets, a small jitter
// buffer for what arrives, and keypad tones (RFC 4733 telephone-event) both
// ways. Audio in and out is 16 kHz, 320 samples per 20 ms frame.
//
// NAT: we send from the port we advertise, and send first (silence counts),
// so the router opens the way back; VoIP.ms (NAT=yes) answers to wherever our
// packets come from. If the other side's packets come from another address
// than its SDP said, we follow them (latching).

import crypto from 'node:crypto'
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { Downsampler, Upsampler, ulawDecode, ulawEncode } from './g711.ts'
import { DTMF_PAYLOAD, PCMU } from './sip.ts'

export const FRAME_SAMPLES = 320
const SAMPLES_8K = 160
/** Frames held before playing out, and at most (older ones are dropped: latency over completeness). */
const JITTER_START = 2
const JITTER_MAX = 10
const DTMF_EVENTS = '0123456789*#ABCD'

export class RtpSession extends EventEmitter<{ dtmf: [digit: string] }> {
  readonly socket: dgram.Socket
  private remote: { ip: string; port: number } | null = null
  private dtmfPayload = DTMF_PAYLOAD
  private seq = crypto.randomInt(0, 0xffff)
  private timestamp = crypto.randomInt(0, 0xffffffff)
  private readonly ssrc = crypto.randomInt(0, 0xffffffff)
  private marker = true
  private readonly up = new Upsampler()
  private readonly down = new Downsampler()
  private queue: Int16Array[] = []
  private playing = false
  private lastSeq: number | null = null
  private lastDtmfTimestamp: number | null = null
  private dtmfOut: { code: number; sent: number } | null = null
  /** Packets received / sent, for the call log and to spot one-way audio. */
  received = 0
  sent = 0
  private closed = false

  private constructor(socket: dgram.Socket) {
    super()
    this.socket = socket
    socket.on('message', (msg, rinfo) => this.onPacket(msg, rinfo))
    socket.on('error', () => {})
  }

  /** A session on a free UDP port (even, as RTP prefers). */
  static async open(): Promise<RtpSession> {
    for (let tries = 0; tries < 20; tries++) {
      const port = 10000 + 2 * crypto.randomInt(0, 10000)
      const socket = dgram.createSocket('udp4')
      const ok = await new Promise<boolean>((resolve) => {
        socket.once('error', () => resolve(false))
        socket.bind(port, () => resolve(true))
      })
      if (ok) return new RtpSession(socket)
      socket.close()
    }
    throw new Error('no free UDP port for the call audio')
  }

  get port(): number {
    return this.socket.address().port
  }

  setRemote(ip: string, port: number, dtmfPayload?: number): void {
    this.remote = { ip, port }
    if (dtmfPayload !== undefined) this.dtmfPayload = dtmfPayload
  }

  /** The next 20 ms the other side said (16 kHz), or null if nothing is ready. */
  read(): Int16Array | null {
    if (!this.playing) {
      if (this.queue.length < JITTER_START) return null
      this.playing = true
    }
    const frame = this.queue.shift() ?? null
    if (!frame) this.playing = false
    return frame
  }

  /** Sends 20 ms (16 kHz, 320 samples). While a keypad tone is going out, its packets go instead. */
  write(frame: Int16Array): void {
    if (!this.remote || this.closed) return
    if (this.dtmfOut) return this.sendDtmfPacket()
    const payload = ulawEncode(this.down.process(frame))
    this.send(PCMU, payload, this.marker)
    this.marker = false
    this.timestamp = (this.timestamp + SAMPLES_8K) >>> 0
  }

  /** Sends a keypad tone (0-9 * # A-D), 100 ms, in place of audio. */
  sendDtmf(digit: string): void {
    const code = DTMF_EVENTS.indexOf(digit.toUpperCase())
    if (code < 0) throw new Error(`not a keypad key: ${digit}`)
    this.dtmfOut = { code, sent: 0 }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket.close()
  }

  private sendDtmfPacket(): void {
    const d = this.dtmfOut!
    d.sent++
    // 5 packets of growing duration (100 ms), then the end packet 3 times; one timestamp for the whole event.
    const end = d.sent > 5
    const duration = Math.min(d.sent, 5) * SAMPLES_8K
    const payload = Buffer.from([d.code, (end ? 0x80 : 0) | 10, duration >> 8, duration & 0xff])
    this.send(this.dtmfPayload, payload, d.sent === 1)
    if (d.sent >= 8) {
      this.dtmfOut = null
      this.timestamp = (this.timestamp + duration) >>> 0
      this.marker = true
    }
  }

  private send(payloadType: number, payload: Uint8Array, marker: boolean): void {
    const packet = Buffer.alloc(12 + payload.length)
    packet[0] = 0x80
    packet[1] = (marker ? 0x80 : 0) | payloadType
    packet.writeUInt16BE(this.seq, 2)
    packet.writeUInt32BE(this.timestamp, 4)
    packet.writeUInt32BE(this.ssrc, 8)
    Buffer.from(payload.buffer, payload.byteOffset, payload.length).copy(packet, 12)
    this.seq = (this.seq + 1) & 0xffff
    this.sent++
    this.socket.send(packet, this.remote!.port, this.remote!.ip)
  }

  private onPacket(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (msg.length < 12 || msg[0]! >> 6 !== 2) return
    // Latching: answer to where the media actually comes from.
    if (this.remote && (rinfo.address !== this.remote.ip || rinfo.port !== this.remote.port)) this.remote = { ip: rinfo.address, port: rinfo.port }
    const csrc = msg[0]! & 0x0f
    let offset = 12 + 4 * csrc
    if (msg[0]! & 0x10) {
      if (msg.length < offset + 4) return
      offset += 4 + 4 * msg.readUInt16BE(offset + 2)
    }
    let end = msg.length
    if (msg[0]! & 0x20) end -= msg[msg.length - 1]!
    if (end <= offset) return
    const payloadType = msg[1]! & 0x7f
    const seq = msg.readUInt16BE(2)
    const timestamp = msg.readUInt32BE(4)
    const payload = msg.subarray(offset, end)
    this.received++

    if (payloadType === this.dtmfPayload || payloadType === DTMF_PAYLOAD) {
      // One digit per event: reported once, on its first packet.
      if (payload.length >= 4 && timestamp !== this.lastDtmfTimestamp) {
        this.lastDtmfTimestamp = timestamp
        const digit = DTMF_EVENTS[payload[0]!]
        if (digit) this.emit('dtmf', digit)
      }
      return
    }
    if (payloadType !== PCMU) return
    // Late or repeated packets are dropped; small gaps are not filled (the bridge plays silence).
    if (this.lastSeq !== null) {
      const delta = (seq - this.lastSeq) & 0xffff
      if (delta === 0 || delta > 0x8000) return
    }
    this.lastSeq = seq
    const pcm = this.up.process(ulawDecode(payload))
    for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES) this.queue.push(pcm.subarray(i, i + FRAME_SAMPLES))
    while (this.queue.length > JITTER_MAX) this.queue.shift()
  }
}
