// The conversation archive: every phrase's transcript in SQLite and its audio
// as a compressed .opus file. Nothing is deleted automatically; `keep` marks
// recordings a future clean-up must leave alone.

import fs from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { OPUS_FORMAT, encodeOggOpus } from './oggOpus.ts'

export type PhraseStatus = 'ok' | 'dropped' | 'error'
export type ConversationKind = 'conversation' | 'enrollment'

export interface PhraseRecord {
  id: number
  conversationId: number
  seq: number
  startedAt: string
  durationMs: number
  text: string
  status: PhraseStatus
  language: string | null
  hasAudio: boolean
  audioBytes: number | null
  keep: boolean
  keepNote: string | null
  /** Jarvis's reply to this phrase, if it answered. */
  reply: { kind: string; text: string } | null
  /** Who said it (null until speaker recognition has tagged it). */
  speaker: {
    speakerId: number | null
    name: string | null
    named: boolean
    isOwner: boolean | null
    similarity: number | null
    confidence: string
  } | null
}

export interface ConversationSummary {
  id: number
  kind: ConversationKind
  startedAt: string
  endedAt: string | null
  device: string
  keep: boolean
  keepNote: string | null
  phraseCount: number
  speechMs: number
  audioBytes: number
  /** Start of the first phrase with text, for the list view. */
  preview: string
}

const SAMPLE_RATE = 16000

export class Archive {
  private readonly db: DatabaseSync
  private readonly dataDir: string

  constructor(db: DatabaseSync, dataDir: string) {
    this.db = db
    this.dataDir = dataDir
  }

  /** One per live session. The conversation row is created at the first phrase, so silent sessions leave nothing behind. */
  recorder(device: string, userAgent: string | undefined, kind: ConversationKind = 'conversation'): ConversationRecorder {
    return new ConversationRecorder(this, device, userAgent, kind)
  }

  createConversation(startedAt: string, device: string, userAgent: string | undefined, kind: ConversationKind): number {
    const result = this.db
      .prepare('INSERT INTO conversations (started_at, device, user_agent, kind) VALUES (?, ?, ?, ?)')
      .run(startedAt, device, userAgent ?? null, kind)
    return Number(result.lastInsertRowid)
  }

  endConversation(id: number, endedAt: string): void {
    this.db.prepare('UPDATE conversations SET ended_at = ? WHERE id = ?').run(endedAt, id)
  }

