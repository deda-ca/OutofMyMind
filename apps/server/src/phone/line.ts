// Jarvis's phone line: a SIP user agent over UDP, registered with VoIP.ms
// (docs/phone.md). It places and takes calls; their audio is in each call's
// RtpSession. Every SIP packet goes to the provider's server (it is our
// outbound proxy), and only packets from it are accepted.
//
// Behind a home router: the address the provider sees (Via received/rport on
// its first answer) goes in Contact, Via and SDP; the provider's keep-alives
// (OPTIONS every 60 s) plus our own every 25 s keep the router's mapping open.

import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { RtpSession } from './rtp.ts'
import {
  buildSdp, cseqOf, digestAuthorization, displayNameOf, header, newBranch, param, parseSdp, parseSip, randomToken, request, response, serialize, tagOf, uriOf, userOf,
  type SipMessage,
} from './sip.ts'

export interface LineConfig {
  server: string
  user: string
  password: string
  /** Caller ID on calls out (E.164 digits, e.g. 16135550123). */
  callerId: string
  log?: (message: string, err?: unknown) => void
}

export type LineState = 'off' | 'registering' | 'registered' | 'failed'

const T1 = 500
const T2 = 4000
const TRANSACTION_TIMEOUT = 32_000
const KEEPALIVE_MS = 25_000
const REGISTER_EXPIRES = 300
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS, UPDATE, INFO, NOTIFY'
const USER_AGENT = 'Jarvis'

interface ClientTxn {
  msg: SipMessage
  resolve: (m: SipMessage) => void
  reject: (e: Error) => void
  onProvisional?: (m: SipMessage) => void
  timers: ReturnType<typeof setTimeout>[]
}

export class Line extends EventEmitter<{ state: [state: LineState, detail: string]; incoming: [call: Call] }> {
  private socket: dgram.Socket | null = null
  private serverIp = ''
  private localIp = ''
  private localPort = 0
  /** The address the provider sees us at (after the first REGISTER answer). */
  publicIp = ''
  private publicPort = 0
  private txns = new Map<string, ClientTxn>()
  /** Responses we sent, by branch + method: repeated for retransmitted requests. */
  private answered = new Map<string, { msg: string; at: number }>()
  readonly calls = new Map<string, Call>()
  state: LineState = 'off'
  detail = ''
  private registerCallId = `${randomToken(10)}@jarvis`
  private registerCseq = 0
  private registerTimer: ReturnType<typeof setTimeout> | null = null
  private keepalive: ReturnType<typeof setInterval> | null = null
  private failures = 0
  private stopped = false

  readonly config: LineConfig

  constructor(config: LineConfig) {
    super()
    this.config = config
  }

  private log(message: string, err?: unknown): void {
    this.config.log?.(`phone: ${message}`, err)
  }

