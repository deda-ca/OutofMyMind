// Who is speaking: voiceprints, people's voice libraries, phrase tags, and the
// functions to name, correct, merge and forget people.
// Design: docs/speaker-recognition.md (M2 owner, M3 who's who).
//
// The public methods below the "tools" line are shaped like the AI tools in
// the design (recent_speakers, name_speaker, …): the web UI uses them through
// REST now, and the LLM will call the same functions later. Whether a request
// may use them (only the owner) is checked by the caller.

import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { VoiceprintModel, cosine, fromBlob, toBlob } from './voiceprint.ts'

export type Confidence = 'high' | 'low' | 'uncertain'

/** A phrase's speaker tag, as sent to clients and stored with the phrase. */
export interface SpeakerTag {
  /** Person (or unnamed group) id; null if nobody could be assigned. */
  speakerId: number | null
  /** "You" for the owner, a name, "Speaker A" for an unnamed group, or null. */
  name: string | null
  /** Whether the name was given (false for "Speaker A"). */
  named: boolean
  /** true = the owner; false = someone else; null = can't tell (no voiceprint, or voice not trained). */
  isOwner: boolean | null
  /** Best similarity to the owner's library, or null. */
  similarity: number | null
  /** Similarity to the person it was matched to, or null (new group, owner, unknown). */
  match: number | null
  confidence: Confidence
}

export interface Person {
  id: number
  name: string
  named: boolean
  isOwner: boolean
  clips: number
  phrases: number
  lastHeardAt: string | null
  /** Other people whose voices are close: possibly the same person split in two. */
  maybeSameAs: { id: number; name: string; similarity: number }[]
}

export interface Clip {
  phraseId: number
  conversationId: number
  device: string | null
  addedAt: string
  text: string
  durationMs: number
}

export interface RecentSpeaker {
  id: number
  name: string
  named: boolean
  isOwner: boolean
  lastHeardAt: string
  /** Their latest phrases, newest first. */
  phrases: { phraseId: number; startedAt: string; text: string }[]
}

// Rules, tuned with tools/speaker-eval/src/grouping-eval.ts (docs/speaker-model-eval.md).
/** Below this much speech a voiceprint is unreliable: no group, tag "uncertain". */
const MIN_CONFIDENT_SPEECH_MS = 1000
/** Within this distance of the owner threshold the owner tag is "low" confidence. */
const LOW_CONFIDENCE_MARGIN = 0.1
/** Enrollment: a new clip must be at least this close (owner threshold minus this) to the clips so far. */
const ENROLL_CONSISTENCY_MARGIN = 0.1
/** A voice joins an existing person/group at this score (mean of its 3 closest library clips). */
const GROUP_JOIN = 0.45
/** …and is added to their library (to learn from) only above this, with enough speech. */
const GROUP_LEARN = 0.55
const MIN_LIBRARY_SPEECH_MS = 2000
const LIBRARY_CAP = 50
/** Groups this close (but under GROUP_JOIN) are suggested as possibly the same person. */
const MAYBE_SAME = 0.35

interface LibraryEntry {
  personId: number
  phraseId: number
  vector: Float32Array
}

export class Speakers {
  private readonly db: DatabaseSync
  private readonly dataDir: string
  readonly model: VoiceprintModel | null
  /** All voice libraries (owner and others), cached. */
  private libraries: Map<number, LibraryEntry[]> | undefined

  constructor(db: DatabaseSync, dataDir: string, model: VoiceprintModel | null) {
    this.db = db
    this.dataDir = dataDir
    this.model = model
  }

  get enabled(): boolean {
    return this.model !== null
  }

  // ------------------------------------------------------------------ voiceprints and libraries

  async voiceprint(pcm: Int16Array): Promise<Float32Array | null> {
    return this.model ? this.model.embed(pcm) : null
  }

