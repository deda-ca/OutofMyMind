import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CalDav, CalDavError } from '../calendar/caldav.ts'
import { changeEvent, masterStart, newEvent, occurrences, skipOccurrence, uidOf } from '../calendar/events.ts'
import { parseWhen, remindAt, splitId } from '../calendar/when.ts'

const WEEKLY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:America/Toronto',
  'BEGIN:STANDARD',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:scouts@example.com',
  'DTSTART;TZID=America/Toronto:20261103T190000',
  'DTEND;TZID=America/Toronto:20261103T203000',
  'RRULE:FREQ=WEEKLY;COUNT=6',
  'EXDATE;TZID=America/Toronto:20261117T190000',
  'SUMMARY:Scouts meeting',
  'LOCATION:Church hall',
  'BEGIN:VALARM',
  'TRIGGER:-PT1H',
  'ACTION:DISPLAY',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:scouts@example.com',
  'RECURRENCE-ID;TZID=America/Toronto:20261124T190000',
  'DTSTART;TZID=America/Toronto:20261124T183000',
  'DTEND;TZID=America/Toronto:20261124T200000',
  'SUMMARY:Scouts meeting (early)',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

test('calendar: a repeating event in a time zone, one occurrence skipped and one moved, with its own alarm', () => {
  const list = occurrences(WEEKLY, new Date('2026-11-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'))
  // 6 weekly from Nov 3, minus Nov 17.
  assert.deepEqual(
    list.map((o) => [o.start.toISOString(), o.summary]),
    [
      ['2026-11-04T00:00:00.000Z', 'Scouts meeting'], // Nov 3, 19:00 EST (after the switch on Nov 1)
      ['2026-11-11T00:00:00.000Z', 'Scouts meeting'],
      ['2026-11-24T23:30:00.000Z', 'Scouts meeting (early)'],
      ['2026-12-02T00:00:00.000Z', 'Scouts meeting'],
      ['2026-12-09T00:00:00.000Z', 'Scouts meeting'],
    ],
  )
  assert.equal(list[0]!.recurring, true)
  assert.equal(list[0]!.alarmBefore, 3600)
  assert.equal(list[0]!.location, 'Church hall')
  assert.equal(list[0]!.id, 'scouts@example.com@2026-11-04T00:00:00.000Z')
  assert.deepEqual(splitId(list[0]!.id), { uid: 'scouts@example.com', start: new Date('2026-11-04T00:00:00.000Z') })
  assert.deepEqual(splitId('plain-uid'), { uid: 'plain-uid', start: null })
  assert.equal(masterStart(WEEKLY).toISOString(), '2026-11-04T00:00:00.000Z')
  // Only what overlaps the window.
  assert.equal(occurrences(WEEKLY, new Date('2026-11-10T00:00:00Z'), new Date('2026-11-12T00:00:00Z')).length, 1)
})

test('calendar: events Jarvis writes read back the same; changes and skipping one occurrence', () => {
  const start = new Date('2026-11-12T20:00:00Z')
  const made = newEvent({ summary: 'Dentist', start, end: new Date('2026-11-12T21:00:00Z'), location: 'Smile Dental', reminderMinutes: 30 })
  assert.equal(uidOf(made.ics), made.uid)
  const [o] = occurrences(made.ics, new Date('2026-11-12T00:00:00Z'), new Date('2026-11-13T00:00:00Z'))
  assert.deepEqual([o!.summary, o!.location, o!.start.toISOString(), o!.end.toISOString(), o!.alarmBefore, o!.recurring], ['Dentist', 'Smile Dental', '2026-11-12T20:00:00.000Z', '2026-11-12T21:00:00.000Z', 1800, false])
  assert.match(made.ics, /DTSTART:20261112T200000Z/)
  assert.doesNotMatch(made.ics, /ATTENDEE|ORGANIZER/)
  // Moved an hour later, retitled; the length stays.
  const changed = changeEvent(made.ics, { summary: 'Dentist (cleaning)', start: new Date('2026-11-12T21:00:00Z') })
  const [c] = occurrences(changed, new Date('2026-11-12T00:00:00Z'), new Date('2026-11-13T00:00:00Z'))
  assert.deepEqual([c!.summary, c!.start.toISOString(), c!.end.toISOString(), c!.alarmBefore], ['Dentist (cleaning)', '2026-11-12T21:00:00.000Z', '2026-11-12T22:00:00.000Z', 1800])
  assert.match(changed, /SEQUENCE:1/)
  // All day.
  const day = newEvent({ summary: 'Holiday', start: new Date(2026, 11, 25), end: new Date(2026, 11, 26), allDay: true })
  const [h] = occurrences(day.ics, new Date(2026, 11, 24), new Date(2026, 11, 27))
  assert.equal(h!.allDay, true)
  // Skipping the moved occurrence of the weekly one removes it and its change.
  const skipped = skipOccurrence(WEEKLY, new Date('2026-11-24T23:30:00Z'))
  assert.equal(occurrences(skipped, new Date('2026-11-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z')).length, 5)
  const skip2 = skipOccurrence(WEEKLY, new Date('2026-12-02T00:00:00Z'))
  assert.deepEqual(
    occurrences(skip2, new Date('2026-11-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z')).map((x) => x.start.toISOString().slice(0, 10)),
    ['2026-11-04', '2026-11-11', '2026-11-24', '2026-12-09'],
  )
})

