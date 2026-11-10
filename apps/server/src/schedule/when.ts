// When schedules go off: the first time, how they repeat, the next time after
// a moment, and how to say it. Pure functions (the clock is passed in).
//
// Repeats are kept in local wall-clock time: "every weekday at 06:45" stays at
// 06:45 across daylight-saving changes. Minute and hour repeats are plain
// intervals from the first time.
//
// What the LLM gives (all optional, see parseWhen):
//   in: "10m" | "1h30m" | "90 seconds"         from now
//   time: "06:45" | "7am" | "6:30 pm"          a time of day
//   date: "2026-11-12" | "today" | "tomorrow" | "friday"
//   repeat: "daily" | "weekdays" | "weekends" | "weekly" | "monthly" | "yearly" | "hourly"
//   days: ["mon", "wed"]                        weekly, on these days
//   every: "2h" | "30m" | "3 days"              an interval

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
export const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export interface Repeat {
  every: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
  /** Every n units (default 1). */
  interval?: number
  /** For "day" and "week": only on these days. */
  days?: Weekday[]
  /** No occurrences after this (ISO). */
  until?: string
}

export class WhenError extends Error {}

const MINUTE = 60_000
const UNITS: [RegExp, number][] = [
  [/^(s|sec|secs|second|seconds)$/, 1000],
  [/^(m|min|mins|minute|minutes)$/, MINUTE],
  [/^(h|hr|hrs|hour|hours)$/, 60 * MINUTE],
  [/^(d|day|days)$/, 24 * 60 * MINUTE],
  [/^(w|wk|wks|week|weeks)$/, 7 * 24 * 60 * MINUTE],
]

/** "10m", "1h30m", "1 hour 30 minutes", "90 seconds", "1:30:00", "an hour", "half an hour" → ms. */
export function parseDuration(text: string): number {
  let t = text.trim().toLowerCase().replace(/^in\s+/, '').replace(/,|\band\b/g, ' ')
  t = t.replace(/\bhalf an? hour\b/, '30m').replace(/\ba quarter of an hour\b/, '15m').replace(/\ban?\s+(?=[a-z])/g, '1 ')
  t = t.replace(/(\d+(?:\.\d+)?)\s+and a half\s+(hours?|minutes?)/, (_, n: string, u: string) => `${Number(n) + 0.5} ${u}`)
  const clock = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(t)
  if (clock) {
    // "1:30" = 1 h 30 min; "1:30:00" with seconds.
    return clock[3] !== undefined ? (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * 1000 : (Number(clock[1]) * 60 + Number(clock[2])) * MINUTE
  }
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) * MINUTE // a bare number: minutes
  let total = 0
  let matched = ''
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
    const unit = UNITS.find(([re]) => re.test(m[2]!))
    if (!unit) throw new WhenError(`"${text}" isn't a duration I understand (e.g. "10m", "1h30m", "90 seconds").`)
    total += Number(m[1]) * unit[1]
    matched += m[0]
  }
  if (total <= 0 || matched.replace(/\s/g, '').length !== t.replace(/\s/g, '').length) throw new WhenError(`"${text}" isn't a duration I understand (e.g. "10m", "1h30m", "90 seconds").`)
  return Math.round(total)
}

/** "06:45", "6:45", "7am", "7 pm", "6:30 p.m.", "18h30", "noon", "midnight" → [hours, minutes]. */
export function parseTime(text: string): [number, number] {
  const t = text.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ')
  if (t === 'noon' || t === 'midday') return [12, 0]
  if (t === 'midnight') return [0, 0]
  const m = /^(\d{1,2})(?:[:h](\d{2}))?(?::\d{2})?\s*(am|pm)?$/.exec(t)
  if (!m) throw new WhenError(`"${text}" isn't a time I understand (e.g. "06:45" or "7pm").`)
  let h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  if (m[3]) {
    if (h < 1 || h > 12) throw new WhenError(`"${text}" isn't a valid time.`)
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0)
  }
  if (h > 23 || min > 59) throw new WhenError(`"${text}" isn't a valid time.`)
  return [h, min]
}

function weekdayOf(text: string): number {
  const t = text.trim().toLowerCase().replace(/^next\s+/, '')
  const i = WEEKDAYS.findIndex((d) => t.startsWith(d))
  return i
}

/** The day to start from: "2026-11-12", "today", "tomorrow", "friday" (the next one; today if it's today). Local midnight. */
export function parseDate(text: string, now: Date): Date {
  const t = text.trim().toLowerCase()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (t === 'today' || t === 'tonight') return today
  if (t === 'tomorrow') return addDays(today, 1)
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    if (d.getMonth() !== Number(iso[2]) - 1) throw new WhenError(`"${text}" isn't a valid date.`)
    return d
  }
  const wd = weekdayOf(t)
  if (wd >= 0) {
    const ahead = (wd - today.getDay() + 7) % 7 || (t.startsWith('next') ? 7 : 0)
    return addDays(today, ahead)
  }
  throw new WhenError(`"${text}" isn't a date I understand (use YYYY-MM-DD, "today", "tomorrow" or a weekday).`)
}

