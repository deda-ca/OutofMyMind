// The Read aloud plugin (docs/reader.md): an editable page in its own tab,
// read aloud sentence by sentence in a chosen voice, with the sentence and
// word being read highlighted. The speech comes from audio.cpp (the same
// text-to-speech Jarvis speaks with), fetched here: the tab can't reach
// anything itself, it asks through the bridge.
//
// Jarvis can hand it text to read (read_aloud): the page opens with it.

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { createPlugin, failure, pluginDataDir, refreshTab, serve, text } from '../kit/plugin.ts'

const env = (k: string, fallback: string) => process.env[k]?.trim() || fallback
const audiocpp = env('AUDIOCPP_URL', 'http://127.0.0.1:5552')
const model = env('TTS_MODEL', 'Qwen3-TTS')
const jarvisVoice = env('TTS_VOICE', 'jarvis')
/** Longest piece synthesised at once (the tab splits long sentences at commas). */
const MAX_CHARS = 1000

const dataDir = pluginDataDir || path.resolve('data')
fs.mkdirSync(dataDir, { recursive: true })
const prefsFile = path.join(dataDir, 'prefs.json')

const plugin = createPlugin(
  'reader',
  '0.1.0',
  "Read aloud: a page in its own tab, read to the owner in a chosen voice with the words highlighted. To read something to them (an article, a document, an email), get its text yourself, then hand it over with read_aloud: it opens in the Read aloud tab, ready to play.",
)

/** Text Jarvis handed over, waiting for the tab to take it. */
let pending: { text: string; title: string; at: string } | null = null

plugin.registerTool(
  'read_aloud',
  {
    description: 'Put text in the Read aloud tab for the owner to listen to (Markdown is shown formatted). Get the text first (a file, a web page, an email); the owner presses Play there.',
    inputSchema: { text: z.string().min(1).max(200_000), title: z.string().max(120).optional().describe('What it is, e.g. the article\'s title.') },
  },
  async ({ text: body, title }) => {
    pending = { text: body, title: title ?? '', at: new Date().toISOString() }
    await refreshTab(plugin)
    return text(`It's in the Read aloud tab${title ? ` ("${title}")` : ''}, ready to play: say so in a few words.`)
  },
)

// ------------------------------------------------------------------ tools for the tab

const json = (v: unknown) => text(JSON.stringify(v))

let voiceCache: { voices: string[]; at: number } | null = null

plugin.registerTool('tab_voices', { description: 'Read aloud tab: the voices, Jarvis\'s, and the owner\'s choice.', inputSchema: {} }, async () => {
  if (!voiceCache || Date.now() - voiceCache.at > 60_000) {
    try {
      const r = await fetch(new URL('/v1/audio/voices', audiocpp), { signal: AbortSignal.timeout(5000) })
      const v = ((await r.json()) as { voices?: unknown }).voices
      if (Array.isArray(v)) voiceCache = { voices: v.map(String), at: Date.now() }
    } catch {
      // keep what we had
    }
  }
  let prefs: { voice?: string; rate?: number; zoom?: number } = {}
  try {
    prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8')) as typeof prefs
  } catch {
    // none yet
  }
  return json({ voices: voiceCache?.voices ?? [jarvisVoice], jarvis: jarvisVoice, ...prefs })
})

plugin.registerTool(
  'tab_prefs',
  { description: 'Read aloud tab: remember the voice, speed and text size.', inputSchema: { voice: z.string().max(80).optional(), rate: z.number().min(0.5).max(2).optional(), zoom: z.number().min(0.5).max(4).optional() } },
  async (p) => {
    fs.writeFileSync(prefsFile, JSON.stringify(p))
    return json({ ok: true })
  },
)

plugin.registerTool(
  'tab_speak',
  { description: 'Read aloud tab: one piece of text as speech (a WAV, base64).', inputSchema: { text: z.string().min(1).max(MAX_CHARS), voice: z.string().max(80).optional() } },
  async ({ text: piece, voice }) => {
    let response: Response
    try {
      response = await fetch(new URL('/v1/audio/speech', audiocpp), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: piece, voice: voice || jarvisVoice }),
        signal: AbortSignal.timeout(60_000),
      })
    } catch (err) {
      return failure(`Couldn't reach audio.cpp for speech: ${(err as Error).message}`)
    }
    if (!response.ok) return failure(`Text-to-speech failed (HTTP ${response.status}): ${(await response.text().catch(() => '')).slice(0, 200)}`)
    return json({ wav: Buffer.from(await response.arrayBuffer()).toString('base64') })
  },
)

plugin.registerTool('tab_take', { description: 'Read aloud tab: text Jarvis handed over, if any (taken once).', inputSchema: {} }, async () => {
  const p = pending
  pending = null
  return json(p)
})

await serve(plugin)
