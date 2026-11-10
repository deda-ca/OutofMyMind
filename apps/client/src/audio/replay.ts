// ▶ on a reply from Jarvis: hear it again, in Jarvis's voice.
//
// A recent live reply still has its audio in the player (instant). Anything
// older, or from a saved session, is spoken again: the server splits it into
// sentences the way Jarvis speaks (POST /api/tts/sentences) and each is
// synthesised in turn (POST /api/tts), playing as soon as the first is ready.
// Pressing ■ (the same button), or a new reply from Jarvis, stops it.

import { reactive } from 'vue'
import type { SpeechPlayer } from './speechPlayer'

export const replay = reactive({
  /** The reply being replayed (its key in the transcript), or ''. */
  key: '',
  /** Waiting for its first sentence. */
  loading: false,
})

/** Each press gets a number, so a finished older replay doesn't clear a newer one. */
let pressed = 0

/**
 * Replay (or, if it's the one playing, stop) a reply. `liveReplyId`: the
 * server's reply id, for a reply from this page's live conversation.
 */
export async function toggleReplay(player: SpeechPlayer, key: string, text: string, liveReplyId?: number, voice?: string): Promise<void> {
  if (replay.key === key) {
    pressed++ // a replay still fetching its first sentence won't start
    replay.key = ''
    replay.loading = false
    player.cancel()
    return
  }
  const press = ++pressed
  replay.key = key
  replay.loading = false
  // The press is the user gesture the browser wants before it plays sound.
  void player.unlock()
  try {
    if (liveReplyId !== undefined && player.has(liveReplyId)) await player.repeat(liveReplyId)
    else await speak(player, text, () => press === pressed, voice)
  } finally {
    if (press === pressed) {
      replay.key = ''
      replay.loading = false
    }
  }
}

/** `voice`: the agent's (unset: Jarvis's default). */
async function speak(player: SpeechPlayer, text: string, current: () => boolean, voice?: string): Promise<void> {
  replay.loading = true
  const response = await fetch('/api/tts/sentences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  if (!response.ok) throw new Error(await problem(response))
  const { sentences } = (await response.json()) as { sentences: string[] }
  if (!current() || sentences.length === 0) return
  const finished = player.playFetched(sentences.length, async (i, signal) => {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: sentences[i], ...(voice ? { voice } : {}) }), signal })
    if (!r.ok) throw new Error(await problem(r))
    if (i === 0 && current()) replay.loading = false
    return r.arrayBuffer()
  })
  await finished
}

async function problem(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  return body.error ?? `HTTP ${response.status}`
}