export interface WhenInput {
  in?: string
  time?: string
  date?: string
  repeat?: string
  days?: string[] | string
  every?: string
  until?: string
}

/** What the LLM said → the first time and the repeat. Throws WhenError with a message for the LLM. */
export function parseWhen(input: WhenInput, now = new Date()): { start: Date; repeat?: Repeat } {
  const days = normaliseDays(input.days)
  const repeatWord = input.repeat?.trim().toLowerCase().replace(/^every\s+/, '') || ''
  let repeat: Repeat | undefined
  if (input.every?.trim()) {
    const ms = parseDuration(input.every)
    if (ms < MINUTE) throw new WhenError('The shortest repeat is every minute.')
    repeat =
      ms % (24 * 60 * MINUTE) === 0 ? { every: 'day', interval: ms / (24 * 60 * MINUTE) }
      : ms % (60 * MINUTE) === 0 ? { every: 'hour', interval: ms / (60 * MINUTE) }
      : { every: 'minute', interval: Math.round(ms / MINUTE) }
    if (repeat.every === 'day' && repeat.interval! % 7 === 0) repeat = { every: 'week', interval: repeat.interval! / 7 }
  } else if (repeatWord && repeatWord !== 'none' && repeatWord !== 'once') {
    repeat = ({
      daily: { every: 'day' }, day: { every: 'day' }, 'every day': { every: 'day' },
      weekdays: { every: 'day', days: ['mon', 'tue', 'wed', 'thu', 'fri'] }, weekday: { every: 'day', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
      weekends: { every: 'day', days: ['sat', 'sun'] }, weekend: { every: 'day', days: ['sat', 'sun'] },
      weekly: { every: 'week' }, week: { every: 'week' },
      monthly: { every: 'month' }, month: { every: 'month' },
      yearly: { every: 'year' }, annually: { every: 'year' }, year: { every: 'year' },
      hourly: { every: 'hour' }, hour: { every: 'hour' },
    } as Record<string, Repeat>)[repeatWord]
    if (!repeat) {
      // "monday", "mon,wed": weekly on those days.
      const asDays = normaliseDays(repeatWord)
      if (!asDays.length) throw new WhenError(`"${input.repeat}" isn't a repeat I understand (daily, weekdays, weekends, weekly, monthly, yearly, hourly).`)
      repeat = { every: 'week', days: asDays }
    }
  }
  if (days.length) repeat = repeat && repeat.every !== 'week' && repeat.every !== 'day' ? repeat : { ...(repeat ?? { every: 'week' }), days }
  if (repeat && input.until?.trim()) repeat.until = parseDate(input.until, now).toISOString()

  let start: Date
  if (input.in?.trim()) {
    const ms = parseDuration(input.in)
    if (ms < 1000) throw new WhenError('That is too soon.')
    start = new Date(now.getTime() + ms)
  } else if (input.time?.trim()) {
    const [h, m] = parseTime(input.time)
    const day = input.date?.trim() ? parseDate(input.date, now) : new Date(now.getFullYear(), now.getMonth(), now.getDate())
    start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)
    if (start <= now) {
      if (input.date?.trim() && !/^(today|tonight)$/i.test(input.date.trim())) throw new WhenError(`${describeTime(start, now)} has already passed.`)
      if (!repeat) start = addDays(start, 1) // "at 7" said after 7: tomorrow
    }
  } else if (input.every?.trim() && repeat) {
    // "every 2 hours" with no start: the first one is one interval from now.
    start = new Date(now.getTime() + intervalMs(repeat))
  } else {
    throw new WhenError('Say when: "in" (e.g. "10m") or a "time" (e.g. "06:45"), optionally with a "date".')
  }
  if (repeat) {
    // The first real occurrence (e.g. "weekdays at 06:45" set on a Saturday: Monday).
    const first = nextAfter(start, repeat, new Date(start.getTime() - 1))
    if (!first || first <= now) {
      const later = nextAfter(start, repeat, now)
      if (!later) throw new WhenError('That repeat never goes off.')
      start = later
    } else start = first
  }
  return repeat ? { start, repeat } : { start }
}

function normaliseDays(value: string[] | string | undefined): Weekday[] {
  if (!value) return []
  const list = Array.isArray(value) ? value : value.split(/[\s,/&]+|\band\b/)
  const out = new Set<Weekday>()
  for (const raw of list) {
    const t = String(raw).trim().toLowerCase()
    if (!t) continue
    if (t === 'weekdays') ['mon', 'tue', 'wed', 'thu', 'fri'].forEach((d) => out.add(d as Weekday))
    else if (t === 'weekends') ['sat', 'sun'].forEach((d) => out.add(d as Weekday))
    else {
      const i = weekdayOf(t)
      if (i >= 0) out.add(WEEKDAYS[i]!)
    }
  }
  return WEEKDAYS.filter((d) => out.has(d))
}

function intervalMs(r: Repeat): number {
  const n = r.interval ?? 1
  return r.every === 'minute' ? n * MINUTE : r.every === 'hour' ? n * 60 * MINUTE : n * 24 * 60 * MINUTE
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds())
}

