<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { askPermission, loadSchedules, notices, setQuiet, type Notice, type ScheduleView } from '../notifications'

// Timers, alarms, reminders and scheduled tasks (server: src/schedule). Each
// is a time (or a repeat) and what Jarvis is told to do then; it decides how to
// tell you (this screen, or a messaging plugin), and its fixed message is
// shown if it can't. Kept in the workspace's schedules.json.

const error = ref('')
const notice = ref('')
const busy = ref(false)
const recent = ref<Notice[]>([])
const now = ref(Date.now())
const ticker = setInterval(() => (now.value = Date.now()), 1000)
onBeforeUnmount(() => clearInterval(ticker))

const KINDS = [
  { value: 'timer', label: 'Timer', hint: 'A countdown: rings when it ends.' },
  { value: 'alarm', label: 'Alarm', hint: 'Rings at a time until stopped.' },
  { value: 'reminder', label: 'Reminder', hint: 'Said and shown once.' },
  { value: 'task', label: 'Task', hint: 'Jarvis does something then (looks something up, sends a message).' },
] as const
const THEMES: Record<string, string> = { timer: 'theme-info', alarm: 'theme-danger', reminder: 'theme-primary', task: 'theme-success' }
const DAYS = [
  ['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun'],
] as const

/** null: closed; id null: new. */
const editing = ref<{ id: string | null } | null>(null)
const form = reactive({
  title: '',
  kind: 'reminder' as ScheduleView['kind'],
  whenMode: 'at' as 'in' | 'at',
  in: '10m',
  time: '',
  date: '',
  repeat: 'none',
  days: [] as string[],
  every: '',
  prompt: '',
  message: '',
  allowChanges: false,
  /** Editing: change the time too (otherwise it stays as it is). */
  retime: false,
})

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function act(what: () => Promise<void>, done = ''): Promise<boolean> {
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    await what()
    notice.value = done
    await refresh()
    return true
  } catch (err) {
    error.value = (err as Error).message
    return false
  } finally {
    busy.value = false
  }
}

async function refresh(): Promise<void> {
  await loadSchedules()
  try {
    recent.value = (await api<{ notifications: Notice[] }>('/api/notifications')).notifications.slice(0, 20)
  } catch {
    // the list stays as it was
  }
}

onMounted(refresh)
// The server says what changed; the log follows.
watch(() => notices.schedules, () => void api<{ notifications: Notice[] }>('/api/notifications').then((r) => (recent.value = r.notifications.slice(0, 20))).catch(() => {}))

const active = computed(() => notices.schedules.filter((s) => s.enabled && s.due))
const paused = computed(() => notices.schedules.filter((s) => !s.enabled))
const done = computed(() => notices.schedules.filter((s) => s.enabled && !s.due))

function countdown(s: ScheduleView): string {
  if (!s.due) return ''
  const ms = new Date(s.due).getTime() - now.value
  if (ms <= 0) return 'now'
  const sec = Math.round(ms / 1000)
  if (sec < 3600) return `in ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
  const h = Math.floor(sec / 3600)
  if (h < 48) return `in ${h} h ${Math.floor((sec % 3600) / 60)} min`
  return `in ${Math.round(h / 24)} days`
}
const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function startCreate(): void {
  Object.assign(form, { title: '', kind: 'reminder', whenMode: 'at', in: '10m', time: '', date: '', repeat: 'none', days: [], every: '', prompt: '', message: '', allowChanges: false, retime: true })
  editing.value = { id: null }
}

function startEdit(s: ScheduleView): void {
  const start = new Date(s.start)
  const repeat = !s.repeat ? 'none' : s.repeat.every === 'day' && s.repeat.days?.join() === 'mon,tue,wed,thu,fri' ? 'weekdays' : s.repeat.every === 'day' && s.repeat.days?.join() === 'sun,sat' ? 'weekends' : s.repeat.every === 'day' && !s.repeat.days ? 'daily' : s.repeat.every === 'week' ? 'weekly' : s.repeat.every === 'month' ? 'monthly' : s.repeat.every === 'year' ? 'yearly' : 'none'
  Object.assign(form, {
    title: s.title,
    kind: s.kind,
    whenMode: 'at',
    in: '10m',
    time: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
    date: s.repeat ? '' : `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
    repeat,
    days: s.repeat?.every === 'week' ? [...(s.repeat.days ?? [])] : [],
    every: '',
    prompt: s.prompt,
    message: s.message,
    allowChanges: !!s.allowChanges,
    retime: false,
  })
  editing.value = { id: s.id }
}

