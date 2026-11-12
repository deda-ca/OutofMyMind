// Notifications on the owner's screens: every open Jarvis tab (GET
// /api/notifications/stream, server-sent events) shows them, speaks them, and
// rings for alarms until someone dismisses or snoozes them (on screen, or by
// saying "stop" / "snooze"). Shown when nobody is there: kept, and delivered
// when a screen next connects ("while you were away").
//
// Other ways to reach the owner (Telegram, email, …) aren't here: they're
// MCP tools, and the LLM picks them (see scheduler.ts). This is only the
// built-in screen, plus "presence": whether anyone is at a screen, and when the
// owner last spoke, so the LLM can decide.

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

export type Urgency = 'info' | 'reminder' | 'alarm'

export interface Notification {
  id: string
  at: string
  title: string
  text: string
  urgency: Urgency
  /** Rings until acknowledged. */
  ring: boolean
  /** The schedule it came from, if any. */
  scheduleId?: string
  /** Shown, never spoken (a service's notifications). */
  silent?: boolean
  /**
   * active: on screen (ringing, if it rings); pending: nobody was there yet;
   * shown: delivered, nothing to acknowledge; dismissed / snoozed; unanswered: rang out.
   */
  status: 'active' | 'pending' | 'shown' | 'dismissed' | 'snoozed' | 'unanswered'
  /** Delivered later than it went off (nobody was at a screen). */
  late?: boolean
  doneAt?: string
}

/** What a connected screen is sent. */
export type NotifierEvent =
  | { type: 'notify'; notification: Notification; speak: boolean }
  | { type: 'ended'; id: string; status: Notification['status'] }
  | { type: 'schedules' }
  | { type: 'services' }
  | { type: 'phone' }
  /** A plugin's tab should refresh (it sent an event, or asked). */
  | { type: 'plugin'; name: string }
  /** What a plugin's tab button shows (null: just its title and icon). */
  | { type: 'plugin-status'; name: string; status: { icon?: string; animate?: boolean; badge?: string; title?: string } | null }
  /** What the LLMs have cost changed (GET /api/usage). */
  | { type: 'usage' }

interface Screen {
  id: number
  device: string
  since: number
  send: (event: NotifierEvent) => void
}

/** An alarm that nobody answers for this long counts as unacknowledged (the LLM is woken to try another way). */
export const UNACKNOWLEDGED_MS = 2 * 60_000
/** It stops ringing after this long. */
const RING_OUT_MS = 10 * 60_000
const KEEP = 100