  async start(): Promise<void> {
    this.stopped = false
    this.serverIp = (await dns.lookup(this.config.server, { family: 4 })).address
    this.localIp = await routeAddress(this.serverIp)
    const socket = dgram.createSocket('udp4')
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(0, () => resolve())
    })
    socket.on('error', (err) => this.log('SIP socket error', err))
    socket.on('message', (buf, rinfo) => this.onPacket(buf, rinfo))
    this.socket = socket
    this.localPort = socket.address().port
    this.keepalive = setInterval(() => this.sendRaw('\r\n\r\n'), KEEPALIVE_MS)
    await this.register()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.registerTimer) clearTimeout(this.registerTimer)
    if (this.keepalive) clearInterval(this.keepalive)
    for (const call of this.calls.values()) await call.hangUp().catch(() => {})
    if (this.state === 'registered') await this.sendRegister(0).catch(() => {})
    for (const t of this.txns.values()) t.timers.forEach(clearTimeout)
    this.txns.clear()
    this.socket?.close()
    this.socket = null
    this.setState('off', '')
  }

  /** Where we say we are: the provider's view of us once known. */
  get contactHost(): string {
    return this.publicIp ? `${this.publicIp}:${this.publicPort}` : `${this.localIp}:${this.localPort}`
  }

  /** The address for call audio in SDP: the public one (the provider latches onto where our packets come from). */
  get mediaIp(): string {
    return this.publicIp || this.localIp
  }

  get serverUri(): string {
    return `sip:${this.config.server}`
  }

  private setState(state: LineState, detail: string): void {
    if (state === this.state && detail === this.detail) return
    this.state = state
    this.detail = detail
    this.emit('state', state, detail)
  }

  // ------------------------------------------------------------------ registration

  private async register(): Promise<void> {
    if (this.stopped) return
    if (this.registerTimer) clearTimeout(this.registerTimer)
    if (this.state !== 'registered') this.setState('registering', '')
    try {
      const before = this.contactHost
      let res = await this.sendRegister(REGISTER_EXPIRES)
      // The first answer told us our public address: register again with it.
      if (res.status === 200 && this.contactHost !== before) res = await this.sendRegister(REGISTER_EXPIRES)
      if (res.status !== 200) throw new Error(`${res.status} ${res.reason}${res.status === 403 ? ' (wrong password, or a POP restriction to another server)' : ''}`)
      const granted = Number(param(header(res, 'contact'), 'expires') ?? header(res, 'expires')) || REGISTER_EXPIRES
      this.failures = 0
      this.setState('registered', `${this.config.user}@${this.config.server}`)
      this.registerTimer = setTimeout(() => void this.register(), Math.max(30, granted * 0.8) * 1000)
    } catch (err) {
      this.failures++
      const wait = Math.min(300, 15 * 2 ** Math.min(this.failures, 5))
      this.setState('failed', (err as Error).message)
      this.log(`registration failed (retrying in ${wait} s): ${(err as Error).message}`)
      this.registerTimer = setTimeout(() => void this.register(), wait * 1000)
    }
  }

  private async sendRegister(expires: number): Promise<SipMessage> {
    return this.sendWithAuth((auth) => {
      this.registerCseq++
      return request('REGISTER', this.serverUri, [
        ['Via', this.via()],
        ['Max-Forwards', '70'],
        ['From', `<sip:${this.config.user}@${this.config.server}>;tag=${randomToken()}`],
        ['To', `<sip:${this.config.user}@${this.config.server}>`],
        ['Call-ID', this.registerCallId],
        ['CSeq', `${this.registerCseq} REGISTER`],
        ['Contact', `<sip:${this.config.user}@${this.contactHost}>`],
        ['Expires', String(expires)],
        ['Allow', ALLOW],
        ['User-Agent', USER_AGENT],
        ...auth,
      ])
    })
  }

  // ------------------------------------------------------------------ transport and transactions

  via(branch = newBranch()): string {
    return `SIP/2.0/UDP ${this.contactHost};branch=${branch};rport`
  }

  private sendRaw(text: string): void {
    this.socket?.send(text, 5060, this.serverIp)
  }

  send(msg: SipMessage): void {
    this.sendRaw(serialize(msg))
  }

  /** Sends a request built by `build`, answering one digest challenge (401/407). Resolves with the final response. */
  async sendWithAuth(build: (auth: [string, string][]) => SipMessage, onProvisional?: (m: SipMessage) => void, onSent?: (m: SipMessage) => void): Promise<SipMessage> {
    let msg = build([])
    onSent?.(msg)
    let res = await this.transact(msg, onProvisional)
    if (res.status === 401 || res.status === 407) {
      const challenge = header(res, res.status === 401 ? 'www-authenticate' : 'proxy-authenticate')
      const authorization = digestAuthorization({ challenge, method: msg.method!, uri: msg.uri!, username: this.config.user, password: this.config.password })
      msg = build([[res.status === 401 ? 'Authorization' : 'Proxy-Authorization', authorization]])
      onSent?.(msg)
      res = await this.transact(msg, onProvisional)
    }
    return res
  }

  /** One client transaction: retransmits over UDP until answered (RFC 3261 timers A/E). */
  transact(msg: SipMessage, onProvisional?: (m: SipMessage) => void): Promise<SipMessage> {
    const branch = param(header(msg, 'via'), 'branch')!
    const invite = msg.method === 'INVITE'
    return new Promise((resolve, reject) => {
      const txn: ClientTxn = { msg, resolve, reject, onProvisional, timers: [] }
      this.txns.set(`${branch}:${msg.method}`, txn)
      const text = serialize(msg)
      let interval = T1
      const retransmit = () => {
        this.sendRaw(text)
        interval = invite ? interval * 2 : Math.min(interval * 2, T2)
        txn.timers.push(setTimeout(retransmit, interval))
      }
      this.sendRaw(text)
      txn.timers.push(setTimeout(retransmit, interval))
      txn.timers.push(
        setTimeout(() => {
          this.finish(branch, msg.method!)
          reject(new Error(`no answer from ${this.config.server}`))
        }, TRANSACTION_TIMEOUT),
      )
    })
  }

  private finish(branch: string, method: string): void {
    const key = `${branch}:${method}`
    const txn = this.txns.get(key)
    if (!txn) return
    txn.timers.forEach(clearTimeout)
    this.txns.delete(key)
  }

  private onPacket(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    // Only the provider talks to us (anything else is a scanner).
    if (rinfo.address !== this.serverIp) return
    const msg = parseSip(buf.toString('utf8'))
    if (!msg) return
    try {
      if (msg.status !== undefined) this.onResponse(msg)
      else this.onRequest(msg, rinfo)
    } catch (err) {
      this.log(`couldn't handle ${msg.method ?? msg.status}`, err)
    }
  }

  private onResponse(res: SipMessage): void {
    const via = header(res, 'via')
    const received = param(via, 'received')
    const rport = Number(param(via, 'rport'))
    if (received && rport) {
      this.publicIp = received
      this.publicPort = rport
    }
    const branch = param(via, 'branch') ?? ''
    const { method } = cseqOf(res)
    const txn = this.txns.get(`${branch}:${method}`)
    if (!txn) {
      // A 2xx to an INVITE whose transaction is over (our ACK was lost): ACK again.
      if (method === 'INVITE' && res.status! >= 200 && res.status! < 300) this.calls.get(header(res, 'call-id'))?.ackAgain()
      return
    }
    if (res.status! < 200) {
      if (method === 'INVITE') {
        // A provisional answer stops INVITE retransmissions (timer A); the timeout stays.
        txn.timers.slice(0, -1).forEach(clearTimeout)
        txn.timers = txn.timers.slice(-1)
      }
      txn.onProvisional?.(res)
      return
    }
    this.finish(branch, method)
    // A failed INVITE is ACKed by the transaction (same branch).
    if (method === 'INVITE' && res.status! >= 300) {
      const req = txn.msg
      this.send(request('ACK', req.uri!, [['Via', header(req, 'via')], ['Max-Forwards', '70'], ['From', header(req, 'from')], ['To', header(res, 'to')], ['Call-ID', header(req, 'call-id')], ['CSeq', `${cseqOf(req).seq} ACK`]]))
    }
    txn.resolve(res)
  }

  private onRequest(req: SipMessage, rinfo: dgram.RemoteInfo): void {
    const branch = param(header(req, 'via'), 'branch') ?? ''
    const key = `${branch}:${req.method}`
    // A retransmission: the same answer again.
    const before = this.answered.get(key)
    if (before && req.method !== 'ACK') {
      this.socket?.send(before.msg, rinfo.port, rinfo.address)
      return
    }
    const reply = (status: number, reason: string, extra: [string, string][] = [], body = '', toTag?: string) => {
      const text = serialize(response(req, status, reason, extra, body, toTag))
      this.socket?.send(text, rinfo.port, rinfo.address)
      if (status >= 200) {
        this.answered.set(key, { msg: text, at: Date.now() })
        this.pruneAnswered()
      }
      return text
    }
    const call = this.calls.get(header(req, 'call-id'))
    switch (req.method) {
      case 'OPTIONS':
        reply(200, 'OK', [['Allow', ALLOW], ['Accept', 'application/sdp']], '', randomToken())
        return
      case 'INVITE':
        // The first INVITE again (sent before we answered): it's ringing; the answer goes out when there is one.
        if (call?.isFirstInvite(branch)) return
        if (call) return call.onReInvite(req, reply)
        return this.onInvite(req, reply)
      case 'ACK':
        call?.onAck()
        return
      case 'CANCEL':
        if (!call) return void reply(481, 'Call/Transaction Does Not Exist')
        reply(200, 'OK')
        call.onCancel()
        return
      case 'BYE':
        if (!call) return void reply(481, 'Call/Transaction Does Not Exist')
        reply(200, 'OK')
        call.onBye()
        return
      case 'UPDATE':
      case 'INFO':
      case 'NOTIFY':
        reply(200, 'OK')
        return
      default:
        reply(405, 'Method Not Allowed', [['Allow', ALLOW]])
    }
  }

  private pruneAnswered(): void {
    const old = Date.now() - TRANSACTION_TIMEOUT
    for (const [k, v] of this.answered) if (v.at < old) this.answered.delete(k)
  }

  private onInvite(req: SipMessage, reply: (status: number, reason: string, extra?: [string, string][], body?: string, toTag?: string) => string): void {
    reply(100, 'Trying')
    const call = new Call(this, 'in', userOf(header(req, 'from')) || 'unknown', displayNameOf(header(req, 'from')))
    call.acceptInvite(req, reply)
  }

  // ------------------------------------------------------------------ calls out

  /** Places a call to `number` (E.164 digits). Resolves once the call is set up (ringing or not yet). */
  async call(number: string, callerId = this.config.callerId): Promise<Call> {
    if (this.state !== 'registered') throw new Error(`the line isn't ready (${this.state}${this.detail ? `: ${this.detail}` : ''})`)
    const call = new Call(this, 'out', number, '')
    await call.dial(callerId)
    return call
  }
}

