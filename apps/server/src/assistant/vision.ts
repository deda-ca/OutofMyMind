// Images the LLM can see (LLM_VISION=on, for a model with vision: llama.cpp
// with its --mmproj image projector). The conversation stays text: a photo
// the owner added (on a screen or from Telegram) is a line
// "[image attached: uploads/…/photo.jpg]" in its "files" message. Only when a
// request goes to the LLM are the latest few such images attached as the
// images themselves (OpenAI-style content parts), so history, the context
// meter and the Debug tab stay readable.

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.ts'

/** The most images sent with one request (each costs hundreds to a few thousand tokens). */
export const MAX_IMAGES = 3
/** Bigger image files aren't attached. */
export const MAX_IMAGE_BYTES = 8_000_000

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }
export const IMAGE_FILE = /\.(jpe?g|png|webp|gif)$/i
const MARK = /\[image attached: ([^\]\n]+)\]/g

/** The line a files message carries for an image (workspace-relative path). */
export function imageMark(relativePath: string): string {
  return `[image attached: ${relativePath}]`
}

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/**
 * The messages as sent: the newest `max` marked images (in owner messages
 * only, inside the workspace) attached; older marks say they're no longer
 * attached. Messages without marks are left as they are.
 */
export function attachImages<T extends { role: string; content?: unknown }>(messages: T[], workspaceDir = config.workspaceDir, max = MAX_IMAGES): T[] {
  let root: string
  try {
    root = fs.realpathSync(workspaceDir)
  } catch {
    return messages
  }
  let left = max
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!
    if (m.role !== 'user' || typeof m.content !== 'string' || !m.content.includes('[image attached: ')) continue
    const marks = [...m.content.matchAll(MARK)]
    const images: Part[] = []
    let text = m.content
    // Newest last in a message: attach from the end so the latest are kept.
    for (const mark of marks.reverse()) {
      const data = left > 0 ? read(root, mark[1]!.trim()) : null
      if (data) {
        left--
        images.unshift({ type: 'image_url', image_url: { url: data } })
        text = text.replace(mark[0], '(the image is attached: you can see it)')
      } else {
        text = text.replace(mark[0], '(an earlier image: no longer attached, so you can\'t see it now; ask the owner to send it again if needed)')
      }
    }
    out[i] = { ...m, content: images.length ? [{ type: 'text', text }, ...images] : text }
  }
  return out
}

/** The image as a data URL, if it's an image file inside the workspace and not too big. */
function read(root: string, relative: string): string | null {
  try {
    const file = fs.realpathSync(path.resolve(root, relative))
    if (!file.startsWith(root + path.sep) || !IMAGE_FILE.test(file)) return null
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null
    return `data:${MIME[path.extname(file).toLowerCase()]};base64,${fs.readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}
