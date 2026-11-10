// Jarvis's own tools for schedules and the screen: set, list and cancel
// timers/alarms/reminders, stop or snooze what's ringing, put a notification
// on screen, and see whether anyone is at a screen. The LLM never works out a
// date itself: it passes what the owner said, and the tool answers with the
// actual time, which it then confirms.

import type { BuiltinTool } from '../harness/index.ts'
import type { Notifier } from './notifier.ts'
import { KINDS, ScheduleError, type Schedule, type ScheduleKind, type Scheduler } from './scheduler.ts'
import { describeIn, describeRepeat, describeTime } from './when.ts'
import { dueOf } from './scheduler.ts'

export interface ScheduleToolContext {
  scheduler: Scheduler
  notifier: Notifier
  /** Whether a kind of change is switched on (the Tools tab). */
  kindOn: (kind: 'create' | 'delete') => boolean
  /** A scheduled run (unattended): only the screen, presence and the list. A follow-up (an alarm nobody stopped) doesn't get the screen: it's ringing there already. */
  unattended?: { scheduleId: string; followUp?: boolean }
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

function confirmation(s: Schedule, now = new Date()): string {
  const due = dueOf(s)!
  const repeat = s.repeat ? `, then ${describeRepeat(s.repeat, new Date(s.start))}` : ''
  const what = s.prompt ? ` When it goes off you'll be told: "${s.prompt}"` : ''
  return `Set: ${s.kind} "${s.title}" for ${describeTime(due, now)} (${describeIn(due.getTime() - now.getTime())})${repeat}. id: ${s.id}.${what} Confirm it to the owner with that time, briefly.`
}

export function scheduleTools(ctx: ScheduleToolContext): BuiltinTool[] {
  const { scheduler, notifier } = ctx
  const tool = (name: string, label: string, crud: string[], description: string, properties: Record<string, unknown>, required: string[], run: BuiltinTool['run']): BuiltinTool => ({
    label,
    crud,
    tool: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } },
    run,
  })

  const notify = tool(
    'jarvis__notify',
    'Jarvis: notify',
    ['read'],
    "Put a notification on the owner's Jarvis screen: it's shown and spoken there. ring: true makes it ring like an alarm until they stop it. If no screen is open it's kept and shown when one opens (jarvis__presence says).",
    {
      text: { type: 'string', description: 'What to tell the owner, as you would say it.' },
      title: { type: 'string', description: 'A short title, e.g. "Bins".' },
      ring: { type: 'boolean', description: 'Ring until acknowledged (for alarms). Default false.' },
    },
    ['text'],
    async (args) => {
      const text = str(args.text)
      if (!text) return { text: 'Give the text to show.', isError: true }
      const { screens } = notifier.notify({ title: str(args.title) || 'Jarvis', text, urgency: args.ring === true ? 'alarm' : 'reminder', ring: args.ring === true, ...(ctx.unattended ? { scheduleId: ctx.unattended.scheduleId } : {}) })
      return { text: screens ? `Shown and spoken on ${screens} screen${screens === 1 ? '' : 's'}.` : 'No Jarvis screen is open: it will be shown when one opens.', isError: false }
    },
  )

  const presence = tool('jarvis__presence', 'Jarvis: presence', ['read'], 'Whether the owner is at a Jarvis screen: screens open, microphones listening, and when they last spoke to you.', {}, [], async () => ({ text: notifier.describePresence(), isError: false }))

  const list = tool(
    'jarvis__list_schedules',
    'Jarvis: list schedules',
    ['read'],
    'List the timers, alarms, reminders and scheduled tasks, soonest first, with when each goes off next.',
    {},
    [],
    async () => {
      const all = scheduler.list().filter((s) => s.enabled && dueOf(s))
      const paused = scheduler.list().filter((s) => !s.enabled)
      if (!all.length && !paused.length) return { text: 'Nothing is scheduled.', isError: false }
      return { text: [...all, ...paused].map((s) => scheduler.describe(s)).join('\n'), isError: false }
    },
  )

  if (ctx.unattended) return ctx.unattended.followUp ? [presence, list] : [notify, presence, list]

  const set = tool(
    'jarvis__set_schedule',
    'Jarvis: set schedule',
    ['create'],
    'Set a timer, alarm, reminder or a task for later. Give "in" (a duration: "10m", "1h30m") OR "time" ("06:45", "7pm") with an optional "date" ("tomorrow", "friday", "2026-12-24"); for repeats, "repeat" or "days" or "every". ' +
      'The tool works out the time and says it back: confirm it to the owner. Timers and alarms ring on screen; "prompt" is what you will be told to do when it goes off (leave it out to just ring/say the message).',
    {
      title: { type: 'string', description: 'Short name: "Pasta", "Wake-up", "Bins".' },
      kind: { type: 'string', enum: KINDS, description: 'timer (a countdown), alarm (rings at a time), reminder (said once), task (something for you to do then).' },
      in: { type: 'string', description: 'From now: "10m", "90 seconds", "2 hours".' },
      time: { type: 'string', description: 'A time of day: "06:45", "7pm".' },
      date: { type: 'string', description: '"today", "tomorrow", a weekday ("friday"), or "YYYY-MM-DD". Default: the next time it comes round.' },
      repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekends', 'weekly', 'monthly', 'yearly', 'hourly'] },
      days: { type: 'array', items: { type: 'string' }, description: 'Weekly on these days: ["mon", "thu"].' },
      every: { type: 'string', description: 'An interval instead: "2h", "30m", "3 days".' },
      until: { type: 'string', description: 'Last day for a repeat: "YYYY-MM-DD".' },
      prompt: { type: 'string', description: 'An instruction to yourself for when it goes off, e.g. "Check the weather and tell the owner whether to take an umbrella." or "Send the owner a Telegram message: submit the timesheet."' },
      message: { type: 'string', description: 'What to say if nothing else (shown at once for alarms and timers). Default from the title.' },
      allow_changes: { type: 'boolean', description: 'Let the task change or delete files when it runs (only if the owner asked for that).' },
    },
    ['title'],
    async (args) => {
      if (!ctx.kindOn('create')) return { text: 'Creating things is switched off in the Tools tab.', isError: true }
      try {
        const days = Array.isArray(args.days) ? args.days.map(String) : str(args.days) || undefined
        const s = scheduler.create({
          title: str(args.title),
          kind: KINDS.includes(str(args.kind) as ScheduleKind) ? (str(args.kind) as ScheduleKind) : undefined,
          in: str(args.in) || undefined,
          time: str(args.time) || undefined,
          date: str(args.date) || undefined,
          repeat: str(args.repeat) || undefined,
          days,
          every: str(args.every) || undefined,
          until: str(args.until) || undefined,
          prompt: str(args.prompt) || undefined,
          message: str(args.message) || undefined,
          allowChanges: args.allow_changes === true,
        })
        return { text: confirmation(s), isError: false }
      } catch (err) {
        return { text: err instanceof ScheduleError ? err.message : `Couldn't set it: ${(err as Error).message}`, isError: true }
      }
    },
  )

  const cancel = tool(
    'jarvis__cancel_schedule',
    'Jarvis: cancel schedule',
    ['delete'],
    'Cancel a timer, alarm, reminder or task (by its id or title, e.g. "pasta"). only_next: true skips just its next time (for repeats).',
    { schedule: { type: 'string', description: 'Its id or title.' }, only_next: { type: 'boolean' } },
    ['schedule'],
    async (args) => {
      if (!ctx.kindOn('delete')) return { text: 'Deleting things is switched off in the Tools tab.', isError: true }
      const found = scheduler.find(str(args.schedule))
      if (found.length === 0) return { text: `Nothing scheduled matches "${str(args.schedule)}". jarvis__list_schedules shows what there is.`, isError: true }
      if (found.length > 1) return { text: `Several match: ${found.map((s) => scheduler.describe(s)).join('; ')}. Ask the owner which, or use the id.`, isError: true }
      try {
        const s = found[0]!
        if (args.only_next === true) {
          scheduler.skipNext(s.id)
          return { text: `Skipped its next time. Now: ${scheduler.describe(s)}.`, isError: false }
        }
        scheduler.remove(s.id)
        // Ringing for it: stopped too.
        for (const n of notifier.ringing()) if (n.scheduleId === s.id) notifier.ack(n.id, 'dismiss')
        return { text: `Cancelled ${s.kind} "${s.title}".`, isError: false }
      } catch (err) {
        return { text: (err as Error).message, isError: true }
      }
    },
  )

  const alarm = tool(
    'jarvis__alarm',
    'Jarvis: stop or snooze',
    ['read'],
    'Stop or snooze whatever is ringing now (alarms, timers). Snooze: rings again after "minutes" (default 9).',
    { action: { type: 'string', enum: ['stop', 'snooze'] }, minutes: { type: 'number' } },
    ['action'],
    async (args) => {
      const snooze = str(args.action).toLowerCase() === 'snooze'
      const minutes = Number(args.minutes) > 0 ? Number(args.minutes) : 9
      const done = notifier.ack(null, snooze ? 'snooze' : 'dismiss', minutes)
      if (!done.length) return { text: 'Nothing is ringing.', isError: false }
      return { text: `${snooze ? `Snoozed for ${minutes} minutes` : 'Stopped'}: ${done.map((n) => `"${n.title}"`).join(', ')}.`, isError: false }
    },
  )

  return [set, list, cancel, alarm, notify, presence]
}
