// Notifications from Jarvis's scheduler (server: src/schedule): every open tab
// gets them over server-sent events, whether or not it's listening. Each one
// is shown (a toast, or a ringing card for alarms and timers), spoken in
// Jarvis's voice, and, when the tab is in the background, shown by the
// browser as a system notification too. Alarms ring until dismissed or
// snoozed, here, on another screen, or by voice ("stop", "snooze").
//
// Also keeps the schedule list (for the Schedule tab and the timer
// countdowns), reloaded whenever the server says it changed.

import { reactive } from 'vue'

export interface Notice {
  id: string
  at: string
  title: string
  text: string
  urgency: 'info' | 'reminder' | 'alarm'
  ring: boolean
  scheduleId?: string
  status: 'active' | 'pending' | 'shown' | 'dismissed' | 'snoozed' | 'unanswered'
  late?: boolean
}

export interface ScheduleView {
  id: string
  title: string
  kind: 'timer' | 'alarm' | 'reminder' | 'task'
  prompt: string
  message: string
  start: string
  repeat?: { every: string; interval?: number; days?: string[]; until?: string }
  allowChanges?: boolean
  enabled: boolean
  created: string
  next: string | null
  snoozedUntil?: string | null
  last?: { at: string; result: string; note?: string }
  due: string | null
  summary: string
}

export interface Presence {
  screens: { device: string; since: string }[]
  listening: number
  lastHeard: string | null
}

export const notices = reactive({
  /** On screen now: ringing ones until acknowledged, others for a while. */
  shown: [] as Notice[],
  schedules: [] as ScheduleView[],
  presence: null as Presence | null,
  connected: false,
  /** Browser notifications: 'default' until asked. */
  permission: (typeof Notification !== 'undefined' ? Notification.permission : 'denied') as NotificationPermission,
  /** Don't speak notifications (they're still shown and still ring). */
  quiet: false,
})

const TOAST_MS = 20_000
let source: EventSource | null = null
let retry: ReturnType<typeof setTimeout> | undefined

/** Connects this tab (once signed in). */
export function connectNotifications(device = deviceName()): void {
  if (source) return
  try {
    notices.quiet = localStorage.getItem('jarvis.quietNotifications') === '1'
  } catch {
    // private window
  }
  source = new EventSource(`/api/notifications/stream?device=${encodeURIComponent(device)}`)
  source.onopen = () => {
    notices.connected = true
    void loadSchedules()
  }
  source.onerror = () => {
    notices.connected = false
    // EventSource retries by itself, unless the server refused (e.g. signed out).
    if (source?.readyState === EventSource.CLOSED) {
      source = null
      clearTimeout(retry)
      retry = setTimeout(() => connectNotifications(device), 5000)
    }
  }
  source.onmessage = (e) => {
    const event = JSON.parse(String(e.data)) as { type: 'notify'; notification: Notice; speak: boolean } | { type: 'ended'; id: string; status: Notice['status'] } | { type: 'schedules' }
    if (event.type === 'notify') arrive(event.notification, event.speak)
    else if (event.type === 'ended') end(event.id)
    else void loadSchedules()
  }
}

export function disconnectNotifications(): void {
  source?.close()
  source = null
  clearTimeout(retry)
  notices.connected = false
  stopRinging()
}

export function setQuiet(quiet: boolean): void {
  notices.quiet = quiet
  try {
    localStorage.setItem('jarvis.quietNotifications', quiet ? '1' : '0')
  } catch {
    // not remembered
  }
}

export async function askPermission(): Promise<void> {
  if (typeof Notification === 'undefined') return
  notices.permission = await Notification.requestPermission()
}