test('calendar: local times read as local, and when reminders fall', () => {
  assert.equal(parseWhen('2026-11-12').getHours(), 0)
  assert.equal(parseWhen('2026-11-12T15:00').getHours(), 15)
  assert.throws(() => parseWhen('next tuesday'), /isn't a date/)
  const base = { id: 'x', uid: 'x', summary: 'x', location: '', description: '', recurring: false, status: '' }
  const at3 = new Date(2026, 10, 12, 15, 0)
  assert.equal(remindAt({ ...base, start: at3, end: at3, allDay: false, alarmBefore: null }, 15).getMinutes(), 45)
  assert.equal(remindAt({ ...base, start: at3, end: at3, allDay: false, alarmBefore: 3600 }, 15).getHours(), 14)
  const day = new Date(2026, 10, 12)
  assert.equal(remindAt({ ...base, start: day, end: day, allDay: true, alarmBefore: null }, 15).getHours(), 8)
})

/** A tiny CalDAV server in memory: one calendar, ETags, If-Match. */
function fakeServer() {
  const objects = new Map<string, { etag: string; ics: string }>()
  let n = 0
  const xml = (s: string) => new Response(s, { status: 207, headers: { 'Content-Type': 'application/xml' } })
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    const url = new URL(input)
    const body = String(init.body ?? '')
    const headers = init.headers as Record<string, string>
    assert.match(headers.Authorization!, /^Basic /)
    if (init.method === 'PROPFIND' && body.includes('current-user-principal')) return xml('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>')
    if (init.method === 'PROPFIND' && body.includes('calendar-home-set')) return xml('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/me/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/calendars/me/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>')
    if (init.method === 'PROPFIND' && headers.Depth === '1')
      return xml(
        '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/me/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>' +
          '<d:response><d:href>/calendars/me/tasks/</d:href><d:propstat><d:prop><d:displayname>Tasks</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>' +
          '<d:response><d:href>/calendars/me/calendar/</d:href><d:propstat><d:prop><d:displayname>Home</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response></d:multistatus>',
      )
    if (init.method === 'PROPFIND') return xml(`<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:response><d:href>/calendars/me/calendar/</d:href><d:propstat><d:prop><cs:getctag>ctag-${n}</cs:getctag></d:prop></d:propstat></d:response></d:multistatus>`)
    if (init.method === 'REPORT' && body.includes('calendar-query'))
      return xml(`<d:multistatus xmlns:d="DAV:">${[...objects].map(([h, o]) => `<d:response><d:href>${h}</d:href><d:propstat><d:prop><d:getetag>${o.etag}</d:getetag></d:prop></d:propstat></d:response>`).join('')}</d:multistatus>`)
    if (init.method === 'REPORT')
      return xml(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${[...objects].filter(([h]) => body.includes(h)).map(([h, o]) => `<d:response><d:href>${h}</d:href><d:propstat><d:prop><d:getetag>${o.etag}</d:getetag><c:calendar-data>${o.ics.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</c:calendar-data></d:prop></d:propstat></d:response>`).join('')}</d:multistatus>`)
    if (init.method === 'PUT') {
      const existing = objects.get(url.pathname)
      if (headers['If-None-Match'] === '*' && existing) return new Response('', { status: 412 })
      if (headers['If-Match'] && existing?.etag !== headers['If-Match']) return new Response('', { status: 412 })
      const etag = `"e${++n}"`
      objects.set(url.pathname, { etag, ics: body })
      return new Response(existing ? null : '', { status: existing ? 204 : 201, headers: { ETag: etag } })
    }
    if (init.method === 'DELETE') {
      objects.delete(url.pathname)
      return new Response(null, { status: 204 })
    }
    return new Response('', { status: 405 })
  }) as unknown as typeof fetch
  return { objects, fetchImpl }
}

test('caldav: finds the calendar that holds events, writes without overwriting edits made elsewhere, reads back', async () => {
  const { objects, fetchImpl } = fakeServer()
  const dav = new CalDav({ url: 'https://dav.example.com/', user: 'me', password: 'pw' }, fetchImpl)
  const found = await dav.discover()
  assert.deepEqual([found.path, found.name, found.all.length], ['/calendars/me/calendar/', 'Home', 1])
  const ev = newEvent({ summary: 'Dentist', start: new Date('2026-11-12T20:00:00Z'), end: new Date('2026-11-12T21:00:00Z') })
  const href = `${dav.calendarPath}${encodeURIComponent(ev.uid)}.ics`
  const etag = await dav.put(href, ev.ics)
  await assert.rejects(dav.put(href, ev.ics), CalDavError) // already there: no silent overwrite
  await assert.rejects(dav.put(href, ev.ics, '"stale"'), /edited elsewhere/)
  await dav.put(href, changeEvent(ev.ics, { summary: 'Dentist (moved)' }), etag)
  const listed = await dav.list()
  assert.equal(listed.length, 1)
  const [got] = await dav.get(listed.map((o) => o.href))
  assert.match(got!.ics!, /SUMMARY:Dentist \(moved\)/)
  assert.ok(await dav.ctag())
  await dav.remove(href, got!.etag)
  assert.equal(objects.size, 0)
})
