// The local copy of the owner's email (docs/email.md): every message received
// and sent, with its tags, every address seen (the start of contacts), and
// drafts. SQLite in the plugin's data folder (DATA_DIR/plugins/email/mail.db).
// Tags and drafts are local: nothing here changes the mail server.

import { DatabaseSync } from 'node:sqlite'

export interface Address {
  address: string
  name: string
}

export interface StoredMessage {
  /** "in-<uidvalidity>-<uid>" for received mail, "out-<time>" for sent. */
  id: string
  direction: 'in' | 'out'
  uid: number | null
  messageId: string
  inReplyTo: string
  references: string[]
  date: string
  from: Address
  replyTo: Address[]
  to: Address[]
  cc: Address[]
  subject: string
  text: string
  /** The HTML part, if any (shown sandboxed in the tab, remote images blocked). */
  html: string
  snippet: string
  seen: boolean
  tags: string[]
  attachments: { name: string; type: string; size: number; file: string }[]
  /** The original message, relative to the data folder. */
  eml: string
  /** The Markdown copy, relative to the workspace. */
  md: string
}

export interface Draft {
  id: string
  to: Address[]
  cc: Address[]
  subject: string
  body: string
  /** The message it replies to (threading), if any. */
  replyTo: string
  createdAt: string
  updatedAt: string
  status: 'draft' | 'sent'
  sentId: string
}

export interface Query {
  text?: string
  from?: string
  tag?: string
  unread?: boolean
  direction?: 'in' | 'out'
  since?: string
  until?: string
  limit?: number
  offset?: number
}

export interface KnownAddress extends Address {
  fromCount: number
  toCount: number
  firstSeen: string
  lastSeen: string
}

const json = (v: unknown) => JSON.stringify(v)
const parse = <T>(s: unknown, fallback: T): T => {
  try {
    return s ? (JSON.parse(String(s)) as T) : fallback
  } catch {
    return fallback
  }
}

/** A tag as stored: lowercase words joined by "-" ("To reply" → "to-reply"). */
export function cleanTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

