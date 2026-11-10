// Tool calls as the transcript shows them: what they did (CRUD) and which files they touched.

/** A tool call (server: ToolCallDetail in apps/server/src/assistant/llm.ts). */
export interface ToolCallInfo {
  id: string
  /** Function name, e.g. "files__edit_file". */
  name: string
  /** Arguments as JSON text. */
  args: string
  /** create / read / update / delete. */
  crud: string[]
  status: 'running' | 'done'
  result?: string
  isError?: boolean
  durationMs?: number
}

export const CRUD_PILLS: Record<string, { label: string; theme: string }> = {
  create: { label: 'create', theme: 'theme-success' },
  read: { label: 'read', theme: 'theme-info' },
  update: { label: 'update', theme: 'theme-warning' },
  delete: { label: 'delete', theme: 'theme-danger' },
}

/** Argument names that hold file or folder paths, in the plugins Jarvis uses and most others. */
const PATH_KEYS = /^(path|paths|source|destination|dest|from|to|file|files|filename|filepath|file_path|dir|directory|folder|target|note)$/i

/** The files and folders a call names in its arguments (e.g. path, source + destination, paths[]). */
export function filesIn(args: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return []
  }
  const found: string[] = []
  const visit = (value: unknown, key: string, depth: number) => {
    if (depth > 4) return
    if (typeof value === 'string' && PATH_KEYS.test(key)) found.push(value)
    else if (Array.isArray(value)) for (const v of value) visit(v, key, depth + 1)
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k, depth + 1)
  }
  visit(parsed, '', 0)
  return [...new Set(found)]
}

/** Files the side panel can't show (it shows Markdown, images, PDFs and any text). */
const BINARY = /\.(zip|gz|tgz|tar|7z|rar|docx?|xlsx?|pptx?|odt|ods|mp3|wav|ogg|m4a|flac|mp4|mov|webm|mkv|exe|bin|so|dylib|dll|db|sqlite)$/i
/** Tools that work on folders, whose paths aren't files to open. */
const FOLDER_TOOL = /director|folder|_dir\b|tree|list_allowed/i

/**
 * The workspace path to open in the side panel for a path a tool call named,
 * or null if it isn't a file there that can be shown (a folder, outside the
 * workspace, binary, or deleted by the call). The notes plugin names notes by
 * their path in notes/ ("shopping" → notes/shopping.md).
 */
export function workspaceFile(call: Pick<ToolCallInfo, 'name' | 'crud'>, path: string): string | null {
  if (call.crud.includes('delete') || FOLDER_TOOL.test(call.name)) return null
  let rel: string
  const at = path.lastIndexOf('/workspace/')
  if (at !== -1) rel = path.slice(at + '/workspace/'.length)
  else if (call.name.startsWith('notes__') && !path.startsWith('/')) rel = `notes/${path.replace(/^\.?\/+/, '')}${/\.md$/i.test(path) ? '' : '.md'}`
  else return null
  const name = rel.split('/').pop() ?? ''
  if (!rel || rel.split('/').includes('..') || !name.includes('.') || BINARY.test(name)) return null
  return rel
}

/** A path as the owner thinks of it: from the workspace folder on, if it's inside one. */
export function shortPath(path: string): string {
  const at = path.lastIndexOf('/workspace/')
  return at === -1 ? path : path.slice(at + 1)
}

/** The arguments, pretty-printed (as given if they aren't JSON). */
export function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}