/** The first occurrence strictly after `after` (the start itself counts), or null if there's none. */
export function nextAfter(start: Date, repeat: Repeat | undefined, after: Date): Date | null {
  const until = repeat?.until ? new Date(repeat.until) : null
  const ok = (d: Date) => (until && d > until ? null : d)
  if (!repeat) return start > after ? start : null
  if (start > after && matchesDay(start, repeat)) return ok(start)
  const n = Math.max(1, Math.floor(repeat.interval ?? 1))
  if (repeat.every === 'minute' || repeat.every === 'hour') {
    const step = intervalMs({ ...repeat, interval: n })
    const k = Math.floor((after.getTime() - start.getTime()) / step) + 1
    return ok(new Date(start.getTime() + Math.max(1, k) * step))
  }
  if (repeat.every === 'day' || repeat.every === 'week') {
    const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    // Week numbers count from the Monday of the start's week.
    const startMonday = addDays(startDay, -((startDay.getDay() + 6) % 7))
    const from = after > start ? new Date(after.getFullYear(), after.getMonth(), after.getDate()) : startDay
    for (let i = 0; i < 366 * 8 * n; i++) {
      const day = addDays(from, i)
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), start.getHours(), start.getMinutes(), start.getSeconds())
      if (at <= after || at < start) continue
      const daysSince = Math.round((day.getTime() - startDay.getTime()) / 86_400_000)
      if (repeat.every === 'day') {
        if (repeat.days?.length ? !repeat.days.includes(WEEKDAYS[day.getDay()]!) : daysSince % n !== 0) continue
      } else {
        const weeks = Math.floor(Math.round((day.getTime() - startMonday.getTime()) / 86_400_000) / 7)
        const days = repeat.days?.length ? repeat.days : [WEEKDAYS[start.getDay()]!]
        if (weeks % n !== 0 || !days.includes(WEEKDAYS[day.getDay()]!)) continue
      }
      return ok(at)
    }
    return null
  }
  // month / year: the same day of the month (months without it are skipped).
  const months = repeat.every === 'year' ? 12 * n : n
  for (let k = 1; k < 12 * 200; k++) {
    const m = start.getMonth() + k * months
    const at = new Date(start.getFullYear(), m, start.getDate(), start.getHours(), start.getMinutes(), start.getSeconds())
    if (at.getDate() !== start.getDate()) continue
    if (at > after) return ok(at)
  }
  return null
}

function matchesDay(d: Date, r: Repeat): boolean {
  if ((r.every !== 'day' && r.every !== 'week') || !r.days?.length) return true
  return r.days.includes(WEEKDAYS[d.getDay()]!)
}

// ------------------------------------------------------------------ saying it

const two = (n: number) => String(n).padStart(2, '0')

/** "18:42" today, "tomorrow at 06:45", "Friday 13 November at 17:00", with the year if it isn't this one. */
export function describeTime(d: Date, now = new Date()): string {
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const diff = Math.round((day - today) / 86_400_000)
  if (diff === 0) return `today at ${time}`
  if (diff === 1) return `tomorrow at ${time}`
  const date = `${WEEKDAY_NAMES[d.getDay()]} ${d.getDate()} ${d.toLocaleString('en-GB', { month: 'long' })}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''}`
  return `${date} at ${time}`
}

/** "in 10 minutes", "in 2 hours 5 minutes", "in 3 days". */
export function describeIn(ms: number): string {
  if (ms < 60_000) return `in ${Math.max(1, Math.round(ms / 1000))} seconds`
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 48) return `in ${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minute${m === 1 ? '' : 's'}` : ''}`
  const d = Math.round(h / 24)
  return `in ${d} days`
}

/** "every weekday", "every 2 hours", "every Monday and Wednesday", "every month on the 3rd". */
export function describeRepeat(r: Repeat, start: Date): string {
  const n = r.interval ?? 1
  const plural = (unit: string) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`)
  const dayList = (days: Weekday[]) => {
    const key = days.join(',')
    if (key === 'mon,tue,wed,thu,fri') return 'weekday'
    if (key === 'sun,sat') return 'weekend day'
    const names = days.map((d) => WEEKDAY_NAMES[WEEKDAYS.indexOf(d)]!)
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]!
  }
  let text: string
  switch (r.every) {
    case 'minute':
      text = plural('minute')
      break
    case 'hour':
      text = plural('hour')
      break
    case 'day':
      text = r.days?.length ? `every ${dayList(r.days)}` : plural('day')
      break
    case 'week': {
      const days = r.days?.length ? r.days : [WEEKDAYS[start.getDay()]!]
      text = n === 1 ? `every ${dayList(days)}` : `every ${n} weeks on ${dayList(days)}`
      break
    }
    case 'month':
      text = `${plural('month')} on the ${ordinal(start.getDate())}`
      break
    case 'year':
      text = `every year on ${start.getDate()} ${start.toLocaleString('en-GB', { month: 'long' })}`
      break
  }
  if (r.every !== 'minute' && r.every !== 'hour') text += ` at ${two(start.getHours())}:${two(start.getMinutes())}`
  if (r.until) text += `, until ${new Date(r.until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
  return text
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${s}`
}
