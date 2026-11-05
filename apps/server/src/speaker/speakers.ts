// Who is speaking: voiceprints, the owner's voice library, and phrase tags.
// Design: docs/speaker-recognition.md (milestone M2: know the owner).

import type { DatabaseSync } from 'node:sqlite'
import { VoiceprintModel, cosine, fromBlob, toBlob } from './voiceprint.ts'

export type Confidence = 'high' | 'low' | 'uncertain'

/** A phrase's speaker tag, as sent to clients and stored with the phrase. */
export interface SpeakerTag {
  /** Person id, or null when nobody is enrolled yet. */
  speakerId: number | null
  /** true = the owner; false = someone else; null = can't tell (nobody enrolled, or no voiceprint). */
  isOwner: boolean | null
  /** Best similarity to the owner's library (cosine), or null. */
  similarity: number | null
  confidence: Confidence
}

export interface OwnerClip {
  phraseId: number
  conversationId: number
  device: string | null
  addedAt: string
  text: string
  durationMs: number
}

/** Below this much speech a voiceprint is unreliable: the tag is "uncertain". */
const MIN_CONFIDENT_SPEECH_MS = 1000
/** Within this distance of the threshold the tag is "low" confidence. */
const LOW_CONFIDENCE_MARGIN = 0.1
/** Enrollment: a new clip must be at least this close (threshold minus this) to the clips so far. */
const ENROLL_CONSISTENCY_MARGIN = 0.1

export class Speakers {
  private readonly db: DatabaseSync
  readonly model: VoiceprintModel | null
  /** The owner's library voiceprints, cached. */
  private ownerLibrary: { phraseId: number; vector: Float32Array }[] | undefined

  constructor(db: DatabaseSync, model: VoiceprintModel | null) {
    this.db = db
    this.model = model
  }

  get enabled(): boolean {
    return this.model !== null
  }

  /** The owner's person id, creating the row on first use. */
  ownerId(): number {
    const row = this.db.prepare('SELECT id FROM people WHERE is_owner = 1').get() as { id: number } | undefined
    if (row) return row.id
    const result = this.db
      .prepare('INSERT INTO people (name, is_owner, created_at) VALUES (?, 1, ?)')
      .run('Owner', new Date().toISOString())
    return Number(result.lastInsertRowid)
  }

  async voiceprint(pcm: Int16Array): Promise<Float32Array | null> {
    return this.model ? this.model.embed(pcm) : null
  }

  private library(): { phraseId: number; vector: Float32Array }[] {
    this.ownerLibrary ??= (
      this.db
        .prepare(
          `SELECT v.phrase_id, v.vector FROM library l
           JOIN phrase_voiceprints v ON v.phrase_id = l.phrase_id
           WHERE l.person_id = ?`,
        )
        .all(this.ownerId()) as { phrase_id: number; vector: Uint8Array }[]
    ).map((r) => ({ phraseId: r.phrase_id, vector: fromBlob(r.vector) }))
    return this.ownerLibrary
  }

  /** Best similarity to the owner's library; null if the library is empty. */
  ownerSimilarity(vector: Float32Array): number | null {
    const library = this.library()
    if (library.length === 0) return null
    return Math.max(...library.map((clip) => cosine(clip.vector, vector)))
  }

  /** Decide who said a phrase. `threshold` is the session's similarity cut-off for "the owner". */
  identify(vector: Float32Array | null, speechMs: number, threshold: number): SpeakerTag {
    const similarity = vector ? this.ownerSimilarity(vector) : null
    if (similarity === null) return { speakerId: null, isOwner: null, similarity: null, confidence: 'uncertain' }
    const isOwner = similarity >= threshold
    const confidence: Confidence =
      speechMs < MIN_CONFIDENT_SPEECH_MS ? 'uncertain' : Math.abs(similarity - threshold) < LOW_CONFIDENCE_MARGIN ? 'low' : 'high'
    return { speakerId: isOwner ? this.ownerId() : null, isOwner, similarity, confidence }
  }

