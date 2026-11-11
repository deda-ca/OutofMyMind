// Timestamps between groups of messages in the conversation, as in a texting
// app: one before the first message, and another wherever the conversation
// picks up again after a pause. Today: just the time. Another day: the date
// and the time (and the year, if it's not this one).

/** A pause this long (or longer) starts a new group, with its own timestamp. */
export const GAP_MS = 15 * 60 * 1000

/** Whether a message at `at` starts a new group after one at `previous` (none: the first). */
export function startsGroup(previous: number | undefined, at: number): boolean {
  if (previous === undefined || !Number.isFinite(previous)) return true
  if (new Date(previous).toDateString() !== new Date(at).toDateString()) return true
  return at - previous >= GAP_MS
}

/** "2:34 PM" today; "Tue, Nov 10, 2:34 PM" another day; with the year if not this year. */
export function stampLabel(at: number, now: number = Date.now()): string {
  const d = new Date(at)
  const today = new Date(now)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return time
  const date = d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  })
  return `${date}, ${time}`
}

/**
 * The timestamp to show before each message (by key), given the messages in
 * the order shown. Messages without a usable time neither get one nor break a group.
 */
export function stampsFor(messages: { key: string | number; at: number | undefined }[], now: number = Date.now()): Map<string | number, string> {
  const stamps = new Map<string | number, string>()
  let previous: number | undefined
  for (const { key, at } of messages) {
    if (at === undefined || !Number.isFinite(at)) continue
    if (startsGroup(previous, at)) stamps.set(key, stampLabel(at, now))
    previous = at
  }
  return stamps
}
