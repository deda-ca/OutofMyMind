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
  // 2: speaker recognition (docs/speaker-recognition.md).
  `
  -- What a conversation is: normal speech, or the owner training their voice.
  ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'conversation';  -- conversation | enrollment

  CREATE TABLE people (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    is_owner    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE UNIQUE INDEX people_one_owner ON people(is_owner) WHERE is_owner = 1;

  -- Every phrase's voiceprint, kept so libraries and groups can be rebuilt.
  CREATE TABLE phrase_voiceprints (
    phrase_id  INTEGER PRIMARY KEY REFERENCES phrases(id),
    model      TEXT NOT NULL,
    vector     BLOB NOT NULL               -- float32, L2-normalised
  );

  -- Each person's voice library: the phrases new speech is matched against.
  CREATE TABLE library (
    person_id  INTEGER NOT NULL REFERENCES people(id),
    phrase_id  INTEGER NOT NULL REFERENCES phrases(id),
    reason     TEXT NOT NULL,              -- enrollment | confirmed | adapted
    device     TEXT,
    added_at   TEXT NOT NULL,
    PRIMARY KEY (person_id, phrase_id)
  );

  -- Who said each phrase (current tag) …
  ALTER TABLE phrases ADD COLUMN speaker_id INTEGER REFERENCES people(id);
  ALTER TABLE phrases ADD COLUMN speaker_similarity REAL;
  ALTER TABLE phrases ADD COLUMN speaker_confidence TEXT;   -- high | low | uncertain

  -- … and every change to it, so training labels stay traceable.
  CREATE TABLE speaker_history (
    id          INTEGER PRIMARY KEY,
    phrase_id   INTEGER NOT NULL REFERENCES phrases(id),
    speaker_id  INTEGER REFERENCES people(id),
    similarity  REAL,
    confidence  TEXT,
    source      TEXT NOT NULL,             -- auto | owner
    changed_at  TEXT NOT NULL
  );
  CREATE INDEX speaker_history_phrase ON speaker_history(phrase_id);
  `,
  // 3: other people (M3). Unnamed voices are people rows labelled "Speaker A", "Speaker B", …
  `
  ALTER TABLE people ADD COLUMN named INTEGER NOT NULL DEFAULT 1;   -- 0 = automatic label ("Speaker A")
  ALTER TABLE people ADD COLUMN label_index INTEGER;                -- 1 = A, 2 = B, … (unnamed groups)
  ALTER TABLE people ADD COLUMN last_heard_at TEXT;
  CREATE INDEX phrases_speaker ON phrases(speaker_id);
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
