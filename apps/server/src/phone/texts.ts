// Texts (SMS) on Jarvis's number through the VoIP.ms REST API (docs/phone.md,
// phase 3): sendSMS to send, getSMS polled for what arrives (no webhook, so
// nothing listens on the internet). Kept in DATA_DIR/phone/texts.json.
// A text that arrives is from outside: shown to the owner, and noted in the
// session as information, never as instructions.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

const API = 'https://voip.ms/api/v1/rest.php'
/** VoIP.ms takes at most 160 characters per SMS. */
const PART = 160
const KEEP = 1000

export class TextError extends Error {}

export interface Text {
  id: string
  direction: 'in' | 'out'
  /** The other party, 10 digits. */
  contact: string
  message: string
  at: string
}

export interface TextsOptions {
  apiUser: string
  apiPassword: string
  /** Jarvis's number, 10 digits. */
  did: string
  dataDir: string
  pollSeconds: number
  dailyLimit: number
  log: (message: string, err?: unknown) => void
  /** A new text arrived. */
  onIncoming: (text: Text) => void
  fetch?: typeof fetch
}

export class Texts extends EventEmitter<{ change: [] }> {
  private readonly o: TextsOptions
  private readonly file: string
  private list: Text[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The last problem talking to the API (shown on the Phone tab), or ''. */
  error = ''
  private stopped = false

  constructor(o: TextsOptions) {
    super()
    this.o = o
    this.file = path.join(o.dataDir, 'phone', 'texts.json')
    try {
      this.list = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Text[]
    } catch {
      // none yet
    }
  }

  start(): void {
    this.stopped = false
    void this.poll()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  recent(limit = 50): Text[] {
    return this.list.slice(0, limit)
  }

  sentToday(now = new Date()): number {
    const day = now.toDateString()
    return this.list.filter((t) => t.direction === 'out' && new Date(t.at).toDateString() === day).length
  }

  private async api(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({ api_username: this.o.apiUser, api_password: this.o.apiPassword, method, ...params })
    const res = await (this.o.fetch ?? fetch)(`${API}?${q}`)
    const body = (await res.json().catch(() => ({ status: `HTTP ${res.status}` }))) as Record<string, unknown>
    if (body.status !== 'success' && body.status !== 'no_sms') throw new TextError(explain(String(body.status)))
    return body
  }

  /** Sends `message` to `to` (10 digits), in 160-character parts. */
  async send(to: string, message: string): Promise<Text> {
    const text = message.trim()
    if (!text) throw new TextError('The text is empty.')
    if (text.length > PART * 6) throw new TextError(`Too long: at most ${PART * 6} characters.`)
    if (this.o.dailyLimit > 0 && this.sentToday() >= this.o.dailyLimit) throw new TextError(`Today's ${this.o.dailyLimit} texts are used up (PHONE_DAILY_TEXTS).`)
    const ids: string[] = []
    for (const part of split(text)) {
      const body = await this.api('sendSMS', { did: this.o.did, dst: to, message: part })
      ids.push(String(body.sms ?? ''))
    }
    const sent: Text = { id: `out-${ids.join('-') || Date.now()}`, direction: 'out', contact: to, message: text, at: new Date().toISOString() }
    this.add([sent])
    return sent
  }

  /** Fetches texts received in the last two days; new ones are kept and reported. */
  async poll(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    let wait = this.o.pollSeconds
    try {
      const from = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)
      const body = await this.api('getSMS', { from, type: '1', did: this.o.did, limit: '100' })
      const known = new Set(this.list.map((t) => t.id))
      const fresh = ((body.sms as Record<string, string>[] | undefined) ?? [])
        .filter((s) => s.id && !known.has(`in-${s.id}`))
        .map((s): Text => ({ id: `in-${s.id}`, direction: 'in', contact: String(s.contact ?? ''), message: String(s.message ?? ''), at: parseDate(s.date) }))
        .sort((a, b) => a.at.localeCompare(b.at))
      // The first poll ever only learns what's already there: those aren't news.
      const first = this.list.length === 0 && !fs.existsSync(this.file)
      if (fresh.length) this.add(fresh)
      if (!first) for (const t of fresh) this.o.onIncoming(t)
      if (this.error) {
        this.error = ''
        this.emit('change')
      }
    } catch (err) {
      const message = (err as Error).message
      if (message !== this.error) this.o.log(`phone: texts: ${message}`)
      if (message !== this.error) {
        this.error = message
        this.emit('change')
      }
      wait = Math.max(wait, 300)
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), wait * 1000)
  }

  private add(texts: Text[]): void {
    this.list = [...texts.reverse(), ...this.list].slice(0, KEEP)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.list, null, 1))
    fs.renameSync(tmp, this.file)
    this.emit('change')
  }
}

/** Splits at word boundaries into parts of at most 160 characters. */
export function split(text: string): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > PART) {
    let cut = rest.lastIndexOf(' ', PART)
    if (cut < PART / 2) cut = PART
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

/** VoIP.ms dates ("2026-11-11 09:30:00", the account's time zone) → ISO; taken as local time. */
function parseDate(value: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value ?? '')
  if (!m) return new Date().toISOString()
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).toISOString()
}

function explain(status: string): string {
  if (status === 'ip_not_enabled') return 'VoIP.ms refused the API call: add this machine\'s public IP to the allowed IPs on the API page (Main Menu → SOAP and REST/JSON API).'
  if (status === 'invalid_credentials' || status === 'missing_credentials') return 'VoIP.ms refused the API login: check VOIPMS_API_USER (your login email) and VOIPMS_API_PASSWORD (the API password).'
  if (status === 'api_not_enabled') return 'The VoIP.ms API is off: enable it on the API page.'
  if (status === 'sms_toolong') return 'The text is too long for one SMS.'
  if (status === 'invalid_dst') return 'VoIP.ms says that number can\'t receive texts.'
  if (status === 'invalid_did' || status === 'sms_failed') return `VoIP.ms couldn't send it (${status}): is SMS enabled on the number?`
  return `VoIP.ms API: ${status}`
}
