// Searching in Jarvis's Chrome (see ../browser/chrome.ts): a background tab
// opens the engine's results page (DuckDuckGo or Google), the results are read
// off the page, and the tab closes. No API key; it's the owner's own browser,
// a search at a time, as a person would.
//
// If the engine asks to prove you're human (a CAPTCHA, "unusual traffic"), the
// tab is left open and brought to the front for the owner to answer: nothing
// here tries to get past it. Jarvis can search again after.

import { chromium, type Browser, type Page } from 'playwright-core'
import { endpoint, ensureChrome } from '../browser/chrome.ts'
import { SearchError, type Recency, type SearchProvider, type SearchResult } from './search.ts'

export type Engine = 'duckduckgo' | 'google'

const ENGINES: Record<Engine, { name: string; url: (q: string, recency?: Recency) => string }> = {
  duckduckgo: {
    name: 'DuckDuckGo (in your browser)',
    url: (q, recency) => `https://duckduckgo.com/?${new URLSearchParams({ q, ...(recency ? { df: recency[0] } : {}) })}`,
  },
  google: {
    name: 'Google (in your browser)',
    url: (q, recency) => `https://www.google.com/search?${new URLSearchParams({ q, hl: 'en', ...(recency ? { tbs: `qdr:${recency[0]}` } : {}) })}`,
  },
}

const RESULTS_WAIT_MS = 10_000

export class BrowserSearch implements SearchProvider {
  readonly name: string
  private readonly engine: Engine
  private static browser?: Promise<Browser>

  constructor(engine: Engine) {
    this.engine = engine
    this.name = ENGINES[engine].name
  }

  async search(query: string, count: number, recency?: Recency): Promise<SearchResult[]> {
    let page: Page
    try {
      page = await openBackgroundTab(ENGINES[this.engine].url(query, recency))
    } catch (err) {
      throw new SearchError(`Searching in the browser didn't work: ${(err as Error).message}`)
    }
    let keepOpen = false
    try {
      await page.waitForLoadState('domcontentloaded')
      // Results are drawn by the page's scripts: wait for the first, or a challenge.
      await page
        .waitForFunction(`(${pageState.toString()})(document, location) !== 'loading'`, undefined, { timeout: RESULTS_WAIT_MS })
        .catch(() => {})
      const state = await page.evaluate(`(${pageState.toString()})(document, location)`)
      if (state === 'challenge') {
        keepOpen = true
        await page.bringToFront().catch(() => {})
        throw new SearchError(
          `${this.engine === 'google' ? 'Google' : 'DuckDuckGo'} wants to check this is a person (a CAPTCHA). The search is open in a tab in the owner's browser: ask the owner to answer it there, then search again. Don't try to get past it yourself.`,
        )
      }
      const results = (await page.evaluate(`(${extractResults.toString()})(document)`)) as SearchResult[]
      return varied(results, count)
    } finally {
      if (!keepOpen) await page.close().catch(() => {})
    }
  }

  /** One connection to Jarvis's Chrome, kept; made again if Chrome was closed. */
  static async connect(): Promise<Browser> {
    const existing = await BrowserSearch.browser?.catch(() => undefined)
    if (existing?.isConnected()) return existing
    BrowserSearch.browser = (async () => {
      await ensureChrome()
      return chromium.connectOverCDP(endpoint)
    })()
    return BrowserSearch.browser
  }
}

/**
 * The first `count` results, at most two per site while others are left: a
 * top result's sitelinks ("Roster", "Tickets") read as results of their own.
 */
export function varied<T extends { url: string }>(results: T[], count: number, perSite = 2): T[] {
  const site = (url: string) => new URL(url).hostname.replace(/^www\./, '')
  const seen = new Map<string, number>()
  const first: T[] = []
  const later: T[] = []
  for (const r of results) {
    const n = seen.get(site(r.url)) ?? 0
    seen.set(site(r.url), n + 1)
    ;(n < perSite ? first : later).push(r)
  }
  // Keep the page's order among those picked.
  const picked = new Set([...first, ...later].slice(0, count))
  return results.filter((r) => picked.has(r))
}

