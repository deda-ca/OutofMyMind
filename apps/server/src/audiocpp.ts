// Transcription (audio.stt, from audioConnections.ts) and the speech servers' health.

import { audioConnections, SttError, transcribeWav } from './audioConnections.ts'

/** A transcription failed (the server couldn't be reached, or said no). */
export const AudiocppError = SttError

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

/** Transcribes one phrase of s16le mono PCM with the transcription model ("connection/model"; default audio.stt). */
export async function transcribePcm(pcm: Buffer, sampleRate: number, language: string, ref?: string): Promise<string> {
  return transcribeWav(wavFromPcm(pcm, sampleRate), language, ref)
}

/** Whether the audio.cpp servers answer (OpenAI-style ones aren't asked: they're hosted, and asking costs nothing but isn't telling). */
export async function audiocppHealth(): Promise<{ ok: boolean; detail: string }> {
  const servers = audioConnections().filter((c) => c.kind === 'audiocpp')
  const results = await Promise.all(
    servers.map(async (c) => {
      try {
        const response = await fetch(new URL('/health', c.url), { signal: AbortSignal.timeout(3000) })
        return { ok: response.ok, detail: `${c.id}: ${response.ok ? 'ok' : `HTTP ${response.status}`}` }
      } catch (err) {
        return { ok: false, detail: `${c.id}: ${(err as Error).message}` }
      }
    }),
  )
  if (results.length === 1) return { ok: results[0]!.ok, detail: results[0]!.detail.replace(/^[^:]+: /, '') }
  return { ok: results.every((r) => r.ok), detail: results.map((r) => r.detail).join('; ') || 'ok' }
}