export class Notifier extends EventEmitter<{
  /** Snoozed or dismissed (on screen, by voice or by the LLM). */
  ack: [notification: Notification, action: 'dismiss' | 'snooze', minutes: number]
  /** A ringing alarm nobody answered within UNACKNOWLEDGED_MS. */
  unacknowledged: [notification: Notification]
  change: []
}> {
  private screens = new Map<number, Screen>()
  private nextScreen = 1
  private list: Notification[] = []
  private timers = new Map<string, ReturnType<typeof setTimeout>[]>()
  private lastHeard: number | null = null
  private listening = 0
  private readonly file: string | null

  constructor(file: string | null = null) {
    super()
    this.file = file
    if (file) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Notification[]
        // Whatever was ringing when the server stopped has rung out.
        this.list = saved.map((n) => (n.status === 'active' ? { ...n, status: n.ring ? 'unanswered' : 'shown' } : n))
      } catch {
        // none yet
      }
    }
  }

  // ------------------------------------------------------------------ screens and presence

  /** A screen connected; returns how to disconnect it. Anything pending is delivered to it. */
  connect(device: string, send: (event: NotifierEvent) => void): () => void {
    const screen: Screen = { id: this.nextScreen++, device, since: Date.now(), send }
    this.screens.set(screen.id, screen)
    // Still ringing: this screen rings too (no speech: it was said already).
    for (const n of this.list) if (n.status === 'active' && n.ring) send({ type: 'notify', notification: n, speak: false })
    const pending = this.list.filter((n) => n.status === 'pending')
    for (const n of pending) {
      n.status = 'shown'
      n.late = true
      send({ type: 'notify', notification: { ...n, ring: false }, speak: !n.silent })
    }
    if (pending.length) this.saved()
    return () => this.screens.delete(screen.id)
  }

  /** The owner spoke or typed to Jarvis. */
  heard(): void {
    this.lastHeard = Date.now()
  }

  /** A microphone started (+1) or stopped (-1) listening. */
  setListening(delta: 1 | -1): void {
    this.listening = Math.max(0, this.listening + delta)
  }

  presence(): { screens: { device: string; since: string }[]; listening: number; lastHeard: string | null } {
    return {
      screens: [...this.screens.values()].map((s) => ({ device: s.device, since: new Date(s.since).toISOString() })),
      listening: this.listening,
      lastHeard: this.lastHeard ? new Date(this.lastHeard).toISOString() : null,
    }
  }

  /** Presence in words, for the LLM. */
  describePresence(now = Date.now()): string {
    const p = this.presence()
    const screens = p.screens.length
    const ago = (iso: string) => {
      const mins = Math.round((now - new Date(iso).getTime()) / 60_000)
      return mins < 1 ? 'just now' : mins < 60 ? `${mins} minute${mins === 1 ? '' : 's'} ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} hours ago` : `${Math.round(mins / 1440)} days ago`
    }
    return [
      screens ? `${screens} Jarvis screen${screens === 1 ? '' : 's'} open (${p.screens.map((s) => s.device).join(', ')}), so jarvis__notify reaches the owner if they're nearby.` : 'No Jarvis screen is open: jarvis__notify will only be seen when one opens. To reach the owner now, use another way if you have one (a messaging tool), and say so.',
      p.listening ? `A microphone is listening (${p.listening}).` : 'No microphone is listening.',
      p.lastHeard ? `The owner last spoke to Jarvis ${ago(p.lastHeard)}.` : 'The owner hasn\'t spoken to Jarvis since the server started.',
    ].join(' ')
  }

  // ------------------------------------------------------------------ notifications

  /** Puts a notification on every open screen (spoken, unless `speak: false`). Kept for later if none is open. */
  notify(input: { title: string; text: string; urgency?: Urgency; ring?: boolean; scheduleId?: string; speak?: boolean }): { notification: Notification; screens: number } {
    const urgency = input.urgency ?? 'info'
    const n: Notification = {
      id: randomUUID(),
      at: new Date().toISOString(),
      title: input.title.trim().slice(0, 120) || 'Jarvis',
      text: input.text.trim().slice(0, 2000),
      urgency,
      ring: input.ring ?? urgency === 'alarm',
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
      ...(input.speak === false ? { silent: true } : {}),
      status: 'pending',
    }
    this.list.push(n)
    if (this.list.length > KEEP) this.list.splice(0, this.list.length - KEEP)
    const screens = this.screens.size
    if (screens > 0) {
      n.status = n.ring ? 'active' : 'shown'
      this.broadcast({ type: 'notify', notification: n, speak: !n.silent })
      if (n.ring) this.startRinging(n)
    } else if (n.ring) {
      // Nobody to hear it now: still counts as unanswered after a while, so the LLM can try another way.
      this.later(n.id, UNACKNOWLEDGED_MS, () => this.emit('unacknowledged', n))
    }
    this.saved()
    return { notification: n, screens }
  }

  /** Ringing now. */
  ringing(): Notification[] {
    return this.list.filter((n) => n.status === 'active' && n.ring)
  }

  /** Dismiss or snooze one (or, without an id, everything ringing). Returns what was acknowledged. */
  ack(id: string | null, action: 'dismiss' | 'snooze', minutes = 9): Notification[] {
    const targets = id ? this.list.filter((n) => n.id === id && (n.status === 'active' || n.status === 'pending')) : this.ringing()
    for (const n of targets) {
      this.finish(n, action === 'snooze' ? 'snoozed' : 'dismissed')
      this.emit('ack', n, action, minutes)
    }
    return targets
  }

  recent(): Notification[] {
    return [...this.list].reverse()
  }

  /** Tell every screen something changed (e.g. the schedules). */
  broadcast(event: NotifierEvent): void {
    for (const s of this.screens.values()) {
      try {
        s.send(event)
      } catch {
        this.screens.delete(s.id)
      }
    }
  }

  close(): void {
    for (const list of this.timers.values()) list.forEach(clearTimeout)
    this.timers.clear()
  }

  private startRinging(n: Notification): void {
    this.later(n.id, UNACKNOWLEDGED_MS, () => {
      if (n.status === 'active') this.emit('unacknowledged', n)
    })
    this.later(n.id, RING_OUT_MS, () => {
      if (n.status === 'active') this.finish(n, 'unanswered')
    })
  }

  private finish(n: Notification, status: Notification['status']): void {
    n.status = status
    n.doneAt = new Date().toISOString()
    for (const t of this.timers.get(n.id) ?? []) clearTimeout(t)
    this.timers.delete(n.id)
    this.broadcast({ type: 'ended', id: n.id, status })
    this.saved()
  }

  private later(id: string, ms: number, run: () => void): void {
    const t = setTimeout(run, ms)
    t.unref?.()
    this.timers.set(id, [...(this.timers.get(id) ?? []), t])
  }

  private saved(): void {
    this.emit('change')
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.list, null, 1))
    } catch {
      // not kept across restarts this time
    }
  }
}
