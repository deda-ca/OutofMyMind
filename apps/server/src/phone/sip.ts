// SIP messages (RFC 3261): parsing, building, digest authentication, and the
// small SDP (RFC 4566) Jarvis offers and answers: one audio stream, PCMU and
// telephone-event. Only what VoIP.ms uses; no SIP over TCP or TLS yet.

import crypto from 'node:crypto'

export interface SipMessage {
  /** Requests: the method ("INVITE"). Responses: undefined. */
  method?: string
  /** Requests: the Request-URI. */
  uri?: string
  /** Responses: the status code and reason. */
  status?: number
  reason?: string
  /** Header name (lowercase, compact forms expanded) → values in order. */
  headers: Map<string, string[]>
  body: string
}

const COMPACT: Record<string, string> = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type', k: 'supported', e: 'content-encoding', s: 'subject' }
/** How headers are written (anything else as given). */
const CANONICAL: Record<string, string> = {
  via: 'Via', from: 'From', to: 'To', 'call-id': 'Call-ID', cseq: 'CSeq', contact: 'Contact', 'max-forwards': 'Max-Forwards', expires: 'Expires',
  'content-type': 'Content-Type', 'content-length': 'Content-Length', authorization: 'Authorization', 'proxy-authorization': 'Proxy-Authorization',
  'www-authenticate': 'WWW-Authenticate', 'proxy-authenticate': 'Proxy-Authenticate', 'user-agent': 'User-Agent', allow: 'Allow', supported: 'Supported',
  'record-route': 'Record-Route', route: 'Route', 'p-asserted-identity': 'P-Asserted-Identity', 'remote-party-id': 'Remote-Party-ID', event: 'Event',
}

export function parseSip(text: string): SipMessage | null {
  const split = text.indexOf('\r\n\r\n')
  const head = split < 0 ? text : text.slice(0, split)
  let body = split < 0 ? '' : text.slice(split + 4)
  // Folded header lines (continuations) join the line before.
  const lines = head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')
  const first = lines.shift()
  if (!first) return null
  const headers = new Map<string, string[]>()
  for (const line of lines) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    let name = line.slice(0, i).trim().toLowerCase()
    name = COMPACT[name] ?? name
    const value = line.slice(i + 1).trim()
    // Via, Contact, Route… may carry several comma-separated values; keep them as one entry each.
    const values = ['via', 'route', 'record-route'].includes(name) ? splitList(value) : [value]
    headers.set(name, [...(headers.get(name) ?? []), ...values])
  }
  const length = Number(headers.get('content-length')?.[0] ?? NaN)
  if (Number.isFinite(length)) body = Buffer.from(body, 'utf8').subarray(0, length).toString('utf8')
  const response = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/.exec(first)
  if (response) return { status: Number(response[1]), reason: response[2], headers, body }
  const request = /^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/.exec(first)
  if (request) return { method: request[1], uri: request[2], headers, body }
  return null
}

/** Splits on commas outside quotes and angle brackets. */
function splitList(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '"' && value[i - 1] !== '\\') quoted = !quoted
    else if (!quoted && c === '<') depth++
    else if (!quoted && c === '>') depth--
    else if (!quoted && depth === 0 && c === ',') {
      out.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(value.slice(start).trim())
  return out.filter(Boolean)
}

export function header(m: SipMessage, name: string): string {
  return m.headers.get(name.toLowerCase())?.[0] ?? ''
}

export function serialize(m: SipMessage): string {
  const first = m.method ? `${m.method} ${m.uri} SIP/2.0` : `SIP/2.0 ${m.status} ${m.reason ?? ''}`.trimEnd()
  const lines = [first]
  for (const [name, values] of m.headers) {
    if (name === 'content-length') continue
    for (const v of values) lines.push(`${CANONICAL[name] ?? name}: ${v}`)
  }
  lines.push(`Content-Length: ${Buffer.byteLength(m.body, 'utf8')}`)
  return `${lines.join('\r\n')}\r\n\r\n${m.body}`
}

export function request(method: string, uri: string, headers: [string, string][], body = ''): SipMessage {
  const map = new Map<string, string[]>()
  for (const [k, v] of headers) map.set(k.toLowerCase(), [...(map.get(k.toLowerCase()) ?? []), v])
  return { method, uri, headers: map, body }
}

/** A response to `req`: Via, From, To (with `toTag` if it has none), Call-ID and CSeq copied, as RFC 3261 says. */
export function response(req: SipMessage, status: number, reason: string, extra: [string, string][] = [], body = '', toTag?: string): SipMessage {
  const headers = new Map<string, string[]>()
  headers.set('via', req.headers.get('via') ?? [])
  if (req.headers.has('record-route')) headers.set('record-route', req.headers.get('record-route')!)
  headers.set('from', [header(req, 'from')])
  const to = header(req, 'to')
  headers.set('to', [toTag && !/;\s*tag=/i.test(to) ? `${to};tag=${toTag}` : to])
  headers.set('call-id', [header(req, 'call-id')])
  headers.set('cseq', [header(req, 'cseq')])
  for (const [k, v] of extra) headers.set(k.toLowerCase(), [...(headers.get(k.toLowerCase()) ?? []), v])
  return { status, reason, headers, body }
}

// ------------------------------------------------------------------ addresses and parameters

export function tagOf(nameAddr: string): string | undefined {
  return /;\s*tag=([^;>\s]+)/i.exec(nameAddr)?.[1]
}

