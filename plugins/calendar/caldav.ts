// A small CalDAV client (RFC 4791): finds the calendar, lists its events'
// ETags, fetches the ones that changed, and writes with If-Match / If-None-Match
// so an edit made elsewhere is never overwritten. Basic authentication in a
// header: never in a URL, and no URL the server sends back is logged (one
// server puts the credentials in its redirects).

export class CalDavError extends Error {}

type Fetch = typeof fetch

export interface CalDavSettings {
  url: string
  user: string
  password: string
  /** Which calendar (its display name or path); default: the first that holds events. */
  calendar?: string
}

export interface RemoteObject {
  href: string
  etag: string
  ics?: string
}

const DAV = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"'

/** <prefix:name>value</prefix:name> → value, whatever the prefix (servers differ). */
function tag(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`, 'g')
  return [...xml.matchAll(re)].map((m) => m[1]!)
}

function unxml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#13;/g, '\r')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

export class CalDav {
  private readonly s: CalDavSettings
  private readonly fetch: Fetch
  private readonly auth: string
  /** The calendar collection's path, once found. */
  calendarPath = ''
  calendarName = ''

  constructor(settings: CalDavSettings, fetchImpl: Fetch = fetch) {
    this.s = settings
    this.fetch = fetchImpl
    this.auth = `Basic ${Buffer.from(`${settings.user}:${settings.password}`).toString('base64')}`
  }

  private async request(method: string, path: string, opts: { body?: string; depth?: string; headers?: Record<string, string>; ok?: number[] } = {}): Promise<Response> {
    const url = new URL(path, this.s.url)
    let response: Response
    try {
      response = await this.fetch(url, {
        method,
        headers: { Authorization: this.auth, ...(opts.body ? { 'Content-Type': method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' } : {}), ...(opts.depth ? { Depth: opts.depth } : {}), ...opts.headers },
        body: opts.body,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      throw new CalDavError(`Couldn't reach the calendar server: ${(err as Error).message}`)
    }
    if (opts.ok && !opts.ok.includes(response.status)) {
      if (response.status === 401) throw new CalDavError('The calendar server refused the user name or password.')
      if (response.status === 412) throw new CalDavError('The event changed on the server meanwhile (edited elsewhere): look again and retry.')
      throw new CalDavError(`The calendar server answered ${method} with HTTP ${response.status}.`)
    }
    return response
  }

  /** Finds the calendar: principal → calendar home → its calendars. */
  async discover(): Promise<{ path: string; name: string; all: { path: string; name: string }[] }> {
    const propfind = (body: string) => `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV}><d:prop>${body}</d:prop></d:propfind>`
    const root = new URL(this.s.url).pathname || '/'
    let xml = await (await this.request('PROPFIND', root, { depth: '0', body: propfind('<d:current-user-principal/>'), ok: [207] })).text()
    const principal = unxml(tag(tag(xml, 'current-user-principal')[0] ?? '', 'href')[0] ?? '').trim() || root
    xml = await (await this.request('PROPFIND', principal, { depth: '0', body: propfind('<c:calendar-home-set/>'), ok: [207] })).text()
    const home = unxml(tag(tag(xml, 'calendar-home-set')[0] ?? '', 'href')[0] ?? '').trim() || principal
    xml = await (await this.request('PROPFIND', home, { depth: '1', body: propfind('<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/>'), ok: [207] })).text()
    const all = tag(xml, 'response')
      .filter((r) => /<(?:[A-Za-z0-9]+:)?calendar\s*\/>/.test(tag(r, 'resourcetype')[0] ?? '') && (!/comp name=/.test(r) || /comp name="VEVENT"/.test(r)))
      .map((r) => ({ path: unxml(tag(r, 'href')[0] ?? '').trim(), name: unxml(tag(r, 'displayname')[0] ?? '').trim() }))
    if (!all.length) throw new CalDavError('No calendar with events was found for this account.')
    const want = this.s.calendar?.trim().toLowerCase()
    const pick = (want && all.find((c) => c.name.toLowerCase() === want || c.path.replace(/\/$/, '').toLowerCase().endsWith(`/${want}`))) || all[0]!
    this.calendarPath = pick.path.endsWith('/') ? pick.path : `${pick.path}/`
    this.calendarName = pick.name || pick.path
    return { path: this.calendarPath, name: this.calendarName, all }
  }

  /** The calendar's change tag (if the server has one): unchanged means nothing to fetch. */
  async ctag(): Promise<string> {
    const xml = await (await this.request('PROPFIND', this.calendarPath, { depth: '0', body: `<?xml version="1.0"?><d:propfind ${DAV}><d:prop><cs:getctag/><d:sync-token/></d:prop></d:propfind>`, ok: [207] })).text()
    return unxml(tag(xml, 'getctag')[0] ?? tag(xml, 'sync-token')[0] ?? '').trim()
  }

  /** Every event object's href and ETag. */
  async list(): Promise<RemoteObject[]> {
    const body = `<?xml version="1.0"?><c:calendar-query ${DAV}><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>`
    const xml = await (await this.request('REPORT', this.calendarPath, { depth: '1', body, ok: [207] })).text()
    return tag(xml, 'response')
      .map((r) => ({ href: unxml(tag(r, 'href')[0] ?? '').trim(), etag: unxml(tag(r, 'getetag')[0] ?? '').trim() }))
      .filter((o) => o.href && o.href !== this.calendarPath)
  }

  /** The objects themselves (calendar-multiget). */
  async get(hrefs: string[]): Promise<RemoteObject[]> {
    if (!hrefs.length) return []
    const body = `<?xml version="1.0"?><c:calendar-multiget ${DAV}><d:prop><d:getetag/><c:calendar-data/></d:prop>${hrefs.map((h) => `<d:href>${h.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</d:href>`).join('')}</c:calendar-multiget>`
    const xml = await (await this.request('REPORT', this.calendarPath, { depth: '1', body, ok: [207] })).text()
    return tag(xml, 'response').flatMap((r) => {
      const ics = unxml(tag(r, 'calendar-data')[0] ?? '')
      return ics.includes('BEGIN:VCALENDAR') ? [{ href: unxml(tag(r, 'href')[0] ?? '').trim(), etag: unxml(tag(r, 'getetag')[0] ?? '').trim(), ics }] : []
    })
  }

  /** Creates (no etag) or replaces (with the etag it had) an object; returns its new ETag if the server says. */
  async put(href: string, ics: string, etag?: string): Promise<string> {
    const r = await this.request('PUT', href, { body: ics, headers: etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }, ok: [200, 201, 204] })
    return r.headers.get('etag') ?? ''
  }

  async remove(href: string, etag: string): Promise<void> {
    await this.request('DELETE', href, { headers: etag ? { 'If-Match': etag } : {}, ok: [200, 204, 404] })
  }
}
