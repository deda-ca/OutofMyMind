// Who gets put through (docs/phone.md, phase 2): the owner's rules for
// incoming calls, kept in DATA_DIR/phone/rules.json and edited in the Phone
// tab. Caller ID decides screening only, never trust: it can be faked, so
// the worst a faked number gets is being put through to the owner's cell.

import fs from 'node:fs'
import path from 'node:path'
import { sameNumber, toE164 } from './numbers.ts'

export interface Contact {
  number: string
  name: string
}

export interface PhoneRules {
  /** Who answers: Marvin (screens, then rings the owner's cell), or the owner's screens first (Marvin takes a message if nobody picks up). */
  answer: 'marvin' | 'screens'
  /** Put straight through to the owner's cell (Marvin still announces them), even in quiet hours. */
  always: Contact[]
  /** Turned away without answering. */
  blocked: Contact[]
  /** Quiet hours ("22:00" to "07:00", local time): everyone else leaves a message. Empty: none. */
  quietFrom: string
  quietTo: string
  /** Marvin says the call is recorded. Always on for US numbers (some states need everyone's consent). */
  recordingNotice: boolean
}

export const DEFAULT_RULES: PhoneRules = { answer: 'marvin', always: [], blocked: [], quietFrom: '', quietTo: '', recordingNotice: true }

export type Decision = 'block' | 'through' | 'screen' | 'message' | 'ring'

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/

function minutes(hhmm: string): number | null {
  const m = HHMM.exec(hhmm.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** Whether `now` (local time) is in the quiet hours (which may wrap past midnight). */
export function inQuietHours(rules: Pick<PhoneRules, 'quietFrom' | 'quietTo'>, now = new Date()): boolean {
  const from = minutes(rules.quietFrom)
  const to = minutes(rules.quietTo)
  if (from === null || to === null || from === to) return false
  const t = now.getHours() * 60 + now.getMinutes()
  return from < to ? t >= from && t < to : t >= from || t < to
}

export function findContact(list: Contact[], number: string): Contact | undefined {
  return list.find((c) => sameNumber(c.number, number))
}

/**
 * What happens to a call from `number`. Without the owner's cell, nobody can
 * be put through: Marvin takes messages.
 */
export function decide(rules: PhoneRules, number: string, opts: { ownerCell: string; now?: Date }): Decision {
  if (findContact(rules.blocked, number)) return 'block'
  if (rules.answer === 'screens') return 'ring'
  if (!opts.ownerCell) return 'message'
  if (findContact(rules.always, number)) return 'through'
  if (inQuietHours(rules, opts.now)) return 'message'
  return 'screen'
}

/** A US number (not Canadian): the recording notice is always given. Area codes in Canada, from the NANP list. */
const CANADA = new Set(
  '204 226 236 249 250 263 289 306 343 354 365 367 368 382 403 416 418 428 431 437 438 450 468 474 506 514 519 548 579 581 584 587 600 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905'.split(' '),
)
export function isUsNumber(number: string): boolean {
  const d = number.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 && !CANADA.has(d.slice(0, 3))
}

function cleanContacts(v: unknown): Contact[] {
  if (!Array.isArray(v)) return []
  const out: Contact[] = []
  for (const c of v) {
    if (!c || typeof c !== 'object') continue
    const raw = String((c as Contact).number ?? '').trim()
    if (!raw) continue
    let number: string
    try {
      number = toE164(raw).slice(1)
    } catch {
      number = raw.replace(/\D/g, '')
      if (!number) continue
    }
    out.push({ number, name: String((c as Contact).name ?? '').trim().slice(0, 80) })
  }
  return out.slice(0, 500)
}

/** Rules from anywhere (the file, the Phone tab), made safe; anything missing or wrong is the default. */
export function cleanRules(v: unknown): PhoneRules {
  const r = (v && typeof v === 'object' ? v : {}) as Partial<PhoneRules>
  const time = (t: unknown) => (typeof t === 'string' && HHMM.test(t.trim()) ? t.trim() : '')
  return {
    answer: r.answer === 'screens' ? 'screens' : 'marvin',
    always: cleanContacts(r.always),
    blocked: cleanContacts(r.blocked),
    quietFrom: time(r.quietFrom),
    quietTo: time(r.quietTo),
    recordingNotice: r.recordingNotice !== false,
  }
}

export class RulesStore {
  private readonly file: string
  private rules: PhoneRules

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'phone', 'rules.json')
    try {
      this.rules = cleanRules(JSON.parse(fs.readFileSync(this.file, 'utf8')))
    } catch {
      this.rules = { ...DEFAULT_RULES }
    }
  }

  get(): PhoneRules {
    return this.rules
  }

  set(v: unknown): PhoneRules {
    this.rules = cleanRules(v)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.rules, null, 1))
    fs.renameSync(tmp, this.file)
    return this.rules
  }
}
