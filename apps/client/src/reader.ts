// Read aloud: text pasted or typed into an editable page (or a document opened
// there) spoken in a chosen voice, sentence by sentence (server: POST /api/tts),
// with the sentence and the word being read highlighted. The panel
// (ReaderPanel.vue) splits the text into sentences and words; this plays them.
//
// Audio is fetched a couple of sentences ahead (audio.cpp makes speech about 8×
// faster than it plays) and kept, so going back is instant. The word being read
// is estimated: each sentence's audio length spread over its words by length,
// with a little more time at commas and full stops. Exact per sentence; within
// one it may drift slightly.

import { reactive } from 'vue'

export interface Segment {
  /** The words, as spoken (and as shown). */
  words: string[]
}

/** Where reading is: a sentence, and a word in it. */
export interface Position {
  s: number
  w: number
}

const STORAGE_KEY = 'jarvis.reader'
/** Sentences fetched ahead of the one playing. */
const AHEAD = 2

interface Saved {
  voice?: string
  rate?: number
}

function saved(): Saved {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Saved
  } catch {
    return {}
  }
}

const start = saved()

export const reader = reactive({
  open: false,
  /** The Markdown the page starts from (a document, or empty to paste into); edits happen on the page. */
  source: '',
  /** Bumped each time the page is (re)loaded from `source`. */
  version: 0,
  /** Where it came from (a document's name), if not pasted. */
  title: '',
  voice: start.voice ?? '',
  rate: start.rate ?? 1,
  voices: [] as string[],
  /** The voice Jarvis replies in: the reader defaults to another one, when there is one. */
  jarvisVoice: '',
  state: 'idle' as 'idle' | 'loading' | 'playing' | 'paused',
  /** The sentence and word being read (or where reading will start). */
  s: 0,
  w: 0,
  total: 0,
  error: '',
})

export function remember(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ voice: reader.voice, rate: reader.rate } satisfies Saved))
  } catch {
    // private window: not remembered
  }
}

export async function loadVoices(): Promise<void> {
  try {
    const response = await fetch('/api/tts/voices')
    if (!response.ok) return
    const body = (await response.json()) as { voices: string[]; jarvis: string }
    reader.voices = body.voices
    reader.jarvisVoice = body.jarvis
    if (!reader.voice || !body.voices.includes(reader.voice)) reader.voice = body.voices.find((v) => v !== body.jarvis) ?? body.voices[0] ?? ''
  } catch {
    // no voices: reading will say so
  }
}

/** Opens the reader on this text (a document's Markdown), or on an empty page to paste or type into. */
export function openReader(text = '', title = ''): void {
  stop()
  reader.source = text
  reader.title = title
  reader.s = 0
  reader.w = 0
  reader.version++
  reader.open = true
}

export function closeReader(): void {
  stop()
  reader.open = false
}

// ------------------------------------------------------------------ playback

let segments: Segment[] = []
const audio = typeof Audio !== 'undefined' ? new Audio() : null
if (audio) audio.preservesPitch = true
const clips = new Map<string, Promise<string>>()
let generation = 0
let frame = 0
/** The clip playing: which sentence, and from which word. */
let playing: { s: number; from: number } | null = null

/** The panel's sentences (after rendering the text). Resets the audio. */
export function setSegments(next: Segment[]): void {
  stop()
  for (const url of clips.values()) void url.then((u) => URL.revokeObjectURL(u)).catch(() => {})
  clips.clear()
  segments = next
  reader.total = next.length
  if (reader.s >= next.length) {
    reader.s = 0
    reader.w = 0
  }
}

const key = (s: number, from: number) => `${reader.voice}|${s}|${from}`