export type CallState = 'dialing' | 'ringing' | 'active' | 'ended'

type Reply = (status: number, reason: string, extra?: [string, string][], body?: string, toTag?: string) => string

/** One call: its SIP dialog and its audio (rtp). */
export class Call extends EventEmitter<{ state: [state: CallState]; dtmf: [digit: string] }> {
  readonly id = randomToken(8)
  callId: string
  state: CallState = 'dialing'
  readonly createdAt = Date.now()
  answeredAt: number | null = null
  endedAt: number | null = null
  endReason = ''
  rtp: RtpSession | null = null
  private localTag = randomToken()
  private remoteTag = ''
  private localUri = ''
  private remoteUri = ''
  private remoteTarget = ''
  private routeSet: string[] = []
  private cseq = 1
  private invite: SipMessage | null = null
  private ack: SipMessage | null = null
  private okRetransmit: ReturnType<typeof setTimeout> | null = null
  private inviteReply: Reply | null = null
  private sdpVersion = 1
  private readonly sessionId = String(Date.now())

  private readonly line: Line
  readonly direction: 'in' | 'out'
  /** The other party: E.164 digits (or whatever the network gave for an incoming call). */
  readonly number: string
  /** The caller's name, if the network gave one. */
  readonly name: string

  constructor(line: Line, direction: 'in' | 'out', number: string, name: string) {
    super()
    this.line = line
    this.direction = direction
    this.number = number
    this.name = name
    this.callId = `${randomToken(10)}@jarvis`
  }