/** The URI inside a name-addr ("Bob" <sip:bob@x>;tag=1 → sip:bob@x), or the value itself. */
export function uriOf(nameAddr: string): string {
  const angled = /<([^>]+)>/.exec(nameAddr)
  return (angled ? angled[1]! : nameAddr.split(';')[0]!).trim()
}

/** The user part of a SIP URI (sip:6135550123@host → 6135550123). */
export function userOf(uri: string): string {
  return /^sips?:([^@;>]+)@/i.exec(uriOf(uri))?.[1] ?? ''
}

/** The display name of a name-addr, if any ("Dr Smith" <sip:…>). */
export function displayNameOf(nameAddr: string): string {
  const quoted = /^\s*"((?:[^"\\]|\\.)*)"/.exec(nameAddr)
  if (quoted) return quoted[1]!.replace(/\\(.)/g, '$1')
  const bare = /^\s*([^<"]+?)\s*</.exec(nameAddr)
  return bare ? bare[1]! : ''
}

export function param(value: string, name: string): string | undefined {
  const m = new RegExp(`;\\s*${name}(?:=([^;,\\s>]*))?`, 'i').exec(value)
  return m ? (m[1] ?? '') : undefined
}

export function cseqOf(m: SipMessage): { seq: number; method: string } {
  const [seq, method] = header(m, 'cseq').split(/\s+/)
  return { seq: Number(seq), method: (method ?? '').toUpperCase() }
}

export const randomToken = (bytes = 6) => crypto.randomBytes(bytes).toString('hex')
export const newBranch = () => `z9hG4bK${randomToken(8)}`

// ------------------------------------------------------------------ digest authentication (RFC 2617 / 7616, MD5)

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')

export function parseChallenge(value: string): Record<string, string> {
  return Object.fromEntries([...value.replace(/^\s*Digest\s+/i, '').matchAll(/([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g)].map((x) => [x[1]!.toLowerCase(), x[2] ?? x[3]!]))
}

/** The Authorization (or Proxy-Authorization) value answering `challenge`. */
export function digestAuthorization(o: { challenge: string; method: string; uri: string; username: string; password: string; cnonce?: string; nc?: number }): string {
  const c = parseChallenge(o.challenge)
  if (c.algorithm && c.algorithm.toUpperCase() !== 'MD5') throw new Error(`unsupported digest algorithm ${c.algorithm}`)
  const ha1 = md5(`${o.username}:${c.realm}:${o.password}`)
  const ha2 = md5(`${o.method}:${o.uri}`)
  const qop = c.qop?.split(',').map((s) => s.trim()).includes('auth') ? 'auth' : undefined
  const nc = (o.nc ?? 1).toString(16).padStart(8, '0')
  const cnonce = o.cnonce ?? randomToken(8)
  const response = qop ? md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${c.nonce}:${ha2}`)
  return [
    `Digest username="${o.username}"`,
    `realm="${c.realm}"`,
    `nonce="${c.nonce}"`,
    `uri="${o.uri}"`,
    `response="${response}"`,
    'algorithm=MD5',
    ...(c.opaque ? [`opaque="${c.opaque}"`] : []),
    ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []),
  ].join(', ')
}

// ------------------------------------------------------------------ SDP

export const PCMU = 0
export const DTMF_PAYLOAD = 101

export function buildSdp(o: { ip: string; port: number; sessionId: string; version?: number }): string {
  return [
    'v=0',
    `o=jarvis ${o.sessionId} ${o.version ?? 1} IN IP4 ${o.ip}`,
    's=Jarvis',
    `c=IN IP4 ${o.ip}`,
    't=0 0',
    `m=audio ${o.port} RTP/AVP ${PCMU} ${DTMF_PAYLOAD}`,
    `a=rtpmap:${PCMU} PCMU/8000`,
    `a=rtpmap:${DTMF_PAYLOAD} telephone-event/8000`,
    `a=fmtp:${DTMF_PAYLOAD} 0-16`,
    'a=ptime:20',
    'a=sendrecv',
    '',
  ].join('\r\n')
}

export interface RemoteMedia {
  ip: string
  port: number
  /** The payload type the other side uses for telephone-event, if it offered one. */
  dtmfPayload?: number
  /** Whether PCMU is among its formats. */
  pcmu: boolean
  /** a=sendonly / inactive: the other side put the call on hold. */
  onHold: boolean
}

export function parseSdp(sdp: string): RemoteMedia | null {
  const lines = sdp.split(/\r?\n/)
  let ip = ''
  let port = 0
  let formats: number[] = []
  let dtmfPayload: number | undefined
  let onHold = false
  let inAudio = false
  for (const line of lines) {
    if (line.startsWith('c=IN IP4 ')) ip = line.slice(9).trim().split('/')[0]!
    else if (line.startsWith('m=')) {
      inAudio = line.startsWith('m=audio ')
      if (inAudio) {
        const parts = line.split(/\s+/)
        port = Number(parts[1])
        formats = parts.slice(3).map(Number)
      }
    } else if (inAudio && /^a=rtpmap:(\d+) telephone-event\//i.test(line)) dtmfPayload = Number(/^a=rtpmap:(\d+)/.exec(line)![1])
    else if (inAudio && /^a=(sendonly|inactive)$/.test(line)) onHold = true
  }
  if (!ip || !port) return null
  if (ip === '0.0.0.0') onHold = true
  return { ip, port, pcmu: formats.includes(PCMU), onHold, ...(dtmfPayload !== undefined ? { dtmfPayload } : {}) }
}
