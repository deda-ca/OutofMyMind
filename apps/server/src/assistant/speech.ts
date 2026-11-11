// Jarvis's voice: replies are spoken sentence by sentence with text-to-speech
// on audio.cpp (Qwen3-TTS, ~8× faster than real time), so the first sentence
// can play while the LLM is still writing the rest.

import { config } from '../config.ts'

export class SpeechError extends Error {}

/** Synthesises one piece of text (in Jarvis's voice unless another is given); returns a WAV file. */
export async function synthesize(text: string, signal?: AbortSignal, voice = config.ttsVoice): Promise<Buffer> {
  let response: Response
  try {
    response = await fetch(new URL('/v1/audio/speech', config.audiocppUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.ttsModel, input: text, voice }),
      signal,
    })
  } catch (err) {
    throw new SpeechError(`Could not reach audio.cpp for speech: ${(err as Error).message}`)
  }
  if (!response.ok) throw new SpeechError(`Text-to-speech failed (HTTP ${response.status}): ${(await response.text().catch(() => '')).slice(0, 200)}`)
  return Buffer.from(await response.arrayBuffer())
}

let voiceCache: { voices: string[]; at: number } | undefined

/** The voices audio.cpp offers (GET /v1/audio/voices), re-read every minute. */
export async function ttsVoices(): Promise<string[]> {
  if (voiceCache && Date.now() - voiceCache.at < 60_000) return voiceCache.voices
  try {
    const response = await fetch(new URL('/v1/audio/voices', config.audiocppUrl), { signal: AbortSignal.timeout(5000) })
    const voices = ((await response.json()) as { voices?: unknown }).voices
    if (Array.isArray(voices)) voiceCache = { voices: voices.map(String), at: Date.now() }
  } catch {
    // keep what we had (or just Jarvis's)
  }
  return voiceCache?.voices ?? [config.ttsVoice]
}

/** Makes LLM text sound right when read aloud (no markdown symbols, no URLs spelled out). */
export function forSpeech(text: string): string {
  return text
    // An empty thinking block the model sometimes writes even with thinking off; never said aloud.
    .replace(/<\/?think>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_#>|]+/g, ' ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Longest piece sent to text-to-speech at once (POST /api/tts takes up to 1,000 characters). */
const MAX_SPOKEN_CHARS = 900

/**
 * A whole reply as Jarvis says it: split into sentences the way a streamed
 * reply is, each cleaned with forSpeech (ones with nothing to say, like code blocks, dropped),
 * and very long ones cut at a comma or space. For replaying an earlier reply.
 */
export function spokenSentences(text: string): string[] {
  const splitter = new SentenceSplitter()
  const out: string[] = []
  // Code blocks span lines, and lines end sentences: take them out first.
  const prose = text.replace(/```[\s\S]*?(```|$)/g, '\n')
  for (const sentence of [...splitter.push(prose), ...splitter.flush()]) {
    let rest = forSpeech(sentence)
    if (!/[\p{L}\p{N}]/u.test(rest)) continue // nothing to say (a code block, a lone "—")
    while (rest.length > MAX_SPOKEN_CHARS) {
      const window = rest.slice(0, MAX_SPOKEN_CHARS)
      const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '))
      const at = cut > MAX_SPOKEN_CHARS / 2 ? cut + 1 : window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : MAX_SPOKEN_CHARS
      out.push(rest.slice(0, at).trim())
      rest = rest.slice(at).trim()
    }
    if (rest) out.push(rest)
  }
  return out
}

/**
 * Collects streamed text and hands out complete sentences as soon as they
 * end. Short fragments are kept until they make a reasonable sentence, and a
 * decimal point ("4.5") never ends one.
 */
export class SentenceSplitter {
  private buffer = ''
  private static readonly MIN_LENGTH = 12
  /** Words a first clause needs before it's said on its own ("Sure, the weather today," not "Yes, sir,"). */
  private static readonly FIRST_CLAUSE_WORDS = 4
  private started = false

  /**
   * quickStart: the reply's first piece ends at its first clause (a comma,
   * colon, semicolon or dash) when that comes before the sentence's end, so
   * text-to-speech has less to say before Jarvis makes a sound (synthesis takes
   * about a third of the audio's length, and a long first sentence held the
   * start back by over a second). The rest is synthesised while it plays.
   */
  private readonly options: { quickStart?: boolean }

  constructor(options: { quickStart?: boolean } = {}) {
    this.options = options
  }

  /** Adds streamed text; returns any sentences now complete. */
  push(delta: string): string[] {
    this.buffer += delta
    const out: string[] = []
    if (this.options.quickStart && !this.started) {
      const clause = this.firstClause()
      if (clause) out.push(clause)
    }
    for (;;) {
      // Sentence end: . ! ? … (optionally followed by quotes/brackets) then whitespace, or a line break.
      const match = /([.!?…]+["')\]]*\s+|\n+)/.exec(this.buffer)
      if (!match) break
      const end = match.index + match[0].length
      const sentence = this.buffer.slice(0, end).trim()
      if (sentence.length < SentenceSplitter.MIN_LENGTH && !/\n/.test(match[0])) {
        // Too short to say on its own ("Sure."): wait for the next sentence.
        const next = /([.!?…]+["')\]]*\s+|\n+)/.exec(this.buffer.slice(end))
        if (!next) break
        const combined = end + next.index + next[0].length
        out.push(this.buffer.slice(0, combined).trim())
        this.buffer = this.buffer.slice(combined)
        continue
      }
      if (sentence) out.push(sentence)
      this.buffer = this.buffer.slice(end)
    }
    if (out.length) this.started = true
    return out
  }

  /** The first clause, if it's complete, long enough, and ends before the first sentence does. */
  private firstClause(): string | undefined {
    const sentenceEnd = /([.!?…]+["')\]]*\s+|\n+)/.exec(this.buffer)
    const limit = sentenceEnd ? sentenceEnd.index : this.buffer.length
    // Followed by a space, so "1,000" and "10:30" aren't clause breaks.
    const breaks = /[,;:—–]\s+/g
    for (let m = breaks.exec(this.buffer); m && m.index < limit; m = breaks.exec(this.buffer)) {
      const clause = this.buffer.slice(0, m.index + 1).trim()
      if (clause.split(/\s+/).length < SentenceSplitter.FIRST_CLAUSE_WORDS) continue
      this.buffer = this.buffer.slice(m.index + m[0].length)
      this.started = true
      return clause
    }
    return undefined
  }

  /** Whatever is left at the end of the reply. */
  flush(): string[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest ? [rest] : []
  }
}
