// Which workspace file the document viewer shows (null: closed), and a
// counter bumped when it should re-read the file (e.g. Jarvis just edited it).

import { reactive } from 'vue'

export const viewer = reactive({
  /** Relative to the workspace: "todo.md", "uploads/2026-11-09/notes.md". */
  path: null as string | null,
  version: 0,
})

export function openFile(path: string): void {
  viewer.path = path.replace(/^\/+/, '').replace(/^workspace\//, '')
  viewer.version++
}

export function closeFile(): void {
  viewer.path = null
}

export function refreshFile(): void {
  if (viewer.path) viewer.version++
}

/** Files the viewer shows itself (Markdown and other text, images, PDFs); anything else opens raw. */
export function viewable(path: string): boolean {
  return /\.(md|markdown|txt|csv|json|ya?ml|log|png|jpe?g|gif|webp|svg|pdf)$/i.test(path)
}

/** A path in the workspace from one written in a file at `from` ("../photos/a.png" in "notes/trip.md" → "photos/a.png"). */
export function resolvePath(from: string, target: string): string {
  const base = target.startsWith('/') ? [] : from.split('/').slice(0, -1)
  for (const part of decodeURI(target).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') base.pop()
    else base.push(part)
  }
  return base.join('/')
}