function whenFields(): Record<string, unknown> {
  if (form.whenMode === 'in') return { in: form.in, ...(form.every.trim() ? { every: form.every } : {}) }
  return {
    time: form.time,
    ...(form.date ? { date: form.date } : {}),
    ...(form.repeat !== 'none' && !(form.repeat === 'weekly' && form.days.length) ? { repeat: form.repeat } : {}),
    ...(form.repeat === 'weekly' && form.days.length ? { days: form.days } : {}),
    ...(form.repeat === 'none' ? { repeat: 'none' } : {}),
  }
}

async function save(): Promise<void> {
  const body = {
    title: form.title,
    kind: form.kind,
    prompt: form.prompt,
    message: form.message,
    allowChanges: form.allowChanges,
    ...(form.retime || !editing.value?.id ? whenFields() : {}),
  }
  const id = editing.value?.id
  const ok = await act(async () => {
    const s = id ? await api<ScheduleView>(`/api/schedules/${id}`, json('PATCH', body)) : await api<ScheduleView>('/api/schedules', json('POST', body))
    notice.value = `${id ? 'Saved' : 'Set'}: ${s.summary}`
  })
  if (ok) editing.value = null
}

const toggle = (s: ScheduleView) => act(() => api(`/api/schedules/${s.id}`, json('PATCH', { enabled: !s.enabled })).then(() => {}), s.enabled ? `Paused "${s.title}".` : `"${s.title}" is back on.`)
const runNow = (s: ScheduleView) => act(() => api(`/api/schedules/${s.id}/run`, { method: 'POST' }).then(() => {}), `"${s.title}" is going off now.`)
const skip = (s: ScheduleView) => act(() => api(`/api/schedules/${s.id}/skip`, { method: 'POST' }).then(() => {}), `Skipped the next "${s.title}".`)
async function remove(s: ScheduleView): Promise<void> {
  if (!confirm(`Delete "${s.title}"?`)) return
  await act(() => api(`/api/schedules/${s.id}`, { method: 'DELETE' }).then(() => {}), `Deleted "${s.title}".`)
}

const presenceLine = computed(() => {
  const p = notices.presence
  if (!p) return ''
  const screens = p.screens.length ? `${p.screens.length} screen${p.screens.length === 1 ? '' : 's'} open (${p.screens.map((s) => s.device).join(', ')})` : 'no screen open'
  return `${screens} · ${p.listening ? `${p.listening} microphone${p.listening === 1 ? '' : 's'} listening` : 'no microphone listening'}`
})
const resultLabel: Record<string, string> = { delivered: 'told you', fallback: 'message shown (Jarvis reached nobody)', failed: 'message shown (Jarvis failed)', skipped: 'skipped' }
</script>

