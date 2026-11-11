// The owner's contacts (docs/contacts.md): people with their emails and phone
// numbers, and suggestions (addresses other plugins have seen, waiting for
// the owner to accept, ignore or add to someone). SQLite in the plugin's data
// folder (DATA_DIR/plugins/contacts/contacts.db).

import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export interface Labeled {
  value: string
  label: string
}

export interface Contact {
  id: string
  name: string
  org: string
  notes: string
  birthday: string
  tags: string[]
  emails: Labeled[]
  /** E.164 digits ("16135550123") when North American, else as given (digits and +). */
  phones: Labeled[]
  createdAt: string
  updatedAt: string
}

export interface Suggestion {
  address: string
  name: string
  source: string
  status: 'new' | 'ignored' | 'accepted'
  /** Why it was set aside, if it was ignored automatically. */
  reason: string
  firstSeen: string
}

export type ContactInput = Partial<Omit<Contact, 'id' | 'createdAt' | 'updatedAt'>> & { name: string }

/** "613-555-0123", "+1 (613) 555 0123" → "16135550123"; other countries: digits with their +. */
export function normalisePhone(raw: string): string {
  const s = raw.trim()
  const digits = s.replace(/\D/g, '')
  if (!digits) return ''
  if (s.startsWith('+')) return digits.startsWith('1') && digits.length === 11 ? digits : `+${digits}`
  if (digits.length === 10) return `1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return digits
  if (s.startsWith('011')) return `+${digits.slice(3)}`
  return digits
}

/** "16135550123" → "+1 613-555-0123". */
export function displayPhone(n: string): string {
  const m = /^1(\d{3})(\d{3})(\d{4})$/.exec(n)
  return m ? `+1 ${m[1]}-${m[2]}-${m[3]}` : n
}

export function normaliseEmail(raw: string): string {
  const s = raw.trim().toLowerCase()
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : ''
}

/** Senders that are machines, not people: set aside, not suggested. */
const AUTOMATED = /^(no-?reply|do-?not-?reply|noreply|notifications?|notify|notices?|mailer-daemon|postmaster|bounces?|alerts?|automated|auto-?confirm|updates?|news(letter)?|marketing|promo(tions)?|deals|billing|receipts?|invoices?|support-?noreply|digest|calendar-notification)([+._-].*)?@/i

export function automatedReason(address: string): string {
  if (AUTOMATED.test(address)) return 'an automated sender'
  if (/@(bounce|mail|email|em|e|click|news|mailer|notify|notifications)\d*\.[^.]+\.[a-z]+$/i.test(address) && /[0-9a-f]{12,}/i.test(address)) return 'a mailing system'
  return ''
}

const json = (v: unknown) => JSON.stringify(v)
const parse = <T>(s: unknown, fallback: T): T => {
  try {
    return s ? (JSON.parse(String(s)) as T) : fallback
  } catch {
    return fallback
  }
}

export class ContactStore {
  private readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, org TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        birthday TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS emails (
        address TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, label TEXT NOT NULL DEFAULT '', pos INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS phones (
        number TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, label TEXT NOT NULL DEFAULT '', pos INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (number, contact_id)
      );
      CREATE TABLE IF NOT EXISTS suggestions (
        address TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new',
        reason TEXT NOT NULL DEFAULT '', first_seen TEXT NOT NULL
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  get(id: string): Contact | null {
    const r = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Record<string, string> | undefined
    if (!r) return null
    const emails = this.db.prepare('SELECT address, label FROM emails WHERE contact_id = ? ORDER BY pos').all(id) as { address: string; label: string }[]
    const phones = this.db.prepare('SELECT number, label FROM phones WHERE contact_id = ? ORDER BY pos').all(id) as { number: string; label: string }[]
    return {
      id: r.id!,
      name: r.name!,
      org: r.org ?? '',
      notes: r.notes ?? '',
      birthday: r.birthday ?? '',
      tags: parse(r.tags, []),
      emails: emails.map((e) => ({ value: String(e.address), label: String(e.label) })),
      phones: phones.map((p) => ({ value: String(p.number), label: String(p.label) })),
      createdAt: r.created_at!,
      updatedAt: r.updated_at!,
    }
  }

  /** Saves a contact (new without an id). An email already on someone else moves to this one. */
  save(input: ContactInput & { id?: string }): Contact {
    const name = input.name.trim().slice(0, 120)
    if (!name) throw new Error('A contact needs a name.')
    const now = new Date().toISOString()
    const existing = input.id ? this.get(input.id) : null
    const id = existing?.id ?? input.id ?? crypto.randomUUID()
    const c = {
      org: input.org ?? existing?.org ?? '',
      notes: input.notes ?? existing?.notes ?? '',
      birthday: input.birthday ?? existing?.birthday ?? '',
      tags: input.tags ?? existing?.tags ?? [],
      emails: input.emails ?? existing?.emails ?? [],
      phones: input.phones ?? existing?.phones ?? [],
    }
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare('INSERT INTO contacts (id, name, org, notes, birthday, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, org = excluded.org, notes = excluded.notes, birthday = excluded.birthday, tags = excluded.tags, updated_at = excluded.updated_at')
        .run(id, name, c.org.trim().slice(0, 120), c.notes.slice(0, 4000), c.birthday.trim().slice(0, 20), json([...new Set(c.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20)), existing?.createdAt ?? now, now)
      this.db.prepare('DELETE FROM emails WHERE contact_id = ?').run(id)
      this.db.prepare('DELETE FROM phones WHERE contact_id = ?').run(id)
      c.emails.forEach((e, pos) => {
        const address = normaliseEmail(e.value)
        if (!address) return
        this.db.prepare('INSERT INTO emails (address, contact_id, label, pos) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET contact_id = excluded.contact_id, label = excluded.label, pos = excluded.pos').run(address, id, e.label.trim().slice(0, 30), pos)
        this.db.prepare("UPDATE suggestions SET status = 'accepted' WHERE address = ?").run(address)
      })
      c.phones.forEach((p, pos) => {
        const number = normalisePhone(p.value)
        if (number) this.db.prepare('INSERT OR REPLACE INTO phones (number, contact_id, label, pos) VALUES (?, ?, ?, ?)').run(number, id, p.label.trim().slice(0, 30), pos)
      })
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return this.get(id)!
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM contacts WHERE id = ?').run(id).changes > 0
  }

  /** By words in the name, organisation, notes, an email or a phone number; by name. */
  search(query = '', opts: { tag?: string; limit?: number; offset?: number } = {}): { total: number; contacts: Contact[] } {
    const where: string[] = []
    const args: (string | number)[] = []
    for (const word of query.split(/\s+/).filter(Boolean).slice(0, 6)) {
      const like = `%${word}%`
      const digits = word.replace(/\D/g, '')
      where.push(`(name LIKE ? OR org LIKE ? OR notes LIKE ? OR id IN (SELECT contact_id FROM emails WHERE address LIKE ?)${digits.length >= 3 ? ' OR id IN (SELECT contact_id FROM phones WHERE number LIKE ?)' : ''})`)
      args.push(like, like, like, like.toLowerCase())
      if (digits.length >= 3) args.push(`%${digits}%`)
    }
    if (opts.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)')
      args.push(opts.tag.trim().toLowerCase())
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM contacts ${clause}`).get(...args) as { n: number }).n)
    const ids = this.db.prepare(`SELECT id FROM contacts ${clause} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...args, Math.min(500, Math.max(1, opts.limit ?? 50)), Math.max(0, opts.offset ?? 0)) as { id: string }[]
    return { total, contacts: ids.map((r) => this.get(String(r.id))!) }
  }

  byEmail(address: string): Contact | null {
    const r = this.db.prepare('SELECT contact_id FROM emails WHERE address = ?').get(normaliseEmail(address)) as { contact_id: string } | undefined
    return r ? this.get(String(r.contact_id)) : null
  }

  byPhone(raw: string): Contact[] {
    const number = normalisePhone(raw)
    if (!number) return []
    const rows = this.db.prepare('SELECT DISTINCT contact_id FROM phones WHERE number = ?').all(number) as { contact_id: string }[]
    return rows.map((r) => this.get(String(r.contact_id))!)
  }

  // ------------------------------------------------------------------ suggestions

  /** An address another plugin saw: suggested (or set aside if it's a machine), unless it's known or already decided. Returns whether it's new. */
  suggest(address: string, name: string, source: string, at = new Date().toISOString()): boolean {
    const a = normaliseEmail(address)
    if (!a || this.byEmail(a)) return false
    if (this.db.prepare('SELECT 1 FROM suggestions WHERE address = ?').get(a)) return false
    const reason = automatedReason(a)
    this.db.prepare('INSERT INTO suggestions (address, name, source, status, reason, first_seen) VALUES (?, ?, ?, ?, ?, ?)').run(a, name.trim().slice(0, 120), source, reason ? 'ignored' : 'new', reason, at)
    return !reason
  }

  suggestions(status: Suggestion['status'] = 'new', limit = 200): Suggestion[] {
    const rows = this.db.prepare('SELECT * FROM suggestions WHERE status = ? ORDER BY first_seen DESC LIMIT ?').all(status, Math.min(1000, limit)) as Record<string, string>[]
    return rows.map((r) => ({ address: String(r.address), name: String(r.name), source: String(r.source), status: r.status as Suggestion['status'], reason: String(r.reason ?? ''), firstSeen: String(r.first_seen) }))
  }

  setSuggestion(address: string, status: Suggestion['status']): boolean {
    return this.db.prepare('UPDATE suggestions SET status = ? WHERE address = ?').run(status, normaliseEmail(address)).changes > 0
  }

  /** Accepts a suggestion: a new contact, or the address added to `contactId`. */
  accept(address: string, opts: { contactId?: string; name?: string } = {}): Contact {
    const a = normaliseEmail(address)
    const s = this.db.prepare('SELECT * FROM suggestions WHERE address = ?').get(a) as Record<string, string> | undefined
    const target = opts.contactId ? this.get(opts.contactId) : null
    if (opts.contactId && !target) throw new Error('No such contact.')
    const contact = target
      ? this.save({ ...target, emails: [...target.emails, { value: a, label: '' }] })
      : this.save({ name: opts.name?.trim() || s?.name || a.split('@')[0]!, emails: [{ value: a, label: '' }] })
    this.setSuggestion(a, 'accepted')
    return contact
  }

  stats(): { contacts: number; suggestions: number; ignored: number } {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n)
    return {
      contacts: n('SELECT count(*) AS n FROM contacts'),
      suggestions: n("SELECT count(*) AS n FROM suggestions WHERE status = 'new'"),
      ignored: n("SELECT count(*) AS n FROM suggestions WHERE status = 'ignored'"),
    }
  }

  tags(): { tag: string; count: number }[] {
    const rows = this.db.prepare('SELECT value AS tag, count(*) AS count FROM contacts, json_each(contacts.tags) GROUP BY value ORDER BY count DESC').all() as { tag: string; count: number }[]
    return rows.map((r) => ({ tag: String(r.tag), count: Number(r.count) }))
  }
}
