// Jarvis's replies as formatted text: Markdown (GitHub style, single line breaks
// kept) turned into HTML and sanitized with DOMPurify, since a reply can quote
// anything it read (a web page, a file). Links open in a new tab.
//
// A streaming reply is rendered again on every piece that arrives, and the
// transcript re-renders often, so results are cached.

import DOMPurify from 'dompurify'
import { marked } from 'marked'

const CACHE_SIZE = 300
const cache = new Map<string, string>()

/** Its own instance, so the link hook doesn't change the document viewer's links. */
const purify = DOMPurify(window)
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

export function renderMarkdown(text: string): string {
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  const html = purify.sanitize(marked.parse(text, { gfm: true, breaks: true, async: false }) as string, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
  })
  cache.set(text, html)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return html
}
