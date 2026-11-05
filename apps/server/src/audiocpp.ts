// Client for the local audio.cpp server.

import { config } from './config.ts'

/**
 * Larger than any phrase we send, so audio.cpp transcribes each phrase as one
 * piece. The server config sets audio_chunk_seconds=2 for its streaming mode,
 * which would otherwise split every phrase into 2 s pieces.
 */
const CHUNK_SECONDS = '30'

export class AudiocppError extends Error {}

/** Wraps raw s16le mono PCM in a WAV header. */
export function wavFromPcm(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * Transcribes one phrase of s16le mono PCM.
 *
 * Uses /v1/tasks/run because it is the only transcription route that accepts
 * per-request options together with uploaded audio.
 */
export async function transcribePcm(pcm: Buffer, sampleRate: number, language: string): Promise<string> {
  const request: Record<string, unknown> = {
    task: 'asr',
    text: '',
    audio_base64: wavFromPcm(pcm, sampleRate).toString('base64'),
    options: { audio_chunk_seconds: CHUNK_SECONDS },
  }
  if (language) request.language = language

  let response: Response
  try {
    response = await fetch(new URL('/v1/tasks/run', config.audiocppUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.asrModel, request }),
    })
  } catch (err) {
    throw new AudiocppError(`Could not reach audio.cpp at ${config.audiocppUrl}: ${(err as Error).message}`)
  }
  const body = (await response.json().catch(() => ({}))) as { text?: string; error?: { message?: string } | string }
  if (!response.ok) {
    const message = typeof body.error === 'string' ? body.error : body.error?.message
    throw new AudiocppError(`audio.cpp returned HTTP ${response.status}: ${message ?? 'unknown error'}`)
  }
  return (body.text ?? '').trim()
}

export async function audiocppHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(new URL('/health', config.audiocppUrl), { signal: AbortSignal.timeout(3000) })
    return { ok: response.ok, detail: response.ok ? 'ok' : `HTTP ${response.status}` }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}