  private setState(state: CallState): void {
    if (this.state === state || this.state === 'ended') return
    this.state = state
    if (state === 'active') this.answeredAt = Date.now()
    this.emit('state', state)
  }

  private async openMedia(): Promise<RtpSession> {
    this.rtp = await RtpSession.open()
    this.rtp.on('dtmf', (d) => this.emit('dtmf', d))
    return this.rtp
  }

  private sdp(): string {
    return buildSdp({ ip: this.line.mediaIp, port: this.rtp!.port, sessionId: this.sessionId, version: this.sdpVersion })
  }

  private applyRemoteSdp(body: string): boolean {
    const media = parseSdp(body)
    if (!media || !media.pcmu) return false
    if (!media.onHold) this.rtp?.setRemote(media.ip, media.port, media.dtmfPayload)
    return true
  }

  // ---------------------------------------------------------------- out

  async dial(callerId: string): Promise<void> {
    const { config } = this.line
    this.line.calls.set(this.callId, this)
    await this.openMedia()
    this.localUri = `<sip:${callerId}@${config.server}>;tag=${this.localTag}`
    this.remoteUri = `<sip:${this.number}@${config.server}>`
    const uri = `sip:${this.number}@${config.server}`
    void this.line
      .sendWithAuth(
        (auth) =>
          request(
            'INVITE',
            uri,
            [
              ['Via', this.line.via()],
              ['Max-Forwards', '70'],
              ['From', this.localUri],
              ['To', this.remoteUri],
              ['Call-ID', this.callId],
              ['CSeq', `${this.cseq++} INVITE`],
              ['Contact', `<sip:${config.user}@${this.line.contactHost}>`],
              // Caller ID: the sub-account passes its own (docs/phone.md).
              ['P-Asserted-Identity', `<sip:${callerId}@${config.server}>`],
              ['Remote-Party-ID', `<sip:${callerId}@${config.server}>;party=calling;screen=yes;privacy=off`],
              ['Allow', ALLOW],
              ['User-Agent', USER_AGENT],
              ['Content-Type', 'application/sdp'],
              ...auth,
            ],
            this.sdp(),
          ),
        (provisional) => {
          if (provisional.status === 180 || provisional.status === 183) this.setState('ringing')
          // Early media (the network's ringback, announcements): heard before the answer.
          if (provisional.body) this.applyRemoteSdp(provisional.body)
        },
        (sent) => (this.invite = sent),
      )
      .then((res) => this.onInviteFinal(res))
      .catch((err: Error) => this.end(err.message))
  }