  /** Stores a phrase's voiceprint and automatic speaker tag (and its history entry). */
  saveTag(phraseId: number, vector: Float32Array | null, tag: SpeakerTag): void {
    const now = new Date().toISOString()
    if (vector && this.model) {
      this.db
        .prepare('INSERT OR REPLACE INTO phrase_voiceprints (phrase_id, model, vector) VALUES (?, ?, ?)')
        .run(phraseId, this.model.name, toBlob(vector))
    }
    this.db
      .prepare('UPDATE phrases SET speaker_id = ?, speaker_similarity = ?, speaker_confidence = ? WHERE id = ?')
      .run(tag.speakerId, tag.similarity, tag.confidence, phraseId)
    this.db
      .prepare(
        `INSERT INTO speaker_history (phrase_id, speaker_id, similarity, confidence, source, changed_at)
         VALUES (?, ?, ?, ?, 'auto', ?)`,
      )
      .run(phraseId, tag.speakerId, tag.similarity, tag.confidence, now)
  }

  /**
   * Checks a voice-training clip before it joins the owner's library.
   * Returns a reason if it's rejected, or null if it's fine.
   */
  checkEnrollmentClip(vector: Float32Array | null, speechMs: number, threshold: number): string | null {
    if (!vector || speechMs < 1500) return 'Too short: read the whole sentence.'
    const similarity = this.ownerSimilarity(vector)
    if (similarity !== null && similarity < threshold - ENROLL_CONSISTENCY_MARGIN) {
      return `That didn't sound like the same voice as your other clips (similarity ${similarity.toFixed(2)}).`
    }
    return null
  }

  addToOwnerLibrary(phraseId: number, reason: 'enrollment' | 'confirmed' | 'adapted', device: string | null): void {
    const ownerId = this.ownerId()
    this.db
      .prepare('INSERT OR IGNORE INTO library (person_id, phrase_id, reason, device, added_at) VALUES (?, ?, ?, ?, ?)')
      .run(ownerId, phraseId, reason, device, new Date().toISOString())
    // The phrase is the owner's, by definition.
    this.db.prepare("UPDATE phrases SET speaker_id = ?, speaker_confidence = 'high' WHERE id = ?").run(ownerId, phraseId)
    this.db
      .prepare(
        `INSERT INTO speaker_history (phrase_id, speaker_id, similarity, confidence, source, changed_at)
         VALUES (?, ?, NULL, 'high', 'owner', ?)`,
      )
      .run(phraseId, ownerId, new Date().toISOString())
    this.ownerLibrary = undefined
  }

  ownerClips(): OwnerClip[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.conversation_id, l.device, l.added_at, p.text, p.duration_ms
         FROM library l JOIN phrases p ON p.id = l.phrase_id
         WHERE l.person_id = ? ORDER BY l.added_at`,
      )
      .all(this.ownerId()) as Record<string, unknown>[]
    return rows.map((r) => ({
      phraseId: Number(r.id),
      conversationId: Number(r.conversation_id),
      device: r.device === null ? null : String(r.device),
      addedAt: String(r.added_at),
      text: String(r.text),
      durationMs: Number(r.duration_ms),
    }))
  }

  /** Removes a clip from the owner's library (the recording itself stays in the archive). */
  removeOwnerClip(phraseId: number): boolean {
    const result = this.db.prepare('DELETE FROM library WHERE person_id = ? AND phrase_id = ?').run(this.ownerId(), phraseId)
    this.ownerLibrary = undefined
    return result.changes > 0
  }

  /** Empties the owner's library (recordings stay in the archive). */
  resetOwner(): number {
    const result = this.db.prepare('DELETE FROM library WHERE person_id = ?').run(this.ownerId())
    this.ownerLibrary = undefined
    return Number(result.changes)
  }
}
