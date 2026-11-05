// One live transcription session (one WebSocket connection).
//
// The client sends VAD-scored audio frames only while there is speech (plus a
// little before and after). This session splits them into phrases, re-transcribes
// the phrase in progress periodically for live text, and transcribes it once
// more when it ends for the final text. The client stays thin: it only decides
// "is anyone talking", and each audio frame crosses the network once.

import type { ConversationRecorder, PhraseStatus } from '../archive/archive.ts'
import { Assistant } from '../assistant/assistant.ts'
import { config } from '../config.ts'
import { transcribePcm } from '../audiocpp.ts'
import type { SpeakerTag, Speakers } from '../speaker/speakers.ts'
import { PhraseSegmenter, type SegmenterEvent, type SegmenterOptions } from './phraseSegmenter.ts'
import { STREAM_SAMPLE_RATE, type RequestLog, type ServerMessage } from './protocol.ts'
import { DEFAULT_SETTINGS, mergeSettings, sendHangoverMs, type StreamSettings } from './settings.ts'

/** Silero's usual gap between the "speech" and "silence" thresholds. */
const SILENCE_THRESHOLD_GAP = 0.15
const POST_SPEECH_PAD_MS = 200
/** Don't bother transcribing a phrase shorter than this for a partial. */
const MIN_PARTIAL_MS = 500
/** How often phrase state is reported while a phrase is open. */
const STATE_INTERVAL_MS = 100
/** The early speaker guess is made once a phrase has this much speech. */
const EARLY_GUESS_SPEECH_MS = 1500
/** Shorter phrases can't hold two clear turns (each piece must be ≥ 1 s, plus the scan windows). */
const MIN_SPLIT_SECONDS = 3

export type SessionMode = 'conversation' | 'enroll'

export interface SessionOptions {
  /** Archives every phrase. */
  recorder?: ConversationRecorder
  /** Speaker recognition; off when undefined or the model isn't loaded. */
  speakers?: Speakers
  /** "enroll": the owner is training their voice; accepted phrases join their library. */
  mode?: SessionMode
  log?: (message: string, err?: unknown) => void
}

function segmenterOptions(settings: StreamSettings): Omit<SegmenterOptions, 'sampleRate'> {
  return {
    speechThreshold: settings.speechThreshold,
    silenceThreshold: Math.max(0.01, settings.speechThreshold - SILENCE_THRESHOLD_GAP),
    pauseMs: settings.pauseMs,
    preSpeechPadMs: settings.preSpeechPadMs,
    postSpeechPadMs: POST_SPEECH_PAD_MS,
    minSpeechMs: settings.minSpeechMs,
    maxPhraseMs: settings.maxPhraseMs,
  }
}

interface Phrase {
  id: number
  /** When the phrase's audio starts (including the pre-speech pad). */
  startedAt: Date
  /** Highest request number applied, so a slow old partial can't overwrite a newer one. */
  appliedSeq: number
  final: boolean
  /** Speech in the phrase at the last partial; no new speech = no new partial. */
  speechMsAtLastPartial: number
  /** The early speaker guess has been started (it's made once per phrase). */
  earlyGuessStarted: boolean
}

export class StreamSession {
  private settings: StreamSettings = { ...DEFAULT_SETTINGS }
  private language = ''
  private segmenter: PhraseSegmenter
  private started = false
  private closed = false
  private current?: Phrase
  private nextId = 1
  private nextSeq = 1
  private partialInFlight = false
  private partialTimer?: ReturnType<typeof setInterval>
  private lastStateAt = 0
  private lastInPhrase = false
  private pendingFinals = new Set<Promise<void>>()
  private readonly send: (message: ServerMessage) => void
  private readonly recorder: ConversationRecorder | undefined
  private readonly speakers: Speakers | undefined
  private readonly mode: SessionMode
  private readonly log: (message: string, err?: unknown) => void
  /** Jarvis, in conversation mode. */
  private readonly assistant: Assistant | undefined

  constructor(send: (message: ServerMessage) => void, options: SessionOptions = {}) {
    this.send = send
    this.recorder = options.recorder
    this.speakers = options.speakers?.enabled ? options.speakers : undefined
    this.mode = options.mode ?? 'conversation'
    this.log = options.log ?? console.error
    if (this.mode === 'enroll' && !this.speakers) {
      throw new Error('Voice training needs speaker recognition, which is off (the voiceprint model is missing on the server).')
    }
    const speakers = this.speakers
    this.assistant =
      this.mode === 'conversation'
        ? new Assistant({
            emit: (message) => this.emit(message),
            saveReply: (phraseId, kind, text, latencyMs) => this.recorder?.saveReply(phraseId, kind, text, config.llmModel, latencyMs),
            ownerTrained: () => (speakers ? speakers.ownerClips().length > 0 : false),
            followUpMs: () => this.settings.followUpMs,
            speak: () => this.settings.speakReplies >= 0.5,
            log: this.log,
          })
        : undefined
    this.segmenter = new PhraseSegmenter({ sampleRate: STREAM_SAMPLE_RATE, ...segmenterOptions(this.settings) })
  }

