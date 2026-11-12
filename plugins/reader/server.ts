// The Read aloud plugin (docs/reader.md): an editable page in its own tab,
// read aloud sentence by sentence in a chosen voice, with the sentence and
// word being read highlighted. The speech comes from Jarvis's own speech
// servers (any speech model and voice they have), asked for here: the tab
// can't reach anything itself, it asks through the bridge.
//
// Jarvis can hand it text to read (read_aloud): the page opens with it.

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { createPlugin, failure, pluginDataDir, refreshTab, serve, speak, speechOptions, text } from '../kit/plugin.ts'

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

type Prefs = { model?: string; voice?: string; rate?: number; zoom?: number }
function prefs(): Prefs {
  try {
    return JSON.parse(fs.readFileSync(prefsFile, 'utf8')) as Prefs
  } catch {
    return {}
  }
}

plugin.registerTool(
  'tab_voices',
  { description: "Read aloud tab: the speech models, the voices of the chosen one (or of `model`), Jarvis's voice, and the owner's choices.", inputSchema: { model: z.string().max(240).optional() } },
  async ({ model }) => {
    const saved = prefs()
    const chosen = model ?? saved.model ?? ''
    try {
      const o = await speechOptions(plugin, chosen || undefined)
      return json({ ...saved, models: o.models, model: chosen, defaultModel: o.tts, voices: o.voices, jarvis: o.voice })
    } catch (err) {
      return failure(`Couldn't get the voices: ${(err as Error).message}`)
    }
  },
)

plugin.registerTool(
  'tab_prefs',
  {
    description: 'Read aloud tab: remember the speech model, voice, speed and text size.',
    inputSchema: { model: z.string().max(240).optional(), voice: z.string().max(80).optional(), rate: z.number().min(0.5).max(2).optional(), zoom: z.number().min(0.5).max(4).optional() },
  },
  async (p) => {
    fs.writeFileSync(prefsFile, JSON.stringify(p))
    return json({ ok: true })
  },
)

plugin.registerTool(
  'tab_speak',
  { description: 'Read aloud tab: one piece of text as speech (a WAV, base64).', inputSchema: { text: z.string().min(1).max(MAX_CHARS), voice: z.string().max(80).optional(), model: z.string().max(240).optional() } },
  async ({ text: piece, voice, model }) => {
    try {
      return json({ wav: (await speak(plugin, piece, { voice, model })).toString('base64') })
    } catch (err) {
      return failure(`Text-to-speech failed: ${(err as Error).message}`)
    }
  },
)

plugin.registerTool('tab_take', { description: 'Read aloud tab: text Jarvis handed over, if any (taken once).', inputSchema: {} }, async () => {
  const p = pending
  pending = null
  return json(p)
})

await serve(plugin)
