// Gives archived phrases recorded before speaker recognition existed a
// voiceprint and a speaker tag, oldest first (so groups form in the order
// people were actually heard).

import fs from 'node:fs'
import path from 'node:path'
import { OggOpusDecoder } from 'ogg-opus-decoder'
import { DEFAULT_SETTINGS } from '../stream/settings.ts'
import { SpeakerError, type Speakers } from './speakers.ts'

const BATCH = 50

export interface BackfillResult {
  processed: number
  owner: number
  others: number
  unknown: number
  failed: number
}

/** Decodes an archived .opus file to 16 kHz mono PCM (Opus decodes at 48 kHz; every 3rd sample). */
async function decodePhrase(decoder: OggOpusDecoder, file: string): Promise<Int16Array> {
  const decoded = await decoder.decodeFile(new Uint8Array(fs.readFileSync(file)))
  await decoder.reset()
  const ch = decoded.channelData[0]!
  const pcm = new Int16Array(Math.floor(ch.length / 3))
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(ch[i * 3]! * 32767)))
  return pcm
}

export async function backfillSpeakers(speakers: Speakers, dataDir: string, force = false): Promise<BackfillResult> {
  if (!speakers.enabled) throw new SpeakerError('Speaker recognition is off (no voiceprint model).')
  if (!force && speakers.ownerClips().length === 0) {
    throw new SpeakerError('Train your voice first, or your own past phrases would be grouped as someone else.')
  }
  const result: BackfillResult = { processed: 0, owner: 0, others: 0, unknown: 0, failed: 0 }
  const decoder = new OggOpusDecoder()
  await decoder.ready
  try {
    for (;;) {
      const batch = speakers.phrasesWithoutVoiceprint(BATCH)
      if (batch.length === 0) break
      for (const phrase of batch) {
        result.processed++
        try {
          const file = path.resolve(dataDir, phrase.audioPath)
          if (!file.startsWith(dataDir + path.sep) || !fs.existsSync(file)) throw new Error('audio missing')
          const vector = await speakers.voiceprint(await decodePhrase(decoder, file))
          // The archive doesn't keep the speech-only duration; the phrase duration is close (it includes ~0.5 s of padding).
          const speechMs = phrase.durationMs
          const tag = speakers.identify(vector, speechMs, DEFAULT_SETTINGS.speakerThreshold, phrase.status === 'ok')
          // Every processed phrase gets a tag (even "uncertain"), so it isn't picked up again.
          speakers.saveTag(phrase.id, vector, tag, speechMs, phrase.device)
          if (tag.isOwner) result.owner++
          else if (tag.speakerId !== null) result.others++
          else result.unknown++
        } catch {
          result.failed++
          speakers.saveTag(phrase.id, null, { speakerId: null, name: null, named: false, isOwner: null, similarity: null, match: null, confidence: 'uncertain' }, 0, null)
        }
      }
    }
  } finally {
    decoder.free()
  }
  return result
}