  start(sampleRate: number, language: string, settings: unknown): void {
    if (this.started) throw new Error('Session already started')
    if (sampleRate !== STREAM_SAMPLE_RATE) throw new Error(`sampleRate must be ${STREAM_SAMPLE_RATE}`)
    this.started = true
    this.language = language
    this.applySettings(settings)
    this.restartPartialTimer()
    this.send({ type: 'ready', settings: this.settings, sendHangoverMs: sendHangoverMs(this.settings) })
    this.assistant?.announce()
  }

  updateSettings(update: unknown): void {
    const before = this.settings.partialIntervalMs
    this.applySettings(update)
    if (this.started && before !== this.settings.partialIntervalMs) this.restartPartialTimer()
    this.send({ type: 'settings', settings: this.settings, sendHangoverMs: sendHangoverMs(this.settings) })
  }

  frame(probability: number, pcm: Int16Array): void {
    if (!this.started) throw new Error('Send "start" before audio')
    this.handleEvents(this.segmenter.feed(pcm, probability))
    this.reportState()
  }

  /** Finish the phrase in progress and wait for its final text. */
  async stop(): Promise<void> {
    clearInterval(this.partialTimer)
    this.handleEvents(this.segmenter.flush())
    this.reportState(true)
    await Promise.allSettled([...this.pendingFinals])
    this.send({ type: 'stopped' })
  }

  /**
   * Connection gone: send nothing more. A phrase still in progress is
   * finished and archived anyway (everything is recorded), and the
   * conversation is closed once its last phrase is saved.
   */
  close(): void {
    this.closed = true
    clearInterval(this.partialTimer)
    this.assistant?.close()
    if (this.started) this.handleEvents(this.segmenter.flush())
    void Promise.allSettled([...this.pendingFinals]).then(() => this.recorder?.end())
  }

  private applySettings(update: unknown): void {
    this.settings = mergeSettings(this.settings, update)
    this.segmenter.setOptions(segmenterOptions(this.settings))
  }

  private restartPartialTimer(): void {
    clearInterval(this.partialTimer)
    this.partialTimer = setInterval(() => {
      this.sendPartial()
      this.earlySpeakerGuess()
    }, this.settings.partialIntervalMs)
  }

  private reportState(force = false): void {
    const inPhrase = this.segmenter.inPhrase
    const now = Date.now()
    const changed = inPhrase !== this.lastInPhrase
    if (!force && !changed && (!inPhrase || now - this.lastStateAt < STATE_INTERVAL_MS)) return
    this.lastStateAt = now
    this.lastInPhrase = inPhrase
    this.emit({
      type: 'state',
      inPhrase,
      phraseMs: Math.round(this.segmenter.currentDurationMs()),
      speechMs: Math.round(this.segmenter.currentSpeechMs()),
      silenceMs: Math.round(this.segmenter.currentSilenceMs()),
    })
  }

  private handleEvents(events: SegmenterEvent[]): void {
    for (const event of events) {
      if (event.type === 'start') {
        // The segmenter has already included the pre-speech pad in the phrase.
        const startedAt = new Date(Date.now() - this.segmenter.currentDurationMs())
        this.current = {
          id: this.nextId++,
          startedAt,
          appliedSeq: 0,
          final: false,
          speechMsAtLastPartial: 0,
          earlyGuessStarted: false,
        }
      } else if (event.type === 'discard') {
        if (this.current) this.emit({ type: 'phrase.dropped', id: this.current.id })
        this.current = undefined
      } else {
        const phrase = this.current
        this.current = undefined
        if (phrase) this.sendFinal(phrase, event.audio, event.speechMs)
      }
    }
  }