/** A new tab that doesn't take focus from the one the owner is on. */
async function openBackgroundTab(url: string): Promise<Page> {
  const browser = await BrowserSearch.connect()
  const context = browser.contexts()[0]
  if (!context) throw new Error('the browser has no window open')
  const cdp = await browser.newBrowserCDPSession()
  try {
    const opened = context.waitForEvent('page', { timeout: 10_000 })
    const { targetId } = (await cdp.send('Target.createTarget', { url, background: true })) as { targetId: string }
    let page = await opened
    // Another tab may have opened at the same moment: make sure it's ours.
    for (let i = 0; i < 5; i++) {
      const session = await context.newCDPSession(page)
      const { targetInfo } = (await session.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } }
      await session.detach().catch(() => {})
      if (targetInfo.targetId === targetId) return page
      page = await context.waitForEvent('page', { timeout: 10_000 })
    }
    return page
  } finally {
    await cdp.detach().catch(() => {})
  }
}

// ── Run inside the results page (passed as source: no imports, no outer names) ──

/** The bits of the DOM used below (the plugins aren't typed against the browser's DOM). */
interface DomElement {
  parentElement: DomElement | null
  textContent: string | null
  innerText?: string
  closest(selector: string): DomElement | null
  querySelector(selector: string): DomElement | null
  querySelectorAll(selector: string): ArrayLike<DomElement>
  getAttribute(name: string): string | null
}
interface DomDocument {
  body: DomElement | null
  location?: { href: string }
  querySelector(selector: string): DomElement | null
  querySelectorAll(selector: string): ArrayLike<DomElement>
}

/** 'challenge' (a CAPTCHA or bot check), 'ready' (results, or a page that has none), or 'loading'. */
export function pageState(doc: DomDocument, loc: { hostname: string; pathname: string }): 'challenge' | 'ready' | 'loading' {
  const text = (doc.body?.textContent ?? '').slice(0, 5000)
  if (loc.pathname.startsWith('/sorry') || doc.querySelector('#challenge-form, form[action*="anomaly"], iframe[src*="recaptcha"], #captcha-form')) return 'challenge'
  if (/unusual traffic from your computer|not a robot|bots use DuckDuckGo too|confirm this search was made by a human/i.test(text)) return 'challenge'
  if (doc.querySelector('h2 a[href], h3 a[href], a[href] h2, a[href] h3')) return 'ready'
  if (/no results found|did not match any documents|no more results/i.test(text)) return 'ready'
  return 'loading'
}

/** Organic results: a link with a heading (h2/h3) to another site, and the text around it. */
export function extractResults(doc: DomDocument): { title: string; url: string; snippet: string }[] {
  const engine = /(^|\.)(google\.[a-z.]+|duckduckgo\.com)$/
  const target = (a: DomElement): string | null => {
    let url: URL
    try {
      url = new URL(a.getAttribute('href') ?? '', doc.location?.href ?? 'https://www.google.com/')
    } catch {
      return null
    }
    // Google's redirect links: /url?q=<the result>
    if (engine.test(url.hostname) && url.pathname === '/url') {
      const q = url.searchParams.get('q') ?? url.searchParams.get('url')
      if (!q) return null
      try {
        url = new URL(q)
      } catch {
        return null
      }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (engine.test(url.hostname)) return null
    return url.href
  }
  const text = (el: DomElement): string => (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const headingLinks = (el: DomElement): number => el.querySelectorAll('h2 a[href], h3 a[href], a[href] h2, a[href] h3').length

  const out: { title: string; url: string; snippet: string }[] = []
  const seen = new Set<string>()
  for (const heading of Array.from(doc.querySelectorAll('h2, h3'))) {
    const a = heading.closest('a[href]') ?? heading.querySelector('a[href]')
    if (!a) continue
    const url = target(a)
    const title = text(heading)
    if (!url || !title || seen.has(url)) continue
    seen.add(url)
    // The result's box: grow from the link while the box holds no other result.
    let box: DomElement = a
    while (box.parentElement && box.parentElement !== doc.body && headingLinks(box.parentElement) <= 1) box = box.parentElement
    let snippet = text(box).replace(title, ' ')
    // Drop the displayed address ("example.com › page") and leftovers.
    snippet = snippet
      .replace(/[^\s›]+(\s*›\s*[^\s›]+)+/g, ' ')
      .replace(/\S*(https?:\/\/|www\.)\S*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^Web results\s*/i, '')
      .replace(/\s*Read more$/i, '')
      // A date or "Today" run into the text: "May 6, 2025Discover…" → "May 6, 2025 — Discover…"
      .replace(/^((?:\w{3,9} \d{1,2}, \d{4})|\d{1,2} \w{3,9} \d{4}|Today|Yesterday|\d+ (?:minutes?|hours?|days?|weeks?) ago)\s*(?:—\s*)?(?=\S)/, '$1 — ')
    out.push({ title, url, snippet: snippet.length > 300 ? `${snippet.slice(0, 297)}…` : snippet })
  }
  return out
}
