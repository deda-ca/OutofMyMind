// Speech servers (config.jsonc audio.connections): transcription and
// text-to-speech can come from several at once. Transcription and speech each
// use a "connection/model" (audio.stt, audio.tts; agents may pick their own
// speech model), and the voice is picked separately, from the ones that
// model's server has. Without the list, audio.url / asrModel / ttsModel are one
// audio.cpp connection called "local", as before.
//
//   audiocpp   an audio.cpp server: lists its models (/v1/models, by task) and voices
//   openai     an OpenAI-style speech API: /v1/audio/transcriptions, /v1/audio/speech

import { config, configFile } from './config.ts'

export interface AudioConnection {
  id: string
  label: string
  kind: 'audiocpp' | 'openai'
  url: string
  apiKey?: string
  /** Transcription models offered (empty, audiocpp: the ones it lists). */
  stt: string[]
  /** Text-to-speech models offered (empty, audiocpp: the ones it lists). */
  tts: string[]
  /** Voices (empty, audiocpp: the ones it lists). */
  voices: string[]
}

export class AudioConfigError extends Error {}

const ID = /^[A-Za-z0-9_-]{1,32}$/
const expand = (v: string) => v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => process.env[n] ?? '')
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [])

/** The connections from a config file's root (exported for tests), or the one audio.cpp from audio.url. */
export function readAudioConnections(root: Record<string, unknown>, fallback = { url: config.audiocppUrl }): AudioConnection[] {
  const list = ((root.audio ?? {}) as Record<string, unknown>).connections
  if (list === undefined) return [{ id: 'local', label: 'audio.cpp', kind: 'audiocpp', url: fallback.url, stt: [], tts: [], voices: [] }]
  if (!Array.isArray(list) || list.length === 0) throw new AudioConfigError('audio.connections should be a list, like [{ "id": "local", "kind": "audiocpp", "url": "…" }]')
  const seen = new Set<string>()
  return list.map((raw, i): AudioConnection => {
    const c = (raw ?? {}) as Record<string, unknown>
    const where = `audio.connections[${i}]`
    const str = (k: string) => (typeof c[k] === 'string' ? expand(c[k] as string).trim() : '')
    const id = str('id')
    if (!ID.test(id)) throw new AudioConfigError(`${where}.id should be a short name (letters, digits, _ or -)`)
    if (seen.has(id)) throw new AudioConfigError(`${where}: there are two connections called "${id}"`)
    seen.add(id)
    const kind = c.kind === undefined ? 'audiocpp' : c.kind
    if (kind !== 'audiocpp' && kind !== 'openai') throw new AudioConfigError(`${where}.kind should be "audiocpp" or "openai"`)
    const url = str('url') || (kind === 'openai' ? 'https://api.openai.com' : '')
    if (!url) throw new AudioConfigError(`${where}: an audiocpp connection needs its "url"`)
    const stt = strings(c.stt)
    const tts = strings(c.tts)
    const voices = strings(c.voices)
    if (kind === 'openai' && !stt.length && !tts.length) throw new AudioConfigError(`${where}: list its models ("stt" and/or "tts")`)
    if (kind === 'openai' && tts.length && !voices.length) throw new AudioConfigError(`${where}: list its "voices" (an OpenAI-style server doesn't say which it has)`)
    return { id, label: str('label') || id, kind, url, ...(str('apiKey') ? { apiKey: str('apiKey') } : {}), stt, tts, voices }
  })
}

let cached: AudioConnection[] | null = null

/** The connections (audio.connections read once; the single audio.url one follows config as it is). */
export function audioConnections(): AudioConnection[] {
  if ((configFile.root.audio as Record<string, unknown> | undefined)?.connections === undefined) return readAudioConnections({})
  cached ??= readAudioConnections(configFile.root)
  return cached
}

export type Task = 'stt' | 'tts'

const split = (ref: string) => {
  const at = ref.indexOf('/')
  return at > 0 && at < ref.length - 1 ? { connection: ref.slice(0, at), model: ref.slice(at + 1) } : null
}

