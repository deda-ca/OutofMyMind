// Calendar events in iCalendar (RFC 5545), with ical.js: reading what the
// server has (repeating events expanded over a window, their reminders), and
// writing what Jarvis adds or changes. New times are written in UTC, so every
// client shows them right without a time zone definition.

import crypto from 'node:crypto'
import ICAL from 'ical.js'

export interface Occurrence {
  /** The event's UID; with the occurrence's start for repeating ones ("uid@2026-11-12T15:00:00.000Z"). */
  id: string
  uid: string
  summary: string
  location: string
  description: string
  start: Date
  end: Date
  allDay: boolean
  recurring: boolean
  /** Seconds before the start to remind (from the event's own alarm), or null: the default. */
  alarmBefore: number | null
  status: string
}

/** Every VTIMEZONE in the object, so times written with a TZID come out right. */
function registerZones(root: ICAL.Component): void {
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    const zone = new ICAL.Timezone(tz)
    if (zone.tzid && !ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone)
  }
}

function parse(ics: string): ICAL.Component {
  const root = new ICAL.Component(ICAL.parse(ics))
  registerZones(root)
  return root
}

/** The alarm, as seconds before the start (relative DISPLAY/AUDIO alarms only). */
function alarmOf(vevent: ICAL.Component): number | null {
  for (const alarm of vevent.getAllSubcomponents('valarm')) {
    const trigger = alarm.getFirstProperty('trigger')
    const value = trigger?.getFirstValue()
    if (value instanceof ICAL.Duration && trigger?.getParameter('related') !== 'END') return Math.max(0, -value.toSeconds())
  }
  return null
}

const text = (v: unknown) => (typeof v === 'string' ? v : v ? String(v) : '')

/** The occurrences of the events in `ics` that overlap [from, to). */
export function occurrences(ics: string, from: Date, to: Date, max = 500): Occurrence[] {
  const root = parse(ics)
  const out: Occurrence[] = []
  const vevents = root.getAllSubcomponents('vevent')
  // Changed single occurrences (RECURRENCE-ID) replace the master's for that date.
  const masters = vevents.filter((v) => !v.hasProperty('recurrence-id'))
  const exceptions = vevents.filter((v) => v.hasProperty('recurrence-id'))
  for (const master of masters) {
    const event = new ICAL.Event(master)
    for (const ex of exceptions) if (ex.getFirstPropertyValue('uid') === event.uid) event.relateException(ex)
    const base = {
      uid: event.uid,
      allDay: event.startDate?.isDate ?? false,
      recurring: event.isRecurring(),
    }
    const push = (start: ICAL.Time, end: ICAL.Time, item: ICAL.Event) => {
      const s = start.toJSDate()
      const e = end ? end.toJSDate() : new Date(s.getTime() + (base.allDay ? 86_400_000 : 3_600_000))
      if (e <= from || s >= to) return
      out.push({
        ...base,
        id: base.recurring ? `${event.uid}@${s.toISOString()}` : event.uid,
        summary: text(item.summary) || '(no title)',
        location: text(item.location),
        description: text(item.description),
        start: s,
        end: e,
        alarmBefore: alarmOf(item.component),
        status: text(item.component.getFirstPropertyValue('status')).toUpperCase(),
      })
    }
    if (!event.startDate) continue
    if (!event.isRecurring()) {
      push(event.startDate, event.endDate, event)
      continue
    }
    const it = event.iterator()
    for (let next = it.next(), n = 0; next && n < 5000 && out.length < max; next = it.next(), n++) {
      if (next.toJSDate() >= to) break
      const d = event.getOccurrenceDetails(next)
      push(d.startDate, d.endDate, d.item)
    }
  }
  return out.filter((o) => o.status !== 'CANCELLED').sort((a, b) => a.start.getTime() - b.start.getTime())
}

/** When the (master) event starts: for a series, its first occurrence. */
export function masterStart(ics: string): Date {
  const v = parse(ics).getAllSubcomponents('vevent').find((x) => !x.hasProperty('recurrence-id'))
  if (!v) throw new Error('No event in it.')
  return new ICAL.Event(v).startDate.toJSDate()
}

/** The UID of the (first) event in an object. */
export function uidOf(ics: string): string {
  return text(parse(ics).getFirstSubcomponent('vevent')?.getFirstPropertyValue('uid'))
}