  private onInviteFinal(res: SipMessage): void {
    if (this.state === 'ended') {
      // Answered after we hung up: end it properly.
      if (res.status! < 300) {
        this.establish(res)
        this.sendAck()
        void this.sendBye()
      }
      return
    }
    if (res.status! >= 300) return this.end(failureReason(res.status!, res.reason ?? ''))
    this.establish(res)
    this.applyRemoteSdp(res.body)
    this.sendAck()
    this.setState('active')
  }

  private establish(res: SipMessage): void {
    this.remoteTag = tagOf(header(res, 'to')) ?? ''
    this.remoteUri = header(res, 'to')
    this.remoteTarget = uriOf(header(res, 'contact')) || this.invite!.uri!
    this.routeSet = [...(res.headers.get('record-route') ?? [])].reverse()
  }

  private sendAck(): void {
    const inviteSeq = cseqOf(this.invite!).seq
    this.ack = this.inDialog('ACK', [], '', inviteSeq)
    this.line.send(this.ack)
  }

  ackAgain(): void {
    if (this.ack) this.line.send(this.ack)
  }

  // ---------------------------------------------------------------- in

  acceptInvite(req: SipMessage, reply: Reply): void {
    this.invite = req
    this.inviteReply = reply
    this.remoteTag = tagOf(header(req, 'from')) ?? ''
    this.remoteUri = header(req, 'from')
    this.localUri = `${header(req, 'to')};tag=${this.localTag}`
    this.remoteTarget = uriOf(header(req, 'contact')) || uriOf(header(req, 'from'))
    this.routeSet = [...(req.headers.get('record-route') ?? [])]
    this.cseq = 1
    this.callId = header(req, 'call-id')
    this.line.calls.set(this.callId, this)
    void this.openMedia().then(() => {
      if (!this.applyRemoteSdp(req.body)) {
        reply(488, 'Not Acceptable Here', [], '', this.localTag)
        return this.end('no common codec')
      }
      reply(180, 'Ringing', [['Contact', `<sip:${this.line.config.user}@${this.line.contactHost}>`]], '', this.localTag)
      this.setState('ringing')
      this.line.emit('incoming', this)
    })
  }

  /** Answers an incoming call (200 OK with our SDP, repeated until the ACK). */
  answer(): void {
    if (this.direction !== 'in' || this.state !== 'ringing' || !this.inviteReply) return
    const reply = this.inviteReply
    const send = () => reply(200, 'OK', [['Contact', `<sip:${this.line.config.user}@${this.line.contactHost}>`], ['Allow', ALLOW], ['Content-Type', 'application/sdp']], this.sdp(), this.localTag)
    send()
    let interval = T1
    const started = Date.now()
    const again = () => {
      if (Date.now() - started > TRANSACTION_TIMEOUT) {
        this.okRetransmit = null
        void this.hangUp()
        return
      }
      send()
      interval = Math.min(interval * 2, T2)
      this.okRetransmit = setTimeout(again, interval)
    }
    this.okRetransmit = setTimeout(again, interval)
    this.setState('active')
  }

  /** Turns down an incoming call that hasn't been answered (486 busy, 480 unavailable, 603 decline). */
  decline(status = 486, reason = 'Busy Here'): void {
    if (this.direction !== 'in' || this.state !== 'ringing' || !this.inviteReply) return
    this.inviteReply(status, reason, [], '', this.localTag)
    this.end(status === 486 ? 'declined' : 'not answered')
  }