  private sendPartial(): void {
    const phrase = this.current
    if (!phrase || this.partialInFlight || this.segmenter.currentDurationMs() < MIN_PARTIAL_MS) return
    // Nothing new said since the last partial (e.g. during a pause): skip.
    const speechMs = this.segmenter.currentSpeechMs()
    if (speechMs === phrase.speechMsAtLastPartial) return
    phrase.speechMsAtLastPartial = speechMs

    const audio = this.segmenter.currentAudio()
    const seq = this.nextSeq++
    const started = performance.now()
    this.partialInFlight = true
    transcribePcm(pcmBuffer(audio), STREAM_SAMPLE_RATE, this.language)
      .then((text) => {
        const stale = phrase.final || seq < phrase.appliedSeq
        this.logRequest(seq, phrase, 'partial', audio, started, stale ? 'stale' : 'ok', text)
        if (stale) return
        phrase.appliedSeq = seq
        this.emit({ type: 'phrase', id: phrase.id, text, final: false })
      })
      .catch((err: unknown) => {
        // A failed partial is harmless: the next one or the final will replace it.
        this.logRequest(seq, phrase, 'partial', audio, started, 'error', errorMessage(err))
      })
      .finally(() => (this.partialInFlight = false))
  }

  /** Once per phrase, after ~1.5 s of speech: who seems to be talking? (conversation mode) */
  private earlySpeakerGuess(): void {
    const phrase = this.current
    const speakers = this.speakers
    if (!phrase || !speakers || this.mode !== 'conversation' || phrase.earlyGuessStarted) return
    const speechMs = this.segmenter.currentSpeechMs()
    if (speechMs < EARLY_GUESS_SPEECH_MS) return
    phrase.earlyGuessStarted = true
    speakers
      .voiceprint(this.segmenter.currentAudio())
      .then((vector) => {
        if (phrase.final) return // the final decision is on its way
        // Early guesses only match people already known; they never create a group.
        const speaker = speakers.identify(vector, speechMs, this.settings.speakerThreshold, false)
        this.emit({ type: 'phrase.speaker', id: phrase.id, final: false, speaker })
      })
      .catch((err: unknown) => this.log(`speaker: early guess failed for phrase ${phrase.id}`, err))
  }

  private sendFinal(phrase: Phrase, audio: Int16Array, speechMs: number): void {
    phrase.final = true
    const pending = this.splitBySpeaker(phrase, audio)
      .then((pieces) =>
        pieces
          ? // One phrase per speaker, in order (each transcribed and identified on its own).
            pieces.reduce<Promise<void>>((chain, p) => chain.then(() => this.finishPhrase(p.phrase, p.audio, p.audio.length / 16)), Promise.resolve())
          : this.finishPhrase(phrase, audio, speechMs),
      )
      .catch((err: unknown) => this.log(`could not finish phrase ${phrase.id}`, err))
      .finally(() => this.pendingFinals.delete(pending))
    this.pendingFinals.add(pending)
  }

  /**
   * People taking turns without a pause end up in one phrase. If the voice
   * changes inside it, returns one piece per speaker (and tells the client);
   * otherwise null.
   */
  private async splitBySpeaker(phrase: Phrase, audio: Int16Array): Promise<{ phrase: Phrase; audio: Int16Array }[] | null> {
    const threshold = this.settings.speakerChangeThreshold
    if (!this.speakers || this.mode !== 'conversation' || threshold <= 0 || audio.length < MIN_SPLIT_SECONDS * STREAM_SAMPLE_RATE) return null
    let cuts: number[]
    try {
      cuts = await this.speakers.speakerChanges(audio, threshold)
    } catch (err) {
      this.log(`speaker: change detection failed for phrase ${phrase.id}`, err)
      return null
    }
    if (cuts.length === 0) return null
    const bounds = [0, ...cuts, audio.length]
    const pieces = bounds.slice(0, -1).map((start, k) => ({
      phrase: {
        id: this.nextId++,
        startedAt: new Date(phrase.startedAt.getTime() + (start / STREAM_SAMPLE_RATE) * 1000),
        appliedSeq: 0,
        final: true,
        speechMsAtLastPartial: 0,
        earlyGuessStarted: true,
      },
      audio: audio.subarray(start, bounds[k + 1]),
    }))
    this.emit({ type: 'phrase.split', id: phrase.id, into: pieces.map((p) => p.phrase.id) })
    return pieces
  }

