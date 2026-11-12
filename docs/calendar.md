# Calendar: the owner's CalDAV calendar, as a plugin

Status: built 2026-11-11, a self-contained plugin on the plugin platform ([plugins.md](plugins.md)), on the CalDAV calendar of the account the email plugin watches (cPanel, port 2080). Tested for real: a test event added 16 minutes ahead got its reminder 56 s later ("… at 6:15 p.m. (in 15 min), Nowhere."), showed in the agenda and search, was moved an hour and deleted; the Calendar tab added and deleted an event in Chrome under its CSP.

## What it does

- **Kept in step with the server** (the server is the truth): every 2 minutes it asks whether anything changed (the calendar's change tag) and, if so, fetches only the events whose ETag changed. The local copy (`DATA_DIR/plugins/calendar/calendar.db`) is for speed; edits go to the server first, with `If-Match` / `If-None-Match`, so an event edited elsewhere meanwhile is never overwritten (Jarvis is told to look again).
- **Repeating events** are expanded with [ical.js](https://github.com/kewisch/ical.js) (rules, skipped dates, changed occurrences, time zones from the calendar's own definitions).
- **Reminders**, straight to the owner's screens (a notification that stays until seen, no LLM turn): the event's own alarm if it has one, otherwise `CALENDAR_REMINDER_MINUTES` (15) before; all-day events at 8:00 that day. Given once; ones missed while Jarvis was off aren't given late. Also sent as `calendar.reminder` events.
- **What Jarvis may do**: see, find and add or move events without asking (the owner's choice; the Tools tab's switches still apply); **deleting needs the owner's yes** (the server's confirmation gate). **Nobody is invited or emailed**: no attendees are ever written.
- **New times are written in UTC**, so every client shows them right; they're read and given in the owner's local time.

## Tools for Jarvis

| Tool | CRUD | |
| --- | --- | --- |
| `calendar__agenda` | read | What's on: today, or from a date for some days. |
| `calendar__find_events` | read | By words in the title, place or notes, a month back to a year ahead. |
| `calendar__free_time` | read | Free stretches on a day between two times. |
| `calendar__busy_between` | read | What's booked between two times, as JSON: for checking a time exactly (Marvin's bookings check every time with it). |
| `calendar__add_event` | create | Title, start (local), end or length, place, notes, reminder, all day. |
| `calendar__update_event` | update | For a repeating event, moving changes just that occurrence (it leaves the series and becomes a one-off) unless `series`; a series moves by as much as the occurrence did. |
| `calendar__delete_event` | delete, confirm | Just that occurrence of a repeating event (a skipped date) unless `series`. |

## The Calendar tab

A week at a time (Monday to Sunday), previous / today / next, refresh; an event opens in the editor (title, date, all day, times, place, notes, reminder; for a repeating event, "every time it repeats" or just this one); New event; Delete (pressing it is the owner's yes).

## Settings

```jsonc
"calendar": {
  "url": "https://mail.example.com:2080/",   // the CalDAV server (the calendar is found from there)
  "user": "me@example.com",
  "password": "…",
  "name": "",                                // which calendar, if the account has several (default: the first that holds events)
  "reminderMinutes": 15,
  "pollSeconds": 120
}
```

## Not yet

- Invitations: meeting invites arriving by email (`text/calendar` attachments) added after the owner's yes; inviting people (needs the gate, and the server's scheduling).
- Reminders by Telegram when the owner is away (needs the platform's presence events to plugins).
- Several calendars at once (one today, `CALENDAR_NAME`); tasks (VTODO).
- A morning briefing (the agenda with email and weather), and the phone and contacts tying in (who an event is with).
- Google Calendar (OAuth), later, with Gmail.
