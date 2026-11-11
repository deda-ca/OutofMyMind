// Times for the calendar plugin: reading what Jarvis or the owner gives,
// when to remind, and occurrence ids ("uid@2026-11-12T15:00:00.000Z").

import type { Occurrence } from './events.ts'

/** "2026-11-12T15:00" (local), "2026-11-12" (local midnight), or a full ISO time. */
export function parseWhen(s: string): Date {
  const t = s.trim()
  const dOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  const d = dOnly ? new Date(Number(dOnly[1]), Number(dOnly[2]) - 1, Number(dOnly[3])) : new Date(t)
  if (Number.isNaN(d.getTime())) throw new Error(`"${s}" isn't a date or time: use 2026-11-12T15:00 (local time) or 2026-11-12.`)
  return d
}

/** When to remind: the event's own alarm, else the default before it; all-day events at 8:00 that day. */
export function remindAt(o: Occurrence, defaultMinutes: number): Date {
  if (o.alarmBefore !== null) return new Date(o.start.getTime() - o.alarmBefore * 1000)
  if (o.allDay) return new Date(o.start.getFullYear(), o.start.getMonth(), o.start.getDate(), 8, 0)
  return new Date(o.start.getTime() - defaultMinutes * 60_000)
}

export function splitId(id: string): { uid: string; start: Date | null } {
  const i = id.lastIndexOf('@')
  const rest = i > 0 ? id.slice(i + 1) : ''
  return /^\d{4}-\d{2}-\d{2}T/.test(rest) && !Number.isNaN(new Date(rest).getTime()) ? { uid: id.slice(0, i), start: new Date(rest) } : { uid: id, start: null }
}
