// Dropping files into the conversation (server: apps/server/src/files/routes.ts).
// Each file is uploaded to the workspace (uploads/<day>/), then all of them are
// added to the active session as one message.

/** A file in the workspace. */
export interface FileRef {
  /** Relative to the workspace: "uploads/2026-11-09/photo.jpg". */
  path: string
  name: string
  type: string
  size: number
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

/** Uploads the files, then adds them to the session. Returns them as saved, and the active session. */
export async function addFiles(files: File[], onProgress?: (done: number) => void): Promise<{ files: FileRef[]; activeId: string | null }> {
  const saved: FileRef[] = []
  for (const file of files) {
    const { file: ref } = await json<{ file: FileRef }>(
      await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.jarvis.upload', 'X-File-Name': encodeURIComponent(file.name), 'X-File-Type': file.type },
        body: file,
      }),
    )
    saved.push(ref)
    onProgress?.(saved.length)
  }
  return json<{ files: FileRef[]; activeId: string | null }>(
    await fetch('/api/uploads/attach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: saved }) }),
  )
}

export const fileUrl = (file: FileRef) => `/api/workspace-file?path=${encodeURIComponent(file.path)}`

export function kindOf(file: FileRef): 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'other' {
  const name = file.name.toLowerCase()
  if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|svg)$/.test(name)) return 'image'
  if (file.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|opus|flac)$/.test(name)) return 'audio'
  if (file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/.test(name)) return 'video'
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (file.type.startsWith('text/') || /\.(md|txt|csv|json|ya?ml)$/.test(name)) return 'text'
  return 'other'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}