  isFirstInvite(branch: string): boolean {
    return this.direction === 'in' && param(header(this.invite!, 'via'), 'branch') === branch
  }

  onAck(): void {
    if (this.okRetransmit) clearTimeout(this.okRetransmit)
    this.okRetransmit = null
  }

  onCancel(): void {
    if (this.state === 'ended') return
    this.inviteReply?.(487, 'Request Terminated', [], '', this.localTag)
    this.end('missed')
  }

  // ---------------------------------------------------------------- both

  onReInvite(req: SipMessage, reply: Reply): void {
    if (req.body) this.applyRemoteSdp(req.body)
    this.sdpVersion++
    reply(200, 'OK', [['Contact', `<sip:${this.line.config.user}@${this.line.contactHost}>`], ['Content-Type', 'application/sdp']], this.sdp(), this.localTag)
  }

  onBye(): void {
    this.end('hung up')
  }

  sendDtmf(digit: string): void {
    this.rtp?.sendDtmf(digit)
  }

  /** Ends the call from our side: CANCEL while it rings, BYE once answered, a refusal if it's ringing in. */
  async hangUp(reason = 'you hung up'): Promise<void> {
    if (this.state === 'ended') return
    if (this.direction === 'in' && this.state === 'ringing') return this.decline(480, 'Temporarily Unavailable')
    if (this.direction === 'out' && this.state !== 'active') {
      this.end(reason)
      if (this.invite) {
        const inv = this.invite
        // CANCEL: the INVITE's own Via (branch), Request-URI, From, To, Call-ID and CSeq number.
        this.line.send(request('CANCEL', inv.uri!, [['Via', header(inv, 'via')], ['Max-Forwards', '70'], ['From', header(inv, 'from')], ['To', header(inv, 'to')], ['Call-ID', this.callId], ['CSeq', `${cseqOf(inv).seq} CANCEL`]]))
      }
      return
    }
    this.end(reason)
    await this.sendBye()
  }

  private async sendBye(): Promise<void> {
    await this.line.sendWithAuth((auth) => this.inDialog('BYE', auth)).catch(() => {})
  }

  private inDialog(method: string, extra: [string, string][] = [], body = '', seq?: number): SipMessage {
    const to = this.remoteTag && !tagOf(this.remoteUri) ? `${this.remoteUri};tag=${this.remoteTag}` : this.remoteUri
    return request(
      method,
      this.remoteTarget,
      [
        ['Via', this.line.via()],
        ['Max-Forwards', '70'],
        ...this.routeSet.map((r) => ['Route', r] as [string, string]),
        ['From', this.localUri],
        ['To', to],
        ['Call-ID', this.callId],
        ['CSeq', `${seq ?? ++this.cseq} ${method}`],
        ['User-Agent', USER_AGENT],
        ...extra,
      ],
      body,
    )
  }

  end(reason: string): void {
    if (this.state === 'ended') return
    if (this.okRetransmit) clearTimeout(this.okRetransmit)
    this.endReason = reason
    this.endedAt = Date.now()
    this.state = 'ended'
    this.rtp?.close()
    // Kept a little while: a late BYE or a retransmitted 200 still finds it.
    setTimeout(() => this.line.calls.delete(this.callId), TRANSACTION_TIMEOUT)
    this.emit('state', 'ended')
  }
}

function failureReason(status: number, reason: string): string {
  if (status === 486 || status === 600) return 'busy'
  if (status === 487) return 'cancelled'
  if (status === 603) return 'declined'
  if (status === 404 || status === 484) return 'not a valid number'
  if (status === 480 || status === 408) return 'no answer'
  if (status === 403) return `refused by the provider (403${reason ? ` ${reason}` : ''})`
  return `failed (${status}${reason ? ` ${reason}` : ''})`
}

/** The local address the route to `remote` goes out of (no packet is sent). */
async function routeAddress(remote: string): Promise<string> {
  const s = dgram.createSocket('udp4')
  try {
    await new Promise<void>((resolve) => s.connect(5060, remote, resolve))
    return s.address().address
  } finally {
    s.close()
  }
}