/** The default "connection/model" for transcription or speech: audio.stt/audio.tts, else the first configured, else asrModel/ttsModel on the first connection. */
export function defaultAudioRef(task: Task, list = audioConnections(), chosen = (task === 'stt' ? process.env.AUDIO_STT : process.env.AUDIO_TTS)?.trim() ?? ''): string {
  const r = chosen ? split(chosen) : null
  if (r && list.some((c) => c.id === r.connection)) return chosen
  const configured = list.find((c) => c[task].length)
  if (configured) return `${configured.id}/${configured[task][0]}`
  const audiocpp = list.find((c) => c.kind === 'audiocpp') ?? list[0]!
  return `${audiocpp.id}/${task === 'stt' ? config.asrModel : config.ttsModel}`
}

/** Which connection and model for "connection/model" (an agent's speech model), or the default; an unknown connection falls back (said in `note`). */
export function resolveAudio(task: Task, ref?: string, list = audioConnections()): { connection: AudioConnection; model: string; note?: string } {
  const pick = (r: { connection: string; model: string }) => {
    const c = list.find((x) => x.id === r.connection)
    return c ? { connection: c, model: r.model } : null
  }
  const wanted = ref ? split(ref) : null
  const found = wanted ? pick(wanted) : null
  if (found) return found
  const fallback = pick(split(defaultAudioRef(task, list))!)!
  return wanted ? { ...fallback, note: `the speech connection "${wanted.connection}" isn't in audio.connections: using ${fallback.connection.id}/${fallback.model}` } : fallback
}

const auth = (c: AudioConnection): Record<string, string> => (c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {})

// ------------------------------------------------------------------ listing (for the pickers)

const modelCache = new Map<string, { at: number; stt: string[]; tts: string[]; error?: string }>()