  /** The owner's person id, creating the row on first use. */
  ownerId(): number {
    const row = this.db.prepare('SELECT id FROM people WHERE is_owner = 1').get() as { id: number } | undefined
    if (row) return row.id
    const result = this.db
      .prepare('INSERT INTO people (name, is_owner, named, created_at) VALUES (?, 1, 1, ?)')
      .run('Owner', new Date().toISOString())
    return Number(result.lastInsertRowid)
  }

  private allLibraries(): Map<number, LibraryEntry[]> {
    if (!this.libraries) {
      this.libraries = new Map()
      const rows = this.db
        .prepare('SELECT l.person_id, l.phrase_id, v.vector FROM library l JOIN phrase_voiceprints v ON v.phrase_id = l.phrase_id')
        .all() as { person_id: number; phrase_id: number; vector: Uint8Array }[]
      for (const r of rows) {
        const list = this.libraries.get(r.person_id) ?? []
        list.push({ personId: r.person_id, phraseId: r.phrase_id, vector: fromBlob(r.vector) })
        this.libraries.set(r.person_id, list)
      }
    }
    return this.libraries
  }

  private invalidate(): void {
    this.libraries = undefined
  }

  /** Best similarity to the owner's library; null if it's empty. */
  ownerSimilarity(vector: Float32Array): number | null {
    const library = this.allLibraries().get(this.ownerId()) ?? []
    if (library.length === 0) return null
    return Math.max(...library.map((clip) => cosine(clip.vector, vector)))
  }

  /** Mean of the 3 best similarities to a library (robust to one odd clip). */
  private static groupScore(library: LibraryEntry[], vector: Float32Array): number {
    const sims = library.map((l) => cosine(l.vector, vector)).sort((a, b) => b - a)
    const top = sims.slice(0, 3)
    return top.reduce((s, x) => s + x, 0) / top.length
  }

  /** Best matching person other than the owner. */
  private bestOther(vector: Float32Array): { personId: number; score: number } | null {
    const ownerId = this.ownerId()
    let best: { personId: number; score: number } | null = null
    for (const [personId, library] of this.allLibraries()) {
      if (personId === ownerId || library.length === 0) continue
      const score = Speakers.groupScore(library, vector)
      if (!best || score > best.score) best = { personId, score }
    }
    return best
  }

