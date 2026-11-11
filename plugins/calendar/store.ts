// The local copy of the calendar (docs/calendar.md): every event object as the
// server has it (href, ETag, the iCalendar text), and which reminders have been
// given. SQLite in the plugin's data folder. The server is the truth: this is
// refreshed from it, and changes go to it first.

import { DatabaseSync } from 'node:sqlite'
import { occurrences, type Occurrence } from './events.ts'

export interface StoredObject {
  href: string
  etag: string
  uid: string
  ics: string
}

export class CalendarStore {
  private readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS objects (href TEXT PRIMARY KEY, etag TEXT NOT NULL, uid TEXT NOT NULL, ics TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS objects_uid ON objects (uid);
      CREATE TABLE IF NOT EXISTS reminded (key TEXT PRIMARY KEY, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
    `)
  }

  close(): void {
    this.db.close()
  }

  all(): StoredObject[] {
    return (this.db.prepare('SELECT href, etag, uid, ics FROM objects').all() as Record<string, string>[]).map((r) => ({ href: String(r.href), etag: String(r.etag), uid: String(r.uid), ics: String(r.ics) }))
  }

  etags(): Map<string, string> {
    return new Map((this.db.prepare('SELECT href, etag FROM objects').all() as { href: string; etag: string }[]).map((r) => [String(r.href), String(r.etag)]))
  }

  put(o: StoredObject): void {
    this.db.prepare('INSERT OR REPLACE INTO objects (href, etag, uid, ics) VALUES (?, ?, ?, ?)').run(o.href, o.etag, o.uid, o.ics)
  }

  remove(href: string): void {
    this.db.prepare('DELETE FROM objects WHERE href = ?').run(href)
  }

  byUid(uid: string): StoredObject | null {
    const r = this.db.prepare('SELECT href, etag, uid, ics FROM objects WHERE uid = ?').get(uid) as Record<string, string> | undefined
    return r ? { href: String(r.href), etag: String(r.etag), uid: String(r.uid), ics: String(r.ics) } : null
  }

  /** Every occurrence overlapping [from, to), all events, in order. */
  between(from: Date, to: Date): Occurrence[] {
    const out: Occurrence[] = []
    for (const o of this.all()) {
      try {
        out.push(...occurrences(o.ics, from, to))
      } catch {
        // an object the parser can't read: skipped (it stays on the server)
      }
    }
    return out.sort((a, b) => a.start.getTime() - b.start.getTime())
  }

  wasReminded(key: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM reminded WHERE key = ?').get(key))
  }

  markReminded(key: string): void {
    this.db.prepare('INSERT OR IGNORE INTO reminded (key, at) VALUES (?, ?)').run(key, new Date().toISOString())
    // Old ones aren't needed (a week back is plenty).
    this.db.prepare('DELETE FROM reminded WHERE at < ?').run(new Date(Date.now() - 7 * 86_400_000).toISOString())
  }

  getState(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined
    return r ? String(r.value) : null
  }

  setState(key: string, value: string): void {
    this.db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }
}