/** A connection's models: its lists, else (audiocpp) what it lists, by task. Cached a minute. */
export async function audioModels(c: AudioConnection): Promise<{ stt: string[]; tts: string[]; error?: string }> {
  if (c.kind === 'openai' || (c.stt.length && c.tts.length)) return { stt: c.stt, tts: c.tts }
  const hit = modelCache.get(c.id)
  if (hit && Date.now() - hit.at < 60_000) return hit
  let found: { stt: string[]; tts: string[]; error?: string }
  try {
    const r = await fetch(new URL('/v1/models', c.url), { headers: auth(c), signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = ((await r.json()) as { data?: { id?: unknown; task?: unknown }[] }).data ?? []
    const of = (task: string) => data.filter((m) => m.task === task).map((m) => String(m.id ?? '')).filter(Boolean)
    found = { stt: of('asr'), tts: of('tts') }
  } catch (err) {
    found = { stt: [], tts: [], error: `couldn't list its models: ${(err as Error).message}` }
  }
  const result = { stt: c.stt.length ? c.stt : found.stt, tts: c.tts.length ? c.tts : found.tts, ...(found.error ? { error: found.error } : {}) }
  modelCache.set(c.id, { at: Date.now(), ...result })
  return result
}

const voiceCache = new Map<string, { at: number; voices: string[] }>()

/** The voices for a text-to-speech model ("connection/model"; default audio.tts). Cached a minute. */
export async function audioVoices(ref?: string): Promise<string[]> {
  const { connection: c, model } = resolveAudio('tts', ref)
  if (c.voices.length || c.kind === 'openai') return c.voices
  const key = `${c.id}/${model}`
  const hit = voiceCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.voices
  try {
    const r = await fetch(new URL(`/v1/audio/voices?model=${encodeURIComponent(model)}`, c.url), { headers: auth(c), signal: AbortSignal.timeout(5000) })
    const voices = ((await r.json()) as { voices?: unknown }).voices
    if (Array.isArray(voices)) {
      voiceCache.set(key, { at: Date.now(), voices: voices.map(String) })
      return voices.map(String)
    }
  } catch {
    // keep what we had
  }
  return hit?.voices ?? [config.ttsVoice]
}

// ------------------------------------------------------------------ transcription and speech

export class SttError extends Error {}
export class TtsError extends Error {}

/** Larger than any phrase we send, so audio.cpp transcribes each phrase as one piece (its streaming mode would split it into 2 s pieces). */
const CHUNK_SECONDS = '30'

/** audio.cpp takes the language's name ("English"); OpenAI-style servers its ISO code. */
const ISO: Record<string, string> = { english: 'en', french: 'fr', arabic: 'ar', spanish: 'es', german: 'de', italian: 'it', portuguese: 'pt', chinese: 'zh', japanese: 'ja', korean: 'ko', russian: 'ru', dutch: 'nl', hindi: 'hi', turkish: 'tr', polish: 'pl' }

/** Transcribes a WAV file with the transcription model ("connection/model"; default audio.stt). */
export async function transcribeWav(wav: Buffer, language: string, ref?: string, list = audioConnections()): Promise<string> {
  const { connection: c, model } = resolveAudio('stt', ref, list)
  let response: Response
  try {
    if (c.kind === 'audiocpp') {
      // /v1/tasks/run: audio.cpp's only transcription route that takes per-request options with uploaded audio.
      const request: Record<string, unknown> = { task: 'asr', text: '', audio_base64: wav.toString('base64'), options: { audio_chunk_seconds: CHUNK_SECONDS }, ...(language ? { language } : {}) }
      response = await fetch(new URL('/v1/tasks/run', c.url), { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(c) }, body: JSON.stringify({ model, request }) })
    } else {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'phrase.wav')
      form.append('model', model)
      const code = ISO[language.toLowerCase()] ?? (/^[a-z]{2}$/i.test(language) ? language.toLowerCase() : '')
      if (code) form.append('language', code)
      response = await fetch(new URL('/v1/audio/transcriptions', c.url), { method: 'POST', headers: auth(c), body: form, signal: AbortSignal.timeout(60_000) })
    }
  } catch (err) {
    throw new SttError(`Could not reach ${c.label} at ${c.url}: ${(err as Error).message}`)
  }
  const body = (await response.json().catch(() => ({}))) as { text?: string; error?: { message?: string } | string }
  if (!response.ok) {
    const message = typeof body.error === 'string' ? body.error : body.error?.message
    throw new SttError(`${c.label} returned HTTP ${response.status}: ${message ?? 'unknown error'}`)
  }
  return (body.text ?? '').trim()
}

/** Speaks a piece of text with the speech model ("connection/model"; default audio.tts) in a voice; returns a WAV file. */
export async function speakWav(text: string, voice: string, ref?: string, signal?: AbortSignal, list = audioConnections()): Promise<Buffer> {
  const { connection: c, model } = resolveAudio('tts', ref, list)
  let response: Response
  try {
    response = await fetch(new URL('/v1/audio/speech', c.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(c) },
      // OpenAI answers MP3 unless asked for WAV (the client and the phone play WAV).
      body: JSON.stringify({ model, input: text, voice, ...(c.kind === 'openai' ? { response_format: 'wav' } : {}) }),
      signal,
    })
  } catch (err) {
    throw new TtsError(`Could not reach ${c.label} for speech: ${(err as Error).message}`)
  }
  if (!response.ok) throw new TtsError(`Text-to-speech failed (HTTP ${response.status}): ${(await response.text().catch(() => '')).slice(0, 200)}`)
  return fixWavSizes(Buffer.from(await response.arrayBuffer()))
}

/** A streamed WAV says "unknown size" (0xFFFFFFFF) in its header: the real sizes, now that it's all here (exported for tests). */
export function fixWavSizes(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return wav
  let at = 12
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4)
    const size = wav.readUInt32LE(at + 4)
    if (id === 'data') {
      if (at + 8 + size > wav.length) wav.writeUInt32LE(wav.length - at - 8, at + 4)
      wav.writeUInt32LE(wav.length - 8, 4)
      break
    }
    at += 8 + size + (size % 2)
  }
  return wav
}
