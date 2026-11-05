// SQLite database (Node's built-in node:sqlite) with simple numbered migrations.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Each entry upgrades the schema by one version. Never edit a shipped one; append. */
const MIGRATIONS: string[] = [
  // 1: conversations and phrases.
  `
  CREATE TABLE conversations (
    id          INTEGER PRIMARY KEY,
    started_at  TEXT NOT NULL,           -- ISO 8601, first phrase
    ended_at    TEXT,                    -- ISO 8601, session closed
    device      TEXT NOT NULL,           -- client label, e.g. "web"
    user_agent  TEXT,
    keep        INTEGER NOT NULL DEFAULT 0,  -- 1 = never delete this conversation's audio
    keep_note   TEXT
  );

  CREATE TABLE phrases (
    id               INTEGER PRIMARY KEY,
    conversation_id  INTEGER NOT NULL REFERENCES conversations(id),
    seq              INTEGER NOT NULL,   -- phrase number within the conversation
    started_at       TEXT NOT NULL,      -- ISO 8601
    duration_ms      INTEGER NOT NULL,
    text             TEXT NOT NULL,
    status           TEXT NOT NULL,      -- ok | dropped (noise/empty) | error (transcription failed)
    language         TEXT,
    audio_path       TEXT,               -- relative to DATA_DIR; NULL if the audio was deleted
    audio_format     TEXT,
    audio_bytes      INTEGER,
    keep             INTEGER NOT NULL DEFAULT 0,  -- 1 = never delete this phrase's audio
    keep_note        TEXT,
    created_at       TEXT NOT NULL
  );

  CREATE INDEX phrases_conversation ON phrases(conversation_id, seq);
  CREATE INDEX conversations_started ON conversations(started_at);
  `,
]

export function openDatabase(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'jarvis.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let next = version; next < MIGRATIONS.length; next++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[next]!)
      db.exec(`PRAGMA user_version = ${next + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  return db
}