export class Store {
  private readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, direction TEXT NOT NULL, uid INTEGER, message_id TEXT, in_reply_to TEXT, refs TEXT,
        date TEXT NOT NULL, from_addr TEXT, from_name TEXT, reply_to TEXT, to_json TEXT, cc_json TEXT, subject TEXT,
        text TEXT, html TEXT, snippet TEXT, seen INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
        attachments TEXT NOT NULL DEFAULT '[]', eml TEXT, md TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_date ON messages (date DESC);
      CREATE INDEX IF NOT EXISTS messages_message_id ON messages (message_id);
      CREATE TABLE IF NOT EXISTS addresses (
        address TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', from_count INTEGER NOT NULL DEFAULT 0,
        to_count INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, to_json TEXT, cc_json TEXT, subject TEXT, body TEXT, reply_to TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', sent_id TEXT
      );
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
    `)
  }

  close(): void {
    this.db.close()
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setState(key: string, value: string): void {
    this.db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  has(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id))
  }

  /** Saves a message (replacing one with the same id) and counts its addresses. Returns the addresses seen for the first time. */
  save(m: StoredMessage): Address[] {
    const existed = this.has(m.id)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO messages (id, direction, uid, message_id, in_reply_to, refs, date, from_addr, from_name, reply_to, to_json, cc_json, subject, text, html, snippet, seen, tags, attachments, eml, md)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, m.direction, m.uid, m.messageId, m.inReplyTo, json(m.references), m.date, m.from.address, m.from.name, json(m.replyTo), json(m.to), json(m.cc), m.subject, m.text, m.html, m.snippet, m.seen ? 1 : 0, json(m.tags), json(m.attachments), m.eml, m.md)
    if (existed) return []
    const fresh: Address[] = []
    const count = (a: Address, column: 'from_count' | 'to_count') => {
      const address = a.address.trim().toLowerCase()
      if (!address.includes('@')) return
      const known = this.db.prepare('SELECT name FROM addresses WHERE address = ?').get(address) as { name: string } | undefined
      if (!known) {
        this.db.prepare(`INSERT INTO addresses (address, name, ${column}, first_seen, last_seen) VALUES (?, ?, 1, ?, ?)`).run(address, a.name.trim(), m.date, m.date)
        fresh.push({ address, name: a.name.trim() })
      } else {
        this.db.prepare(`UPDATE addresses SET ${column} = ${column} + 1, last_seen = max(last_seen, ?), name = CASE WHEN name = '' THEN ? ELSE name END WHERE address = ?`).run(m.date, a.name.trim(), address)
      }
    }
    // Received: the sender wrote to the owner. Sent: the owner wrote to them.
    if (m.direction === 'in') count(m.from, 'from_count')
    else for (const a of [...m.to, ...m.cc]) count(a, 'to_count')
    if (m.direction === 'in') for (const a of m.cc) count(a, 'from_count')
    return fresh
  }

  get(id: string): StoredMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    return row ? toMessage(row as Row) : null
  }

  byMessageId(messageId: string): StoredMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE message_id = ? ORDER BY date DESC LIMIT 1').get(messageId)
    return row ? toMessage(row as Row) : null
  }

  /** Newest first. Words match the subject, the sender and the text. */
  search(q: Query = {}): { total: number; messages: StoredMessage[] } {
    const where: string[] = []
    const args: (string | number)[] = []
    for (const word of (q.text ?? '').split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push('(subject LIKE ? OR from_addr LIKE ? OR from_name LIKE ? OR text LIKE ? OR to_json LIKE ?)')
      const like = `%${word}%`
      args.push(like, like, like, like, like)
    }
    if (q.from) {
      where.push('(from_addr LIKE ? OR from_name LIKE ?)')
      args.push(`%${q.from}%`, `%${q.from}%`)
    }
    if (q.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(messages.tags) WHERE value = ?)')
      args.push(cleanTag(q.tag))
    }
    if (q.unread) where.push("seen = 0 AND direction = 'in'")
    if (q.direction) {
      where.push('direction = ?')
      args.push(q.direction)
    }
    if (q.since) {
      where.push('date >= ?')
      args.push(q.since)
    }
    if (q.until) {
      where.push('date < ?')
      args.push(q.until)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (this.db.prepare(`SELECT count(*) AS n FROM messages ${clause}`).get(...args) as { n: number }).n
    const limit = Math.min(200, Math.max(1, q.limit ?? 20))
    const rows = this.db.prepare(`SELECT * FROM messages ${clause} ORDER BY date DESC LIMIT ? OFFSET ?`).all(...args, limit, Math.max(0, q.offset ?? 0))
    return { total, messages: (rows as Row[]).map(toMessage) }
  }

  /** Every tag in use, with how many messages have it. */
  tags(): { tag: string; count: number }[] {
    const rows = this.db.prepare('SELECT value AS tag, count(*) AS count FROM messages, json_each(messages.tags) GROUP BY value ORDER BY count DESC').all() as { tag: string; count: number }[]
    return rows.map((r) => ({ tag: String(r.tag), count: Number(r.count) }))
  }

  setTags(id: string, add: string[], remove: string[]): string[] | null {
    const m = this.get(id)
    if (!m) return null
    const drop = new Set(remove.map(cleanTag))
    const tags = [...new Set([...m.tags.filter((t) => !drop.has(t)), ...add.map(cleanTag).filter(Boolean)])].slice(0, 30)
    this.db.prepare('UPDATE messages SET tags = ? WHERE id = ?').run(json(tags), id)
    return tags
  }

  setSeen(id: string, seen: boolean): void {
    this.db.prepare('UPDATE messages SET seen = ? WHERE id = ?').run(seen ? 1 : 0, id)
  }

  addresses(query = '', limit = 50): KnownAddress[] {
    const like = `%${query.trim()}%`
    const rows = this.db
      .prepare('SELECT * FROM addresses WHERE address LIKE ? OR name LIKE ? ORDER BY (from_count + to_count) DESC, last_seen DESC LIMIT ?')
      .all(like, like, Math.min(500, Math.max(1, limit))) as { address: string; name: string; from_count: number; to_count: number; first_seen: string; last_seen: string }[]
    return rows.map((r) => ({ address: r.address, name: r.name, fromCount: r.from_count, toCount: r.to_count, firstSeen: r.first_seen, lastSeen: r.last_seen }))
  }

  saveDraft(d: Omit<Draft, 'createdAt' | 'updatedAt' | 'status' | 'sentId'> & Partial<Pick<Draft, 'status' | 'sentId'>>): Draft {
    const now = new Date().toISOString()
    const existing = this.draft(d.id)
    this.db
      .prepare('INSERT OR REPLACE INTO drafts (id, to_json, cc_json, subject, body, reply_to, created_at, updated_at, status, sent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.id, json(d.to), json(d.cc), d.subject, d.body, d.replyTo, existing?.createdAt ?? now, now, d.status ?? existing?.status ?? 'draft', d.sentId ?? existing?.sentId ?? '')
    return this.draft(d.id)!
  }

  draft(id: string): Draft | null {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Record<string, string> | undefined
    if (!r) return null
    return { id: r.id!, to: parse(r.to_json, []), cc: parse(r.cc_json, []), subject: r.subject ?? '', body: r.body ?? '', replyTo: r.reply_to ?? '', createdAt: r.created_at!, updatedAt: r.updated_at!, status: r.status === 'sent' ? 'sent' : 'draft', sentId: r.sent_id ?? '' }
  }

  drafts(): Draft[] {
    const ids = this.db.prepare("SELECT id FROM drafts WHERE status = 'draft' ORDER BY updated_at DESC LIMIT 100").all() as { id: string }[]
    return ids.map((r) => this.draft(r.id)!)
  }

  deleteDraft(id: string): boolean {
    return this.db.prepare("DELETE FROM drafts WHERE id = ? AND status = 'draft'").run(id).changes > 0
  }

  stats(): { messages: number; unread: number; addresses: number; drafts: number } {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n
    return {
      messages: n('SELECT count(*) AS n FROM messages'),
      unread: n("SELECT count(*) AS n FROM messages WHERE seen = 0 AND direction = 'in'"),
      addresses: n('SELECT count(*) AS n FROM addresses'),
      drafts: n("SELECT count(*) AS n FROM drafts WHERE status = 'draft'"),
    }
  }
}

type Row = Record<string, unknown>

function toMessage(r: Row): StoredMessage {
  return {
    id: String(r.id),
    direction: r.direction === 'out' ? 'out' : 'in',
    uid: typeof r.uid === 'number' ? r.uid : r.uid === null ? null : Number(r.uid),
    messageId: String(r.message_id ?? ''),
    inReplyTo: String(r.in_reply_to ?? ''),
    references: parse(r.refs, []),
    date: String(r.date),
    from: { address: String(r.from_addr ?? ''), name: String(r.from_name ?? '') },
    replyTo: parse(r.reply_to, []),
    to: parse(r.to_json, []),
    cc: parse(r.cc_json, []),
    subject: String(r.subject ?? ''),
    text: String(r.text ?? ''),
    html: String(r.html ?? ''),
    snippet: String(r.snippet ?? ''),
    seen: r.seen === 1,
    tags: parse(r.tags, []),
    attachments: parse(r.attachments, []),
    eml: String(r.eml ?? ''),
    md: String(r.md ?? ''),
  }
}
