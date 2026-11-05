// One live transcription session (one WebSocket connection).
//
// The client sends VAD-scored audio frames only while there is speech (plus a
// little before and after). This session splits them into phrases, re-transcribes
// the phrase in progress periodically for live text, and transcribes it once
// more when it ends for the final text. The client stays thin: it only decides
// "is anyone talking", and each audio frame crosses the network once.

import { transcribePcm } from '../audiocpp.ts'
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
  /** Highest request number applied, so a slow old partial can't overwrite a newer one. */
  appliedSeq: number
  final: boolean
  /** Speech in the phrase at the last partial; no new speech = no new partial. */
  speechMsAtLastPartial: number
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

  constructor(send: (message: ServerMessage) => void) {
    this.send = send
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

  /** Connection gone: stop everything, send nothing more. */
  close(): void {
    this.closed = true
    clearInterval(this.partialTimer)
    this.current = undefined
  }

  private applySettings(update: unknown): void {
    this.settings = mergeSettings(this.settings, update)
    this.segmenter.setOptions(segmenterOptions(this.settings))
  }

  private restartPartialTimer(): void {
    clearInterval(this.partialTimer)
    this.partialTimer = setInterval(() => this.sendPartial(), this.settings.partialIntervalMs)
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
        this.current = { id: this.nextId++, appliedSeq: 0, final: false, speechMsAtLastPartial: 0 }
      } else if (event.type === 'discard') {
        if (this.current) this.emit({ type: 'phrase.dropped', id: this.current.id })
        this.current = undefined
      } else {
        const phrase = this.current
        this.current = undefined
        if (phrase) this.sendFinal(phrase, event.audio)
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
        this.log(seq, phrase, 'partial', audio, started, stale ? 'stale' : 'ok', text)
        if (stale) return
        phrase.appliedSeq = seq
        this.emit({ type: 'phrase', id: phrase.id, text, final: false })
      })
      .catch((err: unknown) => {
        // A failed partial is harmless: the next one or the final will replace it.
        this.log(seq, phrase, 'partial', audio, started, 'error', errorMessage(err))
      })
      .finally(() => (this.partialInFlight = false))
  }

  private sendFinal(phrase: Phrase, audio: Int16Array): void {
    phrase.final = true
    const seq = this.nextSeq++
    const started = performance.now()
    const pending = transcribePcm(pcmBuffer(audio), STREAM_SAMPLE_RATE, this.language)
      .then((text) => {
        const noise = isNoise(text)
        this.log(seq, phrase, 'final', audio, started, noise ? 'dropped' : 'ok', text)
        if (noise) this.emit({ type: 'phrase.dropped', id: phrase.id })
        else this.emit({ type: 'phrase', id: phrase.id, text, final: true })
      })
      .catch((err: unknown) => {
        this.log(seq, phrase, 'final', audio, started, 'error', errorMessage(err))
        this.emit({ type: 'phrase.dropped', id: phrase.id })
        this.emit({ type: 'error', message: errorMessage(err) })
      })
      .finally(() => this.pendingFinals.delete(pending))
    this.pendingFinals.add(pending)
  }

  private log(
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
