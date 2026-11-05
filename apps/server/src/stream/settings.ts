// Per-session speech settings. Clients may send any subset; values are clamped
// to safe ranges so a bad client can't break the session.

export interface StreamSettings {
  /** Silero speech probability (0–1) above which a frame counts as speech. */
  speechThreshold: number
  /** How long a pause has to last to end the phrase. */
  pauseMs: number
  /** Audio kept from before speech starts, so the first syllable isn't clipped. */
  preSpeechPadMs: number
  /** Phrases with less speech than this are discarded (coughs, clicks). */
  minSpeechMs: number
  /** Phrases are force-split at this length even without a pause. */
  maxPhraseMs: number
  /** How often the phrase in progress is re-transcribed. */
  partialIntervalMs: number
  /** Voiceprint similarity (cosine) at or above which a phrase is the owner's. */
  speakerThreshold: number
  /**
   * Split a phrase where the voice before and after a point is less similar
   * than this (people taking turns without a pause). 0 = never split.
   */
  speakerChangeThreshold: number
}

export const DEFAULT_SETTINGS: StreamSettings = {
  speechThreshold: 0.5,
  pauseMs: 1200,
  preSpeechPadMs: 300,
  minSpeechMs: 250,
  maxPhraseMs: 25000,
  partialIntervalMs: 1000,
  // CAM++ on LibriSpeech: 1% of other people's phrases pass at 0.43 (docs/speaker-model-eval.md).
  speakerThreshold: 0.43,
  // Tuned with tools/speaker-eval/src/change-eval.ts (docs/speaker-model-eval.md).
  speakerChangeThreshold: 0.3,
}

const RANGES: Record<keyof StreamSettings, [number, number]> = {
  speechThreshold: [0.05, 0.95],
  pauseMs: [200, 5000],
  preSpeechPadMs: [0, 1000],
  minSpeechMs: [0, 2000],
  // audio.cpp is asked to transcribe up to 30 s in one piece.
  maxPhraseMs: [3000, 28000],
  partialIntervalMs: [250, 5000],
  speakerThreshold: [0.1, 0.9],
  speakerChangeThreshold: [0, 0.9],
}

export function mergeSettings(base: StreamSettings, update: unknown): StreamSettings {
  const merged = { ...base }
  if (typeof update !== 'object' || update === null) return merged
  for (const key of Object.keys(RANGES) as (keyof StreamSettings)[]) {
    const value = (update as Record<string, unknown>)[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const [min, max] = RANGES[key]
    merged[key] = Math.min(max, Math.max(min, value))
  }
  return merged
}

/**
 * How long the client keeps sending audio after the last speech frame. Must be
 * longer than the pause, so the server always sees enough silence to end the
 * phrase itself.
 */
export function sendHangoverMs(settings: StreamSettings): number {
  return settings.pauseMs + 300
}