<template>
  <div class="vstack gap-4">
    <div class="d-flex align-items-center gap-3 flex-wrap">
      <span class="text-sm fg-3">
        Timers, alarms, reminders and tasks. When one goes off, Jarvis is told what to do and decides how to tell you: here, or
        another way it has (a messaging plugin) if you ask. If it can't, the message is shown and spoken anyway. You can also just
        say “set a timer for 10 minutes” or “wake me at 6:45 on weekdays”. Kept in the workspace's <code>schedules.json</code>.
      </span>
      <button type="button" class="btn-solid theme-primary btn-sm ms-auto" :disabled="busy || editing !== null" @click="startCreate">+ New</button>
    </div>

    <div class="d-flex align-items-center gap-3 flex-wrap text-sm">
      <span class="badge" :class="notices.connected ? 'theme-success badge-subtle' : 'theme-warning'">{{ notices.connected ? 'This screen gets notifications' : 'Not connected for notifications' }}</span>
      <span v-if="presenceLine" class="fg-3">{{ presenceLine }}</span>
      <label class="d-flex align-items-center gap-2 m-0 ms-auto"><input type="checkbox" :checked="notices.quiet" @change="setQuiet(($event.target as HTMLInputElement).checked)" /> Don't speak them here</label>
      <button v-if="notices.permission === 'default'" type="button" class="btn-outline theme-secondary btn-sm" @click="askPermission">Allow system notifications</button>
      <span v-else-if="notices.permission === 'granted'" class="fg-3">System notifications on (when this tab is in the background)</span>
    </div>

    <div v-if="error" class="alert theme-danger m-0" role="alert">{{ error }}</div>
    <div v-if="notice" class="alert theme-success m-0" role="status">{{ notice }}</div>

    <form v-if="editing" class="card" @submit.prevent="save">
      <div class="card-header"><span class="fw-semibold">{{ editing.id ? `Edit ${form.title}` : 'New' }}</span></div>
      <div class="card-body vstack gap-4">
        <div class="row g-3">
          <div class="col-12 md:col-6 vstack gap-1">
            <label for="sch-title" class="form-label m-0 fw-semibold">Title</label>
            <input id="sch-title" v-model="form.title" class="form-control" maxlength="80" required placeholder="e.g. Pasta, Wake-up, Bins" />
          </div>
          <div class="col-12 md:col-6 vstack gap-1">
            <label for="sch-kind" class="form-label m-0 fw-semibold">Kind</label>
            <select id="sch-kind" v-model="form.kind" class="form-control">
              <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }} — {{ k.hint }}</option>
            </select>
          </div>
        </div>

        <fieldset class="vstack gap-2">
          <legend class="form-label fw-semibold m-0 fs-6">When</legend>
          <label v-if="editing.id" class="d-flex align-items-center gap-2 m-0"><input v-model="form.retime" type="checkbox" /> Change the time</label>
          <template v-if="form.retime || !editing.id">
            <div class="d-flex gap-4 flex-wrap">
              <label class="d-flex align-items-center gap-2 m-0"><input v-model="form.whenMode" type="radio" value="in" /> In…</label>
              <label class="d-flex align-items-center gap-2 m-0"><input v-model="form.whenMode" type="radio" value="at" /> At a time</label>
            </div>
            <div v-if="form.whenMode === 'in'" class="row g-3">
              <div class="col-12 md:col-6 vstack gap-1">
                <label for="sch-in" class="form-label m-0">From now</label>
                <input id="sch-in" v-model="form.in" class="form-control" placeholder="10m, 1h30m, 90 seconds" required />
              </div>
              <div class="col-12 md:col-6 vstack gap-1">
                <label for="sch-every" class="form-label m-0">Then every (optional)</label>
                <input id="sch-every" v-model="form.every" class="form-control" placeholder="2h, 30m, 3 days" />
              </div>
            </div>
            <div v-else class="row g-3">
              <div class="col-6 md:col-3 vstack gap-1">
                <label for="sch-time" class="form-label m-0">Time</label>
                <input id="sch-time" v-model="form.time" type="time" class="form-control" required />
              </div>
              <div class="col-6 md:col-3 vstack gap-1">
                <label for="sch-date" class="form-label m-0">Date</label>
                <input id="sch-date" v-model="form.date" type="date" class="form-control" />
                <span class="form-text m-0">Empty: the next time it comes round.</span>
              </div>
              <div class="col-12 md:col-6 vstack gap-1">
                <label for="sch-repeat" class="form-label m-0">Repeat</label>
                <select id="sch-repeat" v-model="form.repeat" class="form-control">
                  <option value="none">Once</option>
                  <option value="daily">Every day</option>
                  <option value="weekdays">Weekdays</option>
                  <option value="weekends">Weekends</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
                <div v-if="form.repeat === 'weekly'" class="d-flex gap-3 flex-wrap mt-1">
                  <label v-for="[d, label] in DAYS" :key="d" class="d-flex align-items-center gap-1 m-0"><input v-model="form.days" type="checkbox" :value="d" /> {{ label }}</label>
                </div>
              </div>
            </div>
          </template>
        </fieldset>

        <div class="vstack gap-1">
          <label for="sch-prompt" class="form-label m-0 fw-semibold">What Jarvis does when it goes off</label>
          <textarea id="sch-prompt" v-model="form.prompt" class="form-control" rows="3" maxlength="2000" placeholder="e.g. Check the weather and tell me whether to take an umbrella. Or: Send me a Telegram message to submit my timesheet. Empty: just the message."></textarea>
          <span class="form-text m-0">An instruction to Jarvis, run with its tools. It decides how to reach you; say so here to use another way.</span>
        </div>
        <div class="vstack gap-1">
          <label for="sch-message" class="form-label m-0 fw-semibold">Message</label>
          <input id="sch-message" v-model="form.message" class="form-control" maxlength="300" placeholder="Default from the title, e.g. “The Pasta timer is done.”" />
          <span class="form-text m-0">Shown and spoken as it is: at once for alarms and timers, and whenever Jarvis can't do the above.</span>
        </div>
        <label class="d-flex align-items-center gap-2 m-0">
          <input v-model="form.allowChanges" type="checkbox" />
          Let it change or delete files when it runs (otherwise it can only look things up and send messages)
        </label>
        <div class="d-flex gap-2">
          <button type="submit" class="btn-solid theme-primary" :disabled="busy">{{ editing.id ? 'Save' : 'Set' }}</button>
          <button type="button" class="btn-outline theme-secondary" :disabled="busy" @click="editing = null">Cancel</button>
        </div>
      </div>
    </form>

    <div v-if="!notices.schedules.length && !editing" class="fg-3">Nothing is scheduled.</div>

    <div v-for="group in [{ name: 'Coming up', list: active }, { name: 'Paused', list: paused }, { name: 'Done', list: done }]" :key="group.name" class="vstack gap-2">
      <template v-if="group.list.length">
        <h2 class="text-lg fw-semibold m-0">{{ group.name }}</h2>
        <div v-for="s in group.list" :key="s.id" class="card">
          <div class="card-body vstack gap-2">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <span class="badge badge-subtle" :class="THEMES[s.kind]">{{ s.kind }}</span>
              <span class="fw-semibold">{{ s.title }}</span>
              <span v-if="s.due" class="font-monospace">{{ when(s.due) }}</span>
              <span v-if="s.due" class="fg-3 text-sm">{{ countdown(s) }}</span>
              <span v-if="s.snoozedUntil" class="badge theme-warning badge-subtle">snoozed</span>
              <span v-if="s.allowChanges" class="badge theme-warning badge-subtle" title="Can change or delete files when it runs">may change files</span>
              <div class="d-flex gap-1 ms-auto flex-wrap">
                <button type="button" class="btn-text btn-sm" :disabled="busy" title="Go off now, to try it" @click="runNow(s)">Run now</button>
                <button v-if="s.repeat && s.due" type="button" class="btn-text btn-sm" :disabled="busy" @click="skip(s)">Skip next</button>
                <button type="button" class="btn-text btn-sm" :disabled="busy" @click="toggle(s)">{{ s.enabled ? 'Pause' : 'Resume' }}</button>
                <button type="button" class="btn-text btn-sm" :disabled="busy || editing !== null" @click="startEdit(s)">Edit</button>
                <button type="button" class="btn-text btn-sm theme-danger" :disabled="busy" @click="remove(s)">Delete</button>
              </div>
            </div>
            <div class="text-sm fg-3">{{ s.summary.replace(/^[a-z]+ "[^"]*" \[[^\]]*\]: /, '') }}</div>
            <div v-if="s.prompt" class="text-sm"><span class="fg-3">Jarvis:</span> {{ s.prompt }}</div>
            <div class="text-sm"><span class="fg-3">Message:</span> {{ s.message }}</div>
            <div v-if="s.last" class="text-xs fg-3">Last: {{ when(s.last.at) }} — {{ resultLabel[s.last.result] ?? s.last.result }}{{ s.last.note ? ` (${s.last.note})` : '' }}</div>
          </div>
        </div>
      </template>
    </div>

    <details v-if="recent.length" class="vstack gap-2">
      <summary class="fw-semibold">Recent notifications</summary>
      <ul class="list-unstyled vstack gap-1 mt-2 text-sm">
        <li v-for="n in recent" :key="n.id" class="d-flex gap-2">
          <span class="font-monospace fg-3 text-nowrap">{{ when(n.at) }}</span>
          <span class="fw-semibold text-nowrap">{{ n.title }}</span>
          <span class="flex-grow-1">{{ n.text }}</span>
          <span class="fg-3 text-nowrap">{{ n.status }}</span>
        </li>
      </ul>
    </details>
  </div>
</template>
