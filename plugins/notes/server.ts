// The notes plugin: Jarvis reads and writes markdown notes in NOTES_DIR.
// Run by the harness (see apps/server/mcp.json); try it alone with
//   NOTES_DIR=/tmp/notes npx @modelcontextprotocol/inspector node notes/server.ts

import { z } from 'zod'
import { createPlugin, failure, log, serve, text } from '../kit/plugin.ts'
import { NotesStore } from './store.ts'

const dir = process.env.NOTES_DIR?.trim()
if (!dir) {
  log('notes: NOTES_DIR is not set')
  process.exit(1)
}
const store = new NotesStore(dir)
await store.init()

const plugin = createPlugin(
  'notes',
  '0.1.0',
  'The owner\'s markdown notes. Paths are relative to the notes folder, like "shopping" or "projects/jarvis" (".md" is added). Read a note before changing it; prefer append_to_note for adding to lists.',
)

/** Runs a tool body, turning thrown errors into a failure the model can read. */
async function attempt(body: () => Promise<string>) {
  try {
    return text(await body())
  } catch (err) {
    return failure((err as Error).message)
  }
}

plugin.registerTool(
  'list_notes',
  {
    description: 'List the notes (optionally only those in a folder), with size and last change.',
    inputSchema: { folder: z.string().optional().describe('A folder inside the notes folder, e.g. "projects".') },
    annotations: { readOnlyHint: true },
  },
  ({ folder }) =>
    attempt(async () => {
      const notes = await store.list(folder)
      if (notes.length === 0) return folder ? `No notes in "${folder}".` : 'There are no notes yet.'
      return notes.map((n) => `${n.path}  (${n.bytes} bytes, changed ${n.modified})`).join('\n')
    }),
)

plugin.registerTool(
  'read_note',
  {
    description: 'Read a note in full.',
    inputSchema: { path: z.string().describe('e.g. "shopping" or "projects/jarvis.md"') },
    annotations: { readOnlyHint: true },
  },
  ({ path }) => attempt(() => store.read(path)),
)

plugin.registerTool(
  'search_notes',
  {
    description: 'Find notes whose name or text contains the words (case-insensitive). Returns matching lines.',
    inputSchema: { query: z.string() },
    annotations: { readOnlyHint: true },
  },
  ({ query }) =>
    attempt(async () => {
      const hits = await store.search(query)
      if (hits.length === 0) return `Nothing found for "${query}".`
      return hits.map((h) => (h.line ? `${h.path}:${h.line}: ${h.text}` : `${h.path}: ${h.text}`)).join('\n')
    }),
)

plugin.registerTool(
  'write_note',
  {
    description: 'Create a note, or replace a note\'s whole content. To add to a note, use append_to_note instead.',
    inputSchema: { path: z.string(), content: z.string().describe('The full markdown content.') },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  ({ path, content }) =>
    attempt(async () => {
      const result = await store.write(path, content)
      return `${result.created ? 'Created' : 'Replaced'} ${result.relative}.`
    }),
)

plugin.registerTool(
  'append_to_note',
  {
    description: 'Add text to the end of a note (created if missing). Good for lists and logs.',
    inputSchema: { path: z.string(), text: z.string().describe('Markdown to add, e.g. "- milk".') },
    annotations: { destructiveHint: false },
  },
  ({ path, text: addition }) =>
    attempt(async () => {
      const result = await store.append(path, addition)
      return `${result.created ? 'Created' : 'Added to'} ${result.relative}.`
    }),
)

await serve(plugin)
log(`notes: serving ${store.root}`)