export interface EventInput {
  summary: string
  start: Date
  end: Date
  allDay?: boolean
  location?: string
  description?: string
  /** Minutes before to remind (an alarm on the event, seen by every client). */
  reminderMinutes?: number
}

const utc = (d: Date) => ICAL.Time.fromJSDate(d, true)
function dateOnly(d: Date): ICAL.Time {
  return ICAL.Time.fromData({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), isDate: true })
}

function setTimes(v: ICAL.Component, input: Pick<EventInput, 'start' | 'end' | 'allDay'>): void {
  v.updatePropertyWithValue('dtstart', input.allDay ? dateOnly(input.start) : utc(input.start))
  v.updatePropertyWithValue('dtend', input.allDay ? dateOnly(new Date(Math.max(input.end.getTime(), input.start.getTime() + 86_400_000))) : utc(input.end))
}

function setAlarm(v: ICAL.Component, minutes: number | undefined): void {
  if (minutes === undefined) return
  for (const a of v.getAllSubcomponents('valarm')) v.removeSubcomponent(a)
  const alarm = new ICAL.Component('valarm')
  alarm.addPropertyWithValue('action', 'DISPLAY')
  alarm.addPropertyWithValue('description', 'Reminder')
  alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-Math.max(0, minutes) * 60))
  v.addSubcomponent(alarm)
}

/** A new event, as a whole iCalendar object. */
export function newEvent(input: EventInput): { uid: string; ics: string } {
  const uid = `${crypto.randomUUID()}@jarvis`
  const cal = new ICAL.Component(['vcalendar', [], []])
  cal.addPropertyWithValue('version', '2.0')
  cal.addPropertyWithValue('prodid', '-//Jarvis//calendar plugin//EN')
  const v = new ICAL.Component('vevent')
  v.addPropertyWithValue('uid', uid)
  v.addPropertyWithValue('dtstamp', utc(new Date()))
  v.addPropertyWithValue('summary', input.summary)
  setTimes(v, input)
  if (input.location) v.addPropertyWithValue('location', input.location)
  if (input.description) v.addPropertyWithValue('description', input.description)
  setAlarm(v, input.reminderMinutes)
  cal.addSubcomponent(v)
  return { uid, ics: cal.toString() }
}

/** The object with its (master) event changed: what's given replaces what's there. */
export function changeEvent(ics: string, change: Partial<EventInput>): string {
  const root = parse(ics)
  const v = root.getAllSubcomponents('vevent').find((x) => !x.hasProperty('recurrence-id'))
  if (!v) throw new Error('No event in it.')
  if (change.summary !== undefined) v.updatePropertyWithValue('summary', change.summary)
  if (change.location !== undefined) v.updatePropertyWithValue('location', change.location)
  if (change.description !== undefined) v.updatePropertyWithValue('description', change.description)
  if (change.start || change.end) {
    const event = new ICAL.Event(v)
    const start = change.start ?? event.startDate.toJSDate()
    const length = event.endDate ? event.endDate.toJSDate().getTime() - event.startDate.toJSDate().getTime() : 3_600_000
    setTimes(v, { start, end: change.end ?? new Date(start.getTime() + length), allDay: change.allDay ?? event.startDate.isDate })
  }
  setAlarm(v, change.reminderMinutes)
  v.updatePropertyWithValue('dtstamp', utc(new Date()))
  const seq = Number(v.getFirstPropertyValue('sequence') ?? 0)
  v.updatePropertyWithValue('sequence', seq + 1)
  return root.toString()
}

/** One occurrence of a repeating event left out (EXDATE): "cancel just this one". */
export function skipOccurrence(ics: string, start: Date): string {
  const root = parse(ics)
  const v = root.getAllSubcomponents('vevent').find((x) => !x.hasProperty('recurrence-id'))
  if (!v) throw new Error('No event in it.')
  const event = new ICAL.Event(v)
  const when = event.startDate.isDate ? dateOnly(start) : ICAL.Time.fromJSDate(start, true)
  const prop = new ICAL.Property('exdate')
  prop.setValue(when)
  v.addProperty(prop)
  // A changed copy of that occurrence, if there was one, goes too.
  for (const ex of root.getAllSubcomponents('vevent')) {
    const rid = ex.getFirstPropertyValue('recurrence-id')
    if (rid instanceof ICAL.Time && Math.abs(rid.toJSDate().getTime() - start.getTime()) < 1000) root.removeSubcomponent(ex)
  }
  return root.toString()
}