/** Dismiss or snooze one (or everything ringing, with no id). */
export async function acknowledge(id: string | null, action: 'dismiss' | 'snooze', minutes = 9): Promise<void> {
  // At once here; the server tells every screen (this one too).
  if (id) end(id)
  else for (const n of notices.shown.filter((x) => x.ring)) end(n.id)
  await fetch(`/api/notifications/${id ?? 'ringing'}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, minutes }) }).catch(() => {})
}

/** Closes a toast (nothing to acknowledge). */
export function close(id: string): void {
  end(id)
}

export async function loadSchedules(): Promise<void> {
  try {
    const response = await fetch('/api/schedules')
    if (!response.ok) return
    const body = (await response.json()) as { schedules: ScheduleView[]; presence: Presence }
    notices.schedules = body.schedules
    notices.presence = body.presence
  } catch {
    // shown when it next loads
  }
}

function arrive(n: Notice, speak: boolean): void {
  if (notices.shown.some((x) => x.id === n.id)) return
  notices.shown.push(n)
  if (n.ring) startRinging()
  else setTimeout(() => end(n.id), TOAST_MS)
  if (speak && !notices.quiet) say(n.late ? `While you were away: ${n.text}` : n.text)
  if (typeof document !== 'undefined' && document.hidden && notices.permission === 'granted') {
    try {
      const shown = new Notification(n.title, { body: n.text, tag: n.id, requireInteraction: n.ring })
      shown.onclick = () => {
        window.focus()
        shown.close()
      }
    } catch {
      // some browsers only allow it from a service worker
    }
  }
}

function end(id: string): void {
  const i = notices.shown.findIndex((n) => n.id === id)
  if (i !== -1) notices.shown.splice(i, 1)
  if (!notices.shown.some((n) => n.ring)) stopRinging()
}

// ------------------------------------------------------------------ sound

let audioCtx: AudioContext | null = null
let ringTimer: ReturnType<typeof setInterval> | undefined
const speech = typeof Audio !== 'undefined' ? new Audio() : null
let speechQueue: Promise<void> = Promise.resolve()

/** Browsers only allow sound after the page has been used: unlocked on the first click or key. */
export function unlockSound(): void {
  if (typeof window === 'undefined') return
  const unlock = () => {
    try {
      audioCtx ??= new AudioContext()
      void audioCtx.resume()
    } catch {
      // no Web Audio
    }
  }
  window.addEventListener('pointerdown', unlock, { once: true, capture: true })
  window.addEventListener('keydown', unlock, { once: true, capture: true })
}

/** Two short tones, every 1.6 s, until stopped. */
function startRinging(): void {
  if (ringTimer) return
  const beep = () => {
    try {
      audioCtx ??= new AudioContext()
      const t = audioCtx.currentTime
      for (const [offset, freq] of [[0, 880], [0.22, 1175]] as const) {
        const osc = audioCtx.createOscillator()
        const gain = audioCtx.createGain()
        osc.frequency.value = freq
        osc.type = 'sine'
        gain.gain.setValueAtTime(0.0001, t + offset)
        gain.gain.exponentialRampToValueAtTime(0.25, t + offset + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.18)
        osc.connect(gain).connect(audioCtx.destination)
        osc.start(t + offset)
        osc.stop(t + offset + 0.2)
      }
    } catch {
      // no sound: the card still shows
    }
  }
  beep()
  ringTimer = setInterval(beep, 1600)
}

function stopRinging(): void {
  clearInterval(ringTimer)
  ringTimer = undefined
}

/** Spoken in Jarvis's voice (POST /api/tts), one at a time. */
function say(text: string): void {
  if (!speech) return
  const pieces = text.match(/[^.!?]+[.!?]*\s*/g)?.map((p) => p.trim()).filter(Boolean) ?? [text]
  for (const piece of pieces) {
    const clip = fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: piece.slice(0, 1000) }) })
      .then((r) => (r.ok ? r.blob() : null))
      .catch(() => null)
    speechQueue = speechQueue.then(async () => {
      const blob = await clip
      if (!blob) return
      const url = URL.createObjectURL(blob)
      try {
        speech.src = url
        await speech.play()
        await new Promise<void>((resolve) => {
          speech.onended = () => resolve()
          speech.onerror = () => resolve()
        })
      } catch {
        // not allowed to play yet (no click on the page)
      } finally {
        URL.revokeObjectURL(url)
      }
    })
  }
}

function deviceName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const browser = /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser'
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return `${browser}${os ? ` on ${os}` : ''}`
}