  private person(id: number): { id: number; name: string; named: boolean; isOwner: boolean } | null {
    const r = this.db.prepare('SELECT id, name, named, is_owner FROM people WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? { id: Number(r.id), name: String(r.name), named: r.named === 1, isOwner: r.is_owner === 1 } : null
  }

  private tagFor(personId: number | null, similarity: number | null, match: number | null, confidence: Confidence, isOwner: boolean | null): SpeakerTag {
    const p = personId === null ? null : this.person(personId)
    return {
      speakerId: p?.id ?? null,
      name: p ? (p.isOwner ? 'You' : p.name) : null,
      named: p?.named ?? false,
      isOwner,
      similarity,
      match,
      confidence,
    }
  }

  /**
   * Decide who said a phrase.
   * - `commit: false` (early guess): only matches people who already exist.
   * - `commit: true` (final): may create a new "Speaker X" group; call `learn` afterwards with the phrase id.
   */
  identify(vector: Float32Array | null, speechMs: number, ownerThreshold: number, commit: boolean): SpeakerTag {
    if (!vector) return this.tagFor(null, null, null, 'uncertain', null)
    const similarity = this.ownerSimilarity(vector)
    const short = speechMs < MIN_CONFIDENT_SPEECH_MS

    if (similarity !== null && similarity >= ownerThreshold) {
      const confidence: Confidence = short ? 'uncertain' : similarity - ownerThreshold < LOW_CONFIDENCE_MARGIN ? 'low' : 'high'
      return this.tagFor(this.ownerId(), similarity, null, confidence, true)
    }

    const isOwner = similarity === null ? null : false
    if (short) return this.tagFor(null, similarity, null, 'uncertain', isOwner)

    const best = this.bestOther(vector)
    if (best && best.score >= GROUP_JOIN) {
      const confidence: Confidence = best.score >= GROUP_LEARN ? 'high' : 'low'
      return this.tagFor(best.personId, similarity, best.score, confidence, isOwner)
    }
    if (!commit) return { ...this.tagFor(null, similarity, null, 'low', isOwner), name: 'New voice' }
    return this.tagFor(this.createGroup(), similarity, null, 'high', isOwner)
  }

  private createGroup(): number {
    const { next } = this.db.prepare('SELECT COALESCE(MAX(label_index), 0) + 1 AS next FROM people').get() as { next: number }
    const result = this.db
      .prepare('INSERT INTO people (name, is_owner, named, label_index, created_at) VALUES (?, 0, 0, ?, ?)')
      .run(`Speaker ${groupLabel(next)}`, next, new Date().toISOString())
    return Number(result.lastInsertRowid)
  }

  /**
   * After a final decision has been saved: stores the voiceprint and tag, and
   * adds the phrase to the person's voice library if it's a clear example
   * (or the first clip of a new group).
   */
  saveTag(phraseId: number, vector: Float32Array | null, tag: SpeakerTag, speechMs: number, device: string | null): void {
    const now = new Date().toISOString()
    if (vector && this.model) {
      this.db.prepare('INSERT OR REPLACE INTO phrase_voiceprints (phrase_id, model, vector) VALUES (?, ?, ?)').run(phraseId, this.model.name, toBlob(vector))
    }
    this.setPhraseSpeaker(phraseId, tag.speakerId, tag.similarity, tag.confidence, 'auto', now)
    if (tag.speakerId !== null) this.db.prepare('UPDATE people SET last_heard_at = ? WHERE id = ?').run(now, tag.speakerId)

    // Learn other people's voices from clear examples. A brand-new group always
    // gets its first clip, so there's something to match the next phrase against.
    // (The owner learns only from voice training, for now.)
    if (vector && tag.speakerId !== null && tag.isOwner !== true) {
      const library = this.allLibraries().get(tag.speakerId) ?? []
      const clearExample = speechMs >= MIN_LIBRARY_SPEECH_MS && (tag.match ?? 0) >= GROUP_LEARN
      if ((library.length === 0 || clearExample) && library.length < LIBRARY_CAP) {
        this.addToLibrary(tag.speakerId, phraseId, 'adapted', device)
      }
    }
  }

  private setPhraseSpeaker(phraseId: number, speakerId: number | null, similarity: number | null, confidence: Confidence, source: 'auto' | 'owner', at: string): void {
    this.db.prepare('UPDATE phrases SET speaker_id = ?, speaker_similarity = ?, speaker_confidence = ? WHERE id = ?').run(speakerId, similarity, confidence, phraseId)
    this.db
      .prepare('INSERT INTO speaker_history (phrase_id, speaker_id, similarity, confidence, source, changed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(phraseId, speakerId, similarity, confidence, source, at)
  }

  private addToLibrary(personId: number, phraseId: number, reason: 'enrollment' | 'confirmed' | 'adapted', device: string | null): void {
    this.db
      .prepare('INSERT OR IGNORE INTO library (person_id, phrase_id, reason, device, added_at) VALUES (?, ?, ?, ?, ?)')
      .run(personId, phraseId, reason, device, new Date().toISOString())
    this.invalidate()
  }

  // ------------------------------------------------------------------ owner voice training

  /** Checks a voice-training clip. Returns a reason if it's rejected, or null if it's fine. */
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
    this.addToLibrary(ownerId, phraseId, reason, device)
    this.setPhraseSpeaker(phraseId, ownerId, null, 'high', 'owner', new Date().toISOString())
  }

  ownerClips(): Clip[] {
    return this.clips(this.ownerId())
  }

  removeOwnerClip(phraseId: number): boolean {
    const result = this.db.prepare('DELETE FROM library WHERE person_id = ? AND phrase_id = ?').run(this.ownerId(), phraseId)
    this.invalidate()
    return result.changes > 0
  }

  resetOwner(): number {
    const result = this.db.prepare('DELETE FROM library WHERE person_id = ?').run(this.ownerId())
    this.invalidate()
    return Number(result.changes)
  }

  // ------------------------------------------------------------------ tools (UI now, AI later)

  /** list_people: everyone Jarvis knows, named or not, with possible duplicates. */
  listPeople(): Person[] {
    const rows = this.db
      .prepare(
        `SELECT pe.id, pe.name, pe.named, pe.is_owner, pe.last_heard_at,
                (SELECT COUNT(*) FROM library l WHERE l.person_id = pe.id) AS clips,
                (SELECT COUNT(*) FROM phrases p WHERE p.speaker_id = pe.id) AS phrases
         FROM people pe ORDER BY pe.is_owner DESC, pe.named DESC, COALESCE(pe.last_heard_at, pe.created_at) DESC`,
      )
      .all() as Record<string, unknown>[]
    const libraries = this.allLibraries()
    const people = rows.map((r) => ({
      id: Number(r.id),
      name: r.is_owner === 1 ? 'You' : String(r.name),
      named: r.named === 1,
      isOwner: r.is_owner === 1,
      clips: Number(r.clips),
      phrases: Number(r.phrases),
      lastHeardAt: r.last_heard_at === null ? null : String(r.last_heard_at),
      maybeSameAs: [] as Person['maybeSameAs'],
    }))
    // Suggest likely duplicates: groups whose voices are close but weren't joined.
    for (const a of people) {
      const libA = libraries.get(a.id) ?? []
      if (libA.length === 0) continue
      for (const b of people) {
        if (b.id === a.id) continue
        const libB = libraries.get(b.id) ?? []
        if (libB.length === 0) continue
        const similarity = Math.max(...libA.map((clip) => Speakers.groupScore(libB, clip.vector)))
        if (similarity >= MAYBE_SAME) a.maybeSameAs.push({ id: b.id, name: b.name, similarity })
      }
      a.maybeSameAs.sort((x, y) => y.similarity - x.similarity)
    }
    return people
  }

  /** A person's voice-library clips. */
  clips(personId: number): Clip[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.conversation_id, l.device, l.added_at, p.text, p.duration_ms
         FROM library l JOIN phrases p ON p.id = l.phrase_id
         WHERE l.person_id = ? ORDER BY l.added_at`,
      )
      .all(personId) as Record<string, unknown>[]
    return rows.map((r) => ({
      phraseId: Number(r.id),
      conversationId: Number(r.conversation_id),
      device: r.device === null ? null : String(r.device),
      addedAt: String(r.added_at),
      text: String(r.text),
      durationMs: Number(r.duration_ms),
    }))
  }

  /**
   * recent_speakers: who has spoken in the last `minutes`, most recent first,
   * with their latest phrases. This is how "the person speaking now" is resolved.
   */
  recentSpeakers(minutes: number, phrasesEach = 3): RecentSpeaker[] {
    const since = new Date(Date.now() - minutes * 60_000).toISOString()
    const rows = this.db
      .prepare(
        `SELECT p.id, p.started_at, p.text, pe.id AS person_id, pe.name, pe.named, pe.is_owner
         FROM phrases p JOIN people pe ON pe.id = p.speaker_id
         WHERE p.started_at >= ? AND p.status = 'ok'
         ORDER BY p.started_at DESC`,
      )
      .all(since) as Record<string, unknown>[]
    const byPerson = new Map<number, RecentSpeaker>()
    for (const r of rows) {
      const id = Number(r.person_id)
      let entry = byPerson.get(id)
      if (!entry) {
        entry = {
          id,
          name: r.is_owner === 1 ? 'You' : String(r.name),
          named: r.named === 1,
          isOwner: r.is_owner === 1,
          lastHeardAt: String(r.started_at),
          phrases: [],
        }
        byPerson.set(id, entry)
      }
      if (entry.phrases.length < phrasesEach) entry.phrases.push({ phraseId: Number(r.id), startedAt: String(r.started_at), text: String(r.text) })
    }
    return [...byPerson.values()]
  }

  /** The most recent speaker other than the owner in the last `minutes` ("the person speaking now"). */
  mostRecentOther(minutes = 2): RecentSpeaker | null {
    return this.recentSpeakers(minutes).find((s) => !s.isOwner) ?? null
  }

  /**
   * name_speaker: give a person or unnamed group a name. If someone else already
   * has that name, the two are merged (it's the same person).
   */
  nameSpeaker(personId: number, rawName: string): Person {
    const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 60)
    if (!name) throw new SpeakerError('A name is required.')
    const target = this.person(personId)
    if (!target) throw new SpeakerError(`No person ${personId}.`, 404)
    const existing = this.db
      .prepare('SELECT id FROM people WHERE named = 1 AND is_owner = 0 AND lower(name) = lower(?) AND id != ?')
      .get(name, personId) as { id: number } | undefined
    if (existing && !target.isOwner) {
      this.mergePeople(personId, existing.id)
      return this.listPeople().find((p) => p.id === existing.id)!
    }
    this.db.prepare('UPDATE people SET name = ?, named = 1 WHERE id = ?').run(name, personId)
    return this.listPeople().find((p) => p.id === personId)!
  }

  /**
   * retag_phrase: correct who said a phrase. `personId: "new"` starts a new
   * person from it. The phrase's clip moves to the right voice library.
   */
  retagPhrase(phraseId: number, personId: number | 'new'): void {
    const phrase = this.db.prepare('SELECT id, speaker_id, speaker_similarity FROM phrases WHERE id = ?').get(phraseId) as
      | { id: number; speaker_id: number | null; speaker_similarity: number | null }
      | undefined
    if (!phrase) throw new SpeakerError(`No phrase ${phraseId}.`, 404)
    const target = personId === 'new' ? this.createGroup() : personId
    if (!this.person(target)) throw new SpeakerError(`No person ${target}.`, 404)
    const now = new Date().toISOString()
    this.db.prepare('DELETE FROM library WHERE phrase_id = ?').run(phraseId)
    this.setPhraseSpeaker(phraseId, target, phrase.speaker_similarity, 'high', 'owner', now)
    // A correction is a confirmed example: learn from it if there's a voiceprint.
    const hasVoiceprint = this.db.prepare('SELECT 1 FROM phrase_voiceprints WHERE phrase_id = ?').get(phraseId)
    const library = this.allLibraries().get(target) ?? []
    if (hasVoiceprint && library.length < LIBRARY_CAP) this.addToLibrary(target, phraseId, 'confirmed', null)
    this.invalidate()
    this.removeIfEmpty(phrase.speaker_id)
  }

  /** merge_people: `fromId` and `intoId` are the same person; everything moves to `intoId`. */
  mergePeople(fromId: number, intoId: number): void {
    if (fromId === intoId) throw new SpeakerError('Pick two different people.')
    const from = this.person(fromId)
    const into = this.person(intoId)
    if (!from || !into) throw new SpeakerError('No such person.', 404)
    if (from.isOwner) throw new SpeakerError('Merge others into yourself, not the other way round.')
    const now = new Date().toISOString()
    this.db.exec('BEGIN')
    try {
      const moved = this.db.prepare('SELECT id, speaker_similarity, speaker_confidence FROM phrases WHERE speaker_id = ?').all(fromId) as {
        id: number
        speaker_similarity: number | null
        speaker_confidence: Confidence | null
      }[]
      for (const p of moved) this.setPhraseSpeaker(p.id, intoId, p.speaker_similarity, p.speaker_confidence ?? 'high', 'owner', now)
      this.db.prepare('UPDATE OR IGNORE library SET person_id = ? WHERE person_id = ?').run(intoId, fromId)
      this.db.prepare('DELETE FROM library WHERE person_id = ?').run(fromId)
      const latest = [this.lastHeard(fromId), this.lastHeard(intoId)].filter((t): t is string => t !== null).sort().at(-1) ?? null
      this.db.prepare('UPDATE people SET last_heard_at = ? WHERE id = ?').run(latest, intoId)
      // Earlier history rows keep pointing at the old id, so they stay true to what happened.
      this.db.prepare('UPDATE speaker_history SET speaker_id = NULL WHERE speaker_id = ?').run(fromId)
      this.db.prepare('DELETE FROM people WHERE id = ?').run(fromId)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    this.invalidate()
  }

  /**
   * forget_person: remove a person and their voice library. Their phrases stay
   * (tagged unknown) unless `deleteAudio`, which also deletes those recordings' audio.
   */
  forgetPerson(personId: number, deleteAudio = false): void {
    const p = this.person(personId)
    if (!p) throw new SpeakerError(`No person ${personId}.`, 404)
    if (p.isOwner) throw new SpeakerError('Reset your own voice from the voice training page instead.')
    const now = new Date().toISOString()
    const phrases = this.db.prepare('SELECT id, audio_path FROM phrases WHERE speaker_id = ?').all(personId) as { id: number; audio_path: string | null }[]
    this.db.exec('BEGIN')
    try {
      for (const ph of phrases) this.setPhraseSpeaker(ph.id, null, null, 'uncertain', 'owner', now)
      this.db.prepare('DELETE FROM library WHERE person_id = ?').run(personId)
      this.db.prepare('UPDATE speaker_history SET speaker_id = NULL WHERE speaker_id = ?').run(personId)
      this.db.prepare('DELETE FROM people WHERE id = ?').run(personId)
      if (deleteAudio) {
        for (const ph of phrases) {
          this.db.prepare('DELETE FROM phrase_voiceprints WHERE phrase_id = ?').run(ph.id)
          this.db.prepare('UPDATE phrases SET audio_path = NULL, audio_bytes = NULL WHERE id = ?').run(ph.id)
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    if (deleteAudio) {
      for (const ph of phrases) {
        if (!ph.audio_path) continue
        const file = path.resolve(this.dataDir, ph.audio_path)
        if (file.startsWith(this.dataDir + path.sep)) fs.rmSync(file, { force: true })
      }
    }
    this.invalidate()
  }

  private lastHeard(personId: number): string | null {
    const r = this.db.prepare('SELECT last_heard_at FROM people WHERE id = ?').get(personId) as { last_heard_at: string | null } | undefined
    return r?.last_heard_at ?? null
  }

  /** An unnamed group left with no phrases (after corrections) is removed. */
  private removeIfEmpty(personId: number | null): void {
    if (personId === null) return
    const p = this.person(personId)
    if (!p || p.isOwner || p.named) return
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM phrases WHERE speaker_id = ?').get(personId) as { n: number }
    if (n > 0) return
    this.db.prepare('UPDATE speaker_history SET speaker_id = NULL WHERE speaker_id = ?').run(personId)
    this.db.prepare('DELETE FROM library WHERE person_id = ?').run(personId)
    this.db.prepare('DELETE FROM people WHERE id = ?').run(personId)
    this.invalidate()
  }

  // ------------------------------------------------------------------ backfill

  /** Archived phrases never processed by speaker recognition (no voiceprint, no tag), oldest first. */
  phrasesWithoutVoiceprint(limit: number): { id: number; audioPath: string; durationMs: number; device: string | null; status: string }[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.audio_path, p.duration_ms, p.status, c.device FROM phrases p
         JOIN conversations c ON c.id = p.conversation_id
         LEFT JOIN phrase_voiceprints v ON v.phrase_id = p.id
         WHERE v.phrase_id IS NULL AND p.speaker_confidence IS NULL AND p.audio_path IS NOT NULL AND c.kind = 'conversation'
         ORDER BY p.started_at LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: Number(r.id),
      audioPath: String(r.audio_path),
      durationMs: Number(r.duration_ms),
      device: r.device === null ? null : String(r.device),
      status: String(r.status),
    }))
  }
}

export class SpeakerError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** 1 → A, 26 → Z, 27 → AA, … */
function groupLabel(n: number): string {
  let label = ''
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) label = String.fromCharCode(65 + ((x - 1) % 26)) + label
  return label
}
