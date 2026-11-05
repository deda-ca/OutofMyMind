// Downloads a balanced sample of LibriSpeech test-clean (CC BY 4.0): every
// speaker, a fixed number of utterances each, as 16 kHz mono WAV files plus a
// manifest. Uses the Hugging Face dataset viewer API, so only the chosen
// utterances are downloaded (not the whole 334 MB split).
//
// Usage: node src/fetch-librispeech.ts [utterancesPerSpeaker=10]

import fs from 'node:fs'
import path from 'node:path'
import { FLACDecoder } from '@wasm-audio-decoders/flac'
import { writeWav } from './wav.ts'

const API = 'https://datasets-server.huggingface.co/rows?dataset=openslr/librispeech_asr&config=clean&split=test'
const OUT = path.resolve('data/librispeech')
const PER_SPEAKER = Number(process.argv[2] ?? 10)
/** Rough speech duration from text length; LibriSpeech reads ~15 characters per second. */
const MIN_CHARS = 60 // ~4 s
const MAX_CHARS = 220 // ~15 s

interface Row {
  id: string
  speaker_id: number
  chapter_id: number
  text: string
  audio: { src: string; type: string }[]
}

async function json<T>(url: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url)
    if (response.ok) return (await response.json()) as T
    if (attempt >= 4) throw new Error(`${response.status} ${url}`)
    await new Promise((r) => setTimeout(r, 2000 * attempt))
  }
}

async function allRows(): Promise<Row[]> {
  const rows: Row[] = []
  for (let offset = 0; ; offset += 100) {
    const page = await json<{ rows: { row: Row }[]; num_rows_total: number }>(`${API}&offset=${offset}&length=100`)
    rows.push(...page.rows.map((r) => r.row))
    process.stdout.write(`\rlisted ${rows.length}/${page.num_rows_total} utterances`)
    if (rows.length >= page.num_rows_total || page.rows.length === 0) break
  }
  process.stdout.write('\n')
  return rows
}

/** Spread picks across chapters, so a speaker isn't one recording session. */
function pick(rows: Row[]): Row[] {
  const byChapter = new Map<number, Row[]>()
  for (const row of rows.filter((r) => r.text.length >= MIN_CHARS && r.text.length <= MAX_CHARS)) {
    byChapter.set(row.chapter_id, [...(byChapter.get(row.chapter_id) ?? []), row])
  }
  const chapters = [...byChapter.values()]
  const picked: Row[] = []
  for (let i = 0; picked.length < PER_SPEAKER && chapters.some((c) => c.length > i); i++) {
    for (const chapter of chapters) if (chapter[i] && picked.length < PER_SPEAKER) picked.push(chapter[i]!)
  }
  return picked
}

const rows = await allRows()
const bySpeaker = new Map<number, Row[]>()
for (const row of rows) bySpeaker.set(row.speaker_id, [...(bySpeaker.get(row.speaker_id) ?? []), row])

const decoder = new FLACDecoder()
await decoder.ready
const manifest: { speaker: string; id: string; file: string; seconds: number; text: string }[] = []

for (const [speaker, speakerRows] of [...bySpeaker].sort((a, b) => a[0] - b[0])) {
  const chosen = pick(speakerRows)
  for (const row of chosen) {
    const file = path.join(OUT, String(speaker), `${row.id}.wav`)
    if (!fs.existsSync(file)) {
      const flac = new Uint8Array(await (await fetch(row.audio[0]!.src)).arrayBuffer())
      const decoded = await decoder.decodeFile(flac)
      if (decoded.sampleRate !== 16000) throw new Error(`${row.id}: expected 16 kHz, got ${decoded.sampleRate}`)
      await decoder.reset()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      writeWav(file, decoded.channelData[0]!, 16000)
    }
    const seconds = (fs.statSync(file).size - 44) / 2 / 16000
    manifest.push({ speaker: String(speaker), id: row.id, file: path.relative(OUT, file), seconds, text: row.text })
  }
  console.log(`speaker ${speaker}: ${chosen.length} utterances`)
}
decoder.free()

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1))
const total = manifest.reduce((s, m) => s + m.seconds, 0)
console.log(`${bySpeaker.size} speakers, ${manifest.length} utterances, ${(total / 60).toFixed(1)} min → ${OUT}`)