  /** Final transcription, speaker decision and archiving of one phrase (or one piece of a split phrase). */
  private async finishPhrase(phrase: Phrase, audio: Int16Array, speechMs: number): Promise<void> {
    const seq = this.nextSeq++
    const started = performance.now()
    // The voiceprint (CPU) is computed while audio.cpp transcribes (GPU).
    const voiceprint: Promise<Float32Array | null> = this.speakers
      ? this.speakers.voiceprint(audio).catch((err: unknown) => {
          this.log(`speaker: voiceprint failed for phrase ${phrase.id}`, err)
          return null
        })
      : Promise.resolve(null)

    const { text, status } = await transcribePcm(pcmBuffer(audio), STREAM_SAMPLE_RATE, this.language)
      .then((text) => {
        const noise = isNoise(text)
        this.logRequest(seq, phrase, 'final', audio, started, noise ? 'dropped' : 'ok', text)
        if (noise) this.emit({ type: 'phrase.dropped', id: phrase.id })
        else this.emit({ type: 'phrase', id: phrase.id, text, final: true })
        return { text, status: (noise ? 'dropped' : 'ok') as PhraseStatus }
      })
      .catch((err: unknown) => {
        this.logRequest(seq, phrase, 'final', audio, started, 'error', errorMessage(err))
        this.emit({ type: 'phrase.dropped', id: phrase.id })
        this.emit({ type: 'error', message: errorMessage(err) })
        // Keep the audio so it can be transcribed again later.
        return { text: '', status: 'error' as PhraseStatus }
      })
    const vector = await voiceprint
    if (this.mode === 'enroll') return this.finishEnrollmentClip(phrase, audio, speechMs, text, status, vector)
    // Only real speech may start a new "Speaker X" group, never noise or failures.
    const tag = this.speakers?.identify(vector, speechMs, this.settings.speakerThreshold, status === 'ok')
    if (tag && status === 'ok') this.emit({ type: 'phrase.speaker', id: phrase.id, final: true, speaker: tag })
    const archiveId = await this.archive(phrase, audio, text, status, vector, tag, speechMs)
    if (status === 'ok') this.assistant?.handle({ id: phrase.id, archiveId, text, speaker: tag })
  }

  /** Voice training: check the clip, archive it, and add it to the owner's library if it's good. */
  private async finishEnrollmentClip(
    phrase: Phrase,
    audio: Int16Array,
    speechMs: number,
    text: string,
    status: PhraseStatus,
    vector: Float32Array | null,
  ): Promise<void> {
    const speakers = this.speakers!
    const reason =
      status === 'error'
        ? 'Transcription failed; try again.'
        : status === 'dropped'
          ? "Didn't catch any words; try again."
          : speakers.checkEnrollmentClip(vector, speechMs, this.settings.speakerThreshold)
    const phraseId = await this.archive(phrase, audio, text, status, vector, undefined, speechMs)
    if (reason === null && phraseId !== null) speakers.addToOwnerLibrary(phraseId, 'enrollment', this.recorder?.device ?? null)
    this.emit({
      type: 'enroll.clip',
      id: phrase.id,
      accepted: reason === null && phraseId !== null,
      reason: phraseId === null ? 'Could not save the recording.' : reason,
      text,
      clips: speakers.ownerClips().length,
    })
  }

  /**
   * Every phrase is archived, including noise and failed transcriptions,
   * with its voiceprint and speaker tag. Returns the phrase's archive id.
   */
  private async archive(
    phrase: Phrase,
    audio: Int16Array,
    text: string,
    status: PhraseStatus,
    vector: Float32Array | null,
    tag: SpeakerTag | undefined,
    speechMs: number,
  ): Promise<number | null> {
    if (!this.recorder) return null
    try {
      const phraseId = await this.recorder.savePhrase(phrase.id, phrase.startedAt, audio, text, status, this.language)
      if (this.speakers && (vector || tag)) {
        const unknown: SpeakerTag = { speakerId: null, name: null, named: false, isOwner: null, similarity: null, match: null, confidence: 'uncertain' }
        this.speakers.saveTag(phraseId, vector, tag ?? unknown, speechMs, this.recorder.device)
      }
      return phraseId
    } catch (err) {
      this.log(`archive: could not save phrase ${phrase.id}`, err)
      return null
    }
  }

  private logRequest(
    seq: number,
    phrase: Phrase,
    kind: RequestLog['kind'],
    audio: Int16Array,
    started: number,
    status: RequestLog['status'],
    text: string,
  ): void {
    this.emit({
      type: 'request',
      seq,
      phraseId: phrase.id,
      kind,
      audioMs: Math.round((audio.length / STREAM_SAMPLE_RATE) * 1000),
      latencyMs: Math.round(performance.now() - started),
      status,
      text,
    })
  }

  private emit(message: ServerMessage): void {
    if (!this.closed) this.send(message)
  }
}

function pcmBuffer(audio: Int16Array): Buffer {
  return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Empty or punctuation-only results. */
function isNoise(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text)
}