  async savePhrase(phrase: {
    conversationId: number
    seq: number
    startedAt: string
    pcm: Int16Array
    text: string
    status: PhraseStatus
    language: string
  }): Promise<number> {
    const day = phrase.startedAt.slice(0, 10).replaceAll('-', '/')
    const relative = path.join('audio', day, `c${phrase.conversationId}-p${phrase.seq}.opus`)
    let audioPath: string | null = relative
    let audioBytes: number | null = null
    try {
      const file = await encodeOggOpus(phrase.pcm, {
        title: `Jarvis conversation ${phrase.conversationId}, phrase ${phrase.seq}`,
        date: phrase.startedAt,
      })
      await fs.mkdir(path.join(this.dataDir, path.dirname(relative)), { recursive: true })
      await fs.writeFile(path.join(this.dataDir, relative), file)
      audioBytes = file.length
    } catch (err) {
      // Keep the transcript even if the audio couldn't be written.
      audioPath = null
      console.error(`archive: could not save audio for ${relative}:`, err)
    }

    const result = this.db
      .prepare(
        `INSERT INTO phrases (conversation_id, seq, started_at, duration_ms, text, status, language,
                              audio_path, audio_format, audio_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        phrase.conversationId,
        phrase.seq,
        phrase.startedAt,
        Math.round((phrase.pcm.length / SAMPLE_RATE) * 1000),
        phrase.text,
        phrase.status,
        phrase.language || null,
        audioPath,
        audioPath ? OPUS_FORMAT : null,
        audioBytes,
        new Date().toISOString(),
      )
    return Number(result.lastInsertRowid)
  }

  listConversations(limit: number, before?: number): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.kind, c.started_at, c.ended_at, c.device, c.keep, c.keep_note,
                COUNT(p.id) AS phrase_count,
                COALESCE(SUM(p.duration_ms), 0) AS speech_ms,
                COALESCE(SUM(p.audio_bytes), 0) AS audio_bytes,
                (SELECT text FROM phrases WHERE conversation_id = c.id AND status = 'ok' ORDER BY seq LIMIT 1) AS preview
         FROM conversations c LEFT JOIN phrases p ON p.conversation_id = c.id
         WHERE (? IS NULL OR c.id < ?)
         GROUP BY c.id ORDER BY c.id DESC LIMIT ?`,
      )
      .all(before ?? null, before ?? null, limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind as ConversationKind,
      startedAt: String(r.started_at),
      endedAt: r.ended_at === null ? null : String(r.ended_at),
      device: String(r.device),
      keep: r.keep === 1,
      keepNote: r.keep_note === null ? null : String(r.keep_note),
      phraseCount: Number(r.phrase_count),
      speechMs: Number(r.speech_ms),
      audioBytes: Number(r.audio_bytes),
      preview: r.preview === null ? '' : String(r.preview),
    }))
  }

  conversationPhrases(conversationId: number): PhraseRecord[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, pe.is_owner AS speaker_is_owner, pe.name AS speaker_name, pe.named AS speaker_named,
                (SELECT kind FROM assistant_replies r WHERE r.phrase_id = p.id ORDER BY r.id DESC LIMIT 1) AS reply_kind,
                (SELECT text FROM assistant_replies r WHERE r.phrase_id = p.id ORDER BY r.id DESC LIMIT 1) AS reply_text
         FROM phrases p
         LEFT JOIN people pe ON pe.id = p.speaker_id
         WHERE p.conversation_id = ? ORDER BY p.seq`,
      )
      .all(conversationId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: Number(r.id),
      conversationId: Number(r.conversation_id),
      seq: Number(r.seq),
      startedAt: String(r.started_at),
      durationMs: Number(r.duration_ms),
      text: String(r.text),
      status: r.status as PhraseStatus,
      language: r.language === null ? null : String(r.language),
      hasAudio: r.audio_path !== null,
      audioBytes: r.audio_bytes === null ? null : Number(r.audio_bytes),
      keep: r.keep === 1,
      keepNote: r.keep_note === null ? null : String(r.keep_note),
      reply: r.reply_text === null || r.reply_text === undefined ? null : { kind: String(r.reply_kind), text: String(r.reply_text) },
      speaker:
        r.speaker_confidence === null
          ? null
          : {
              speakerId: r.speaker_id === null ? null : Number(r.speaker_id),
              name: r.speaker_is_owner === 1 ? 'You' : r.speaker_name === null ? null : String(r.speaker_name),
              named: r.speaker_named === 1,
              // No person and no similarity = nobody was enrolled yet: can't tell.
              isOwner: r.speaker_is_owner === 1 ? true : r.speaker_similarity === null && r.speaker_id === null ? null : false,
              similarity: r.speaker_similarity === null ? null : Number(r.speaker_similarity),
              confidence: String(r.speaker_confidence),
            },
    }))
  }

  /** Absolute path of a phrase's audio file, or null. Paths only ever come from the database. */
  phraseAudioPath(phraseId: number): string | null {
    const row = this.db.prepare('SELECT audio_path FROM phrases WHERE id = ?').get(phraseId) as
      | { audio_path: string | null }
      | undefined
    if (!row?.audio_path) return null
    const absolute = path.resolve(this.dataDir, row.audio_path)
    return absolute.startsWith(this.dataDir + path.sep) ? absolute : null
  }

  saveReply(reply: { conversationId: number | null; phraseId: number | null; kind: string; text: string; model: string | null; latencyMs: number | null }): void {
    this.db
      .prepare('INSERT INTO assistant_replies (conversation_id, phrase_id, kind, text, model, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(reply.conversationId, reply.phraseId, reply.kind, reply.text, reply.model, reply.latencyMs, new Date().toISOString())
  }

  /** Returns false if there is no such conversation. */
  setConversationKeep(id: number, keep: boolean, note: string | null): boolean {
    const result = this.db.prepare('UPDATE conversations SET keep = ?, keep_note = ? WHERE id = ?').run(keep ? 1 : 0, note, id)
    return result.changes > 0
  }

  /** Returns false if there is no such phrase. */
  setPhraseKeep(id: number, keep: boolean, note: string | null): boolean {
    const result = this.db.prepare('UPDATE phrases SET keep = ?, keep_note = ? WHERE id = ?').run(keep ? 1 : 0, note, id)
    return result.changes > 0
  }
}

/** Archives one live session's phrases as one conversation. */
export class ConversationRecorder {
  private conversationId?: number
  private readonly archive: Archive
  readonly device: string
  private readonly userAgent: string | undefined
  private readonly kind: ConversationKind

  constructor(archive: Archive, device: string, userAgent: string | undefined, kind: ConversationKind) {
    this.archive = archive
    this.device = device
    this.userAgent = userAgent
    this.kind = kind
  }

  async savePhrase(seq: number, startedAt: Date, pcm: Int16Array, text: string, status: PhraseStatus, language: string) {
    this.conversationId ??= this.archive.createConversation(startedAt.toISOString(), this.device, this.userAgent, this.kind)
    return this.archive.savePhrase({
      conversationId: this.conversationId,
      seq,
      startedAt: startedAt.toISOString(),
      pcm,
      text,
      status,
      language,
    })
  }

  saveReply(phraseId: number | null, kind: string, text: string, model: string | null, latencyMs: number | null): void {
    this.archive.saveReply({ conversationId: this.conversationId ?? null, phraseId, kind, text, model, latencyMs })
  }

  /** The archive's id for this conversation (once it has a phrase). */
  get id(): number | null {
    return this.conversationId ?? null
  }

  end(): void {
    if (this.conversationId !== undefined) this.archive.endConversation(this.conversationId, new Date().toISOString())
  }
}