function clip(s: number, from: number): Promise<string> {
  const k = key(s, from)
  let p = clips.get(k)
  if (!p) {
    const text = segments[s]!.words.slice(from).join(' ')
    p = fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: reader.voice }) }).then(async (r) => {
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`)
      return URL.createObjectURL(await r.blob())
    })
    p.catch(() => clips.delete(k))
    clips.set(k, p)
  }
  return p
}

function prefetch(s: number): void {
  for (let i = s + 1; i <= s + AHEAD && i < segments.length; i++) void clip(i, 0).catch(() => {})
}

/** Plays from a position (the current one by default). */
export async function play(from: Position = { s: reader.s, w: reader.w }): Promise<void> {
  if (!audio || segments.length === 0) return
  if (!reader.voice) await loadVoices()
  const mine = ++generation
  audio.pause()
  cancelAnimationFrame(frame)
  reader.error = ''
  reader.s = from.s
  reader.w = from.w
  reader.state = 'loading'
  try {
    const url = await clip(from.s, from.w)
    if (mine !== generation) return
    prefetch(from.s)
    playing = { s: from.s, from: from.w }
    audio.src = url
    audio.playbackRate = reader.rate
    await audio.play()
    if (mine !== generation) return
    reader.state = 'playing'
    track()
  } catch (err) {
    if (mine !== generation) return
    reader.state = 'paused'
    reader.error = `Couldn't read this aloud: ${(err as Error).message}`
  }
}

export function pause(): void {
  if (!audio || reader.state !== 'playing') return
  audio.pause()
  cancelAnimationFrame(frame)
  reader.state = 'paused'
  remember()
}

export function resume(): void {
  if (!audio || reader.state !== 'paused') return
  // Paused mid-clip: carry on from there. Otherwise (moved, or never started): from the position.
  if (playing && playing.s === reader.s && audio.src && !audio.ended && audio.currentTime > 0) {
    void audio.play().then(() => {
      reader.state = 'playing'
      track()
    })
  } else {
    void play()
  }
}

/** Stops; the next play starts at the beginning of the sentence it was in. */
export function stop(): void {
  generation++
  audio?.pause()
  cancelAnimationFrame(frame)
  playing = null
  reader.w = 0
  if (reader.state !== 'idle') reader.state = 'idle'
  remember()
}

/** Moves to a position: playing carries on from there; otherwise it's where the next play starts. */
export function seek(to: Position): void {
  if (reader.state === 'playing' || reader.state === 'loading') {
    void play(to)
  } else {
    generation++
    audio?.pause()
    playing = null
    reader.s = to.s
    reader.w = to.w
    if (reader.state === 'paused') reader.state = 'idle'
    remember()
  }
}

export function step(delta: number): void {
  const s = Math.max(0, Math.min(segments.length - 1, reader.s + delta))
  seek({ s, w: 0 })
}

export function setRate(rate: number): void {
  reader.rate = rate
  if (audio) audio.playbackRate = rate
  remember()
}

export function setVoice(voice: string): void {
  reader.voice = voice
  remember()
  // The next sentences in the new voice; the one playing finishes.
}

if (audio) {
  audio.addEventListener('ended', () => {
    cancelAnimationFrame(frame)
    const next = (playing?.s ?? reader.s) + 1
    if (next < segments.length) void play({ s: next, w: 0 })
    else {
      reader.state = 'idle'
      reader.s = 0
      reader.w = 0
      playing = null
      remember()
    }
  })
}

/** Follows the word being read: the clip's time spread over its words, by length (a pause at punctuation). */
function track(): void {
  cancelAnimationFrame(frame)
  const tick = () => {
    if (!audio || !playing || reader.state !== 'playing') return
    const words = segments[playing.s]!.words.slice(playing.from)
    const weights = words.map((w) => w.length + 1 + (/[.!?…]["'”’)]*$/.test(w) ? 5 : /[,;:—–]$/.test(w) ? 3 : 0))
    const total = weights.reduce((a, b) => a + b, 0)
    const duration = audio.duration
    if (Number.isFinite(duration) && duration > 0) {
      let at = (audio.currentTime / duration) * total
      let i = 0
      while (i < weights.length - 1 && at > weights[i]!) at -= weights[i++]!
      reader.w = playing.from + i
    }
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
}
