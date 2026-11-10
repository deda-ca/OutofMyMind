<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { loadServices, servicesState, type ServiceView } from '../services'

// Background services Jarvis writes (server: apps/server/src/services, design:
// docs/services.md). Nothing runs until approved here: a new service, and
// every change to one, shows what it may do and the code, and waits for you.
// Secrets are typed here and never shown again, not to you and not to Jarvis.
// Development mode, while a service is being built and debugged: every change
// Jarvis saves is approved by itself, until you lock it (or the time runs out).

interface Changes {
  hash: string
  widened: string[]
  permissions: string[]
  files: { file: string; status: 'added' | 'changed' | 'deleted'; diff: string }[]
  error?: string
}

const error = ref('')
const notice = ref('')
const busy = ref(false)
/** Open "review" panels, by service id. */
const reviewing = reactive<Record<string, Changes | undefined>>({})
const logs = reactive<Record<string, string | undefined>>({})
const secretInput = reactive<Record<string, string>>({})
const newSecret = reactive({ name: '', value: '' })
/** How long development mode lasts, per service: hours, or 'lock' (until locked). */
const devFor = reactive<Record<string, string>>({})
const DEV_CHOICES = [
  ['2', 'for 2 hours'],
  ['24', 'for a day'],
  ['168', 'for a week'],
  ['lock', 'until I lock it'],
] as const
const hoursOf = (s: ServiceView) => ((devFor[s.id] ?? '24') === 'lock' ? null : Number(devFor[s.id] ?? '24'))

const STATUS: Record<ServiceView['status'], { label: string; theme: string }> = {
  active: { label: 'running', theme: 'theme-success' },
  waiting: { label: 'needs approval', theme: 'theme-warning' },
  changed: { label: 'changes to approve', theme: 'theme-warning' },
  rejected: { label: 'turned down', theme: 'theme-secondary' },
  paused: { label: 'paused', theme: 'theme-secondary' },
  'needs-secret': { label: 'needs a secret', theme: 'theme-warning' },
  error: { label: 'problem', theme: 'theme-danger' },
  missing: { label: 'folder gone', theme: 'theme-secondary' },
}

const missingSecrets = computed(() => servicesState.secrets.filter((s) => !s.set))

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
    return true
  } catch (err) {
    error.value = (err as Error).message
    return false
  } finally {
    busy.value = false
    await loadServices()
  }
}

const url = (s: ServiceView, action = '') => `/api/services/${encodeURIComponent(s.id)}${action ? `/${action}` : ''}`

async function review(s: ServiceView): Promise<void> {
  if (reviewing[s.id]) {
    reviewing[s.id] = undefined
    return
  }
  await act(async () => {
    reviewing[s.id] = await api<Changes>(url(s, 'changes'))
  })
}

async function approve(s: ServiceView): Promise<void> {
  const changes = reviewing[s.id]
  if (!changes) return
  if (await act(() => api(url(s, 'approve'), json('POST', { hash: changes.hash })).then(() => {}), `Approved “${s.name}”.`)) reviewing[s.id] = undefined
}

/** Approve what's there, and let Jarvis carry on without asking (development mode). */
async function approveAndDevelop(s: ServiceView): Promise<void> {
  const changes = reviewing[s.id]
  if (!changes) return
  if (await act(() => api(url(s, 'approve'), json('POST', { hash: changes.hash, develop: hoursOf(s) })).then(() => {}), `Approved “${s.name}”: Jarvis can now change and run it without asking, until you lock it.`)) reviewing[s.id] = undefined
}

async function develop(s: ServiceView): Promise<void> {
  if (!confirm(`Let Jarvis change “${s.name}” without asking? Every change it saves is approved automatically, new hosts, secrets and packages included, until you lock it${hoursOf(s) ? ' or the time runs out' : ''}.`)) return
  await act(() => api(url(s, 'develop'), json('POST', { hours: hoursOf(s) })).then(() => {}), `“${s.name}” is in development mode.`)
}

async function lock(s: ServiceView): Promise<void> {
  await act(() => api(url(s, 'lock'), json('POST', {})).then(() => {}), `Locked “${s.name}”: the version approved now keeps running, and changes wait for you again.`)
}

async function reject(s: ServiceView): Promise<void> {
  const changes = reviewing[s.id]
  if (!changes) return
  if (await act(() => api(url(s, 'reject'), json('POST', { hash: changes.hash })).then(() => {}), `Turned down “${s.name}”.`)) reviewing[s.id] = undefined
}

async function runNow(s: ServiceView): Promise<void> {
  await act(async () => {
    const run = await api<{ result: string; ms: number }>(url(s, 'run'), json('POST', {}))
    notice.value = `${s.name}: ${run.result} in ${(run.ms / 1000).toFixed(1)} s.`
    if (logs[s.id] !== undefined) await showLog(s, true)
  }, '')
}

async function toggle(s: ServiceView): Promise<void> {
  await act(() => api(url(s, s.paused ? 'resume' : 'pause'), json('POST', {})).then(() => {}), s.paused ? `Resumed “${s.name}”.` : `Paused “${s.name}”.`)
}

async function remove(s: ServiceView): Promise<void> {
  if (!confirm(`Delete the service “${s.name}”? Its folder (services/${s.id}), approved copy, state and log are removed. (The data history keeps the files.)`)) return
  await act(() => api(url(s), { method: 'DELETE' }).then(() => {}), `Deleted “${s.name}”.`)
}

async function showLog(s: ServiceView, refresh = false): Promise<void> {
  if (logs[s.id] !== undefined && !refresh) {
    logs[s.id] = undefined
    return
  }
  try {
    logs[s.id] = (await api<{ log: string }>(`${url(s, 'log')}?lines=300`)).log || '(empty)'
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function stopAll(): Promise<void> {
  if (!confirm('Pause every service now? Their waiting events are dropped. Resume each one when you want it back.')) return
  await act(async () => {
    const { paused } = await api<{ paused: number }>('/api/services/stop-all', json('POST', {}))
    notice.value = paused ? `Paused ${paused} service${paused === 1 ? '' : 's'}.` : 'Nothing was running.'
  })
}

async function saveSecret(name: string, value: string): Promise<void> {
  if (!value) return
  if (await act(() => api(`/api/secrets/${encodeURIComponent(name)}`, json('PUT', { value })).then(() => {}), `Saved the secret “${name}”.`)) {
    secretInput[name] = ''
    if (name === newSecret.name) Object.assign(newSecret, { name: '', value: '' })
  }
}

async function clearSecret(name: string): Promise<void> {
  if (!confirm(`Forget the secret “${name}”? Services that use it stop until it's typed again.`)) return
  await act(() => api(`/api/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(() => {}), `Forgot “${name}”.`)
}

function when(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = d.getTime() - Date.now()
  const mins = Math.round(Math.abs(diff) / 60_000)
  const rel = mins < 1 ? (diff > 0 ? 'any moment' : 'just now') : mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`
  return diff > 0 ? (mins < 1 ? rel : `in ${rel}`) : mins < 1 ? rel : `${rel} ago`
}

function lineClass(line: string): string {
  return line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line === '…' ? 'gap' : ''
}

onMounted(loadServices)
</script>

<template>
  <div class="vstack gap-4">
    <div class="d-flex align-items-start gap-3 flex-wrap">
      <span class="text-sm fg-3 flex-grow-1 intro">
        Background programs Jarvis writes for itself (checking your email, watching a feed…), each in the workspace's
        <code>services/</code> folder. Nothing runs until you approve it here, and every change waits for you again.
        A service reaches only the hosts and secrets you approved, can't see your files, and what it reports comes back to
        Jarvis as a notification.
      </span>
      <div class="d-flex gap-2 align-items-center">
        <span v-if="servicesState.budget.limit" class="text-sm fg-3" title="LLM turns services started today (SERVICES_DAILY_TURNS)">Turns today: {{ servicesState.budget.turns }} / {{ servicesState.budget.limit }}</span>
        <button type="button" class="btn-outline theme-danger btn-sm" :disabled="busy || !servicesState.list.length" @click="stopAll">Stop all services</button>
      </div>
    </div>

    <div v-if="servicesState.error" class="alert theme-warning m-0" role="alert">{{ servicesState.error }}</div>
    <div v-if="error" class="alert theme-danger m-0" role="alert">{{ error }}</div>
    <div v-if="notice" class="alert theme-success m-0" role="status">{{ notice }}</div>

    <!-- Secrets Jarvis asked for, or services need -->
    <div v-for="s in missingSecrets" :key="`missing-${s.name}`" class="card secret-needed">
      <div class="card-body vstack gap-2">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="fw-semibold">Secret needed: <code>{{ s.name }}</code></span>
          <span v-if="s.usedBy.length" class="text-sm fg-3">for {{ s.usedBy.join(', ') }}</span>
        </div>
        <span v-if="s.description" class="text-sm">{{ s.description }}</span>
        <form class="d-flex gap-2" @submit.prevent="saveSecret(s.name, secretInput[s.name] ?? '')">
          <input v-model="secretInput[s.name]" type="password" class="form-control font-monospace" autocomplete="off" :aria-label="`Value of ${s.name}`" placeholder="Type it here (never shown again)" />
          <button type="submit" class="btn-solid theme-primary" :disabled="busy || !secretInput[s.name]">Save</button>
        </form>
      </div>
    </div>

    <p v-if="!servicesState.list.length && !servicesState.error" class="fg-3 m-0">
      No services yet. Ask Jarvis for one, e.g. “Jarvis, check my email every five minutes and tell me when something important comes in.”
    </p>

    <!-- The services -->
    <div v-for="s in servicesState.list" :key="s.id" class="card">
      <div class="card-body vstack gap-2">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="fw-semibold">{{ s.name }}</span>
          <code class="text-sm fg-3">services/{{ s.id }}</code>
          <span class="badge badge-subtle" :class="STATUS[s.status].theme">{{ STATUS[s.status].label }}</span>
          <span v-if="s.running" class="badge theme-info badge-subtle">running now</span>
          <span v-if="s.developing" class="badge theme-info badge-subtle" :title="`Since ${new Date(s.developing.since).toLocaleString()}`">
            in development{{ s.developing.until ? ` until ${new Date(s.developing.until).toLocaleString()}` : '' }}
          </span>
          <span class="d-flex gap-2 ms-auto flex-wrap">
            <button v-if="s.pending && s.hash" type="button" class="btn-sm" :class="reviewing[s.id] ? 'btn-outline theme-secondary' : 'btn-solid theme-warning'" :disabled="busy" @click="review(s)">
              {{ reviewing[s.id] ? 'Close review' : 'Review & approve' }}
            </button>
            <button v-if="s.every" type="button" class="btn-outline theme-secondary btn-sm" :disabled="busy || s.running || s.status === 'needs-secret'" @click="runNow(s)">Run now</button>
            <button v-if="s.every" type="button" class="btn-outline theme-secondary btn-sm" :disabled="busy" @click="toggle(s)">{{ s.paused ? 'Resume' : 'Pause' }}</button>
            <button v-if="s.developing" type="button" class="btn-solid theme-primary btn-sm" :disabled="busy" title="End development mode: changes wait for you again" @click="lock(s)">Lock it</button>
            <span v-else-if="s.every" class="d-flex gap-1">
              <button type="button" class="btn-outline theme-secondary btn-sm" :disabled="busy" title="Jarvis can change and run it without asking you, until you lock it" @click="develop(s)">Let Jarvis develop</button>
              <select :value="devFor[s.id] ?? '24'" class="form-control form-control-sm dev-for" aria-label="For how long" @change="devFor[s.id] = ($event.target as HTMLSelectElement).value">
                <option v-for="[v, label] in DEV_CHOICES" :key="v" :value="v">{{ label }}</option>
              </select>
            </span>
            <button type="button" class="btn-outline theme-secondary btn-sm" :aria-expanded="logs[s.id] !== undefined" @click="showLog(s)">{{ logs[s.id] !== undefined ? 'Hide log' : 'Log' }}</button>
            <button type="button" class="btn-outline theme-danger btn-sm" :disabled="busy" @click="remove(s)">Delete</button>
          </span>
        </div>
        <span v-if="s.description" class="text-sm">{{ s.description }}</span>
        <span class="text-sm" :class="s.status === 'error' ? 'fg-danger' : 'fg-2'">{{ s.statusText }}</span>
        <span class="text-sm fg-3">
          <template v-if="s.lastRun">Last run {{ when(s.lastRun.at) }}: {{ s.lastRun.result }} ({{ s.lastRun.stats.events }} event{{ s.lastRun.stats.events === 1 ? '' : 's' }}<template v-if="s.lastRun.stats.refused">, {{ s.lastRun.stats.refused }} connection{{ s.lastRun.stats.refused === 1 ? '' : 's' }} refused</template>)</template>
          <template v-else-if="s.every">Not run yet</template>
          <template v-if="s.nextRunAt && s.status === 'active' || s.nextRunAt && s.status === 'changed'"> · next {{ when(s.nextRunAt) }}</template>
          <template v-if="s.approvedBy === 'development' && s.approvedAt"> · this version approved automatically {{ when(s.approvedAt) }}</template>
          <template v-if="s.failures"> · {{ s.failures }} failure{{ s.failures === 1 ? '' : 's' }} in a row</template>
          <template v-if="s.waitingEvents"> · {{ s.waitingEvents }} event{{ s.waitingEvents === 1 ? '' : 's' }} waiting</template>
        </span>
        <ul v-if="s.permissions.length && !reviewing[s.id]" class="text-sm m-0 ps-4 fg-2">
          <li v-for="p in s.permissions" :key="p">{{ p }}</li>
        </ul>

        <!-- Review: what it may do now, and the code -->
        <div v-if="reviewing[s.id]" class="vstack gap-3 review">
          <div v-if="reviewing[s.id]!.error" class="alert theme-danger m-0">service.md has a problem, so this can't be approved: {{ reviewing[s.id]!.error }}</div>
          <div v-if="reviewing[s.id]!.widened.length" class="vstack gap-1">
            <span class="fw-semibold">{{ s.every ? 'New permissions' : 'What it may do' }}</span>
            <ul class="m-0 ps-4">
              <li v-for="p in reviewing[s.id]!.widened" :key="p" class="fw-semibold">{{ p }}</li>
            </ul>
          </div>
          <div v-else-if="!reviewing[s.id]!.error" class="text-sm fg-2">No new permissions: only the code or text changed.</div>
          <details v-if="s.every && reviewing[s.id]!.permissions.length">
            <summary class="text-sm">Everything it may do after this</summary>
            <ul class="text-sm m-0 ps-4 mt-1">
              <li v-for="p in reviewing[s.id]!.permissions" :key="p">{{ p }}</li>
            </ul>
          </details>
          <div v-for="f in reviewing[s.id]!.files" :key="f.file" class="vstack gap-1">
            <span class="text-sm"><code>{{ f.file }}</code> <span class="fg-3">({{ f.status }})</span></span>
            <pre class="diff m-0"><span v-for="(line, i) in f.diff.split('\n')" :key="i" :class="lineClass(line)">{{ line }}
</span></pre>
          </div>
          <div class="d-flex gap-2 flex-wrap align-items-center">
            <button type="button" class="btn-solid theme-success" :disabled="busy || !!reviewing[s.id]!.error" @click="approve(s)">Approve</button>
            <button type="button" class="btn-outline theme-success" :disabled="busy || !!reviewing[s.id]!.error" title="Approve, and let Jarvis change and run it without asking while it gets it working" @click="approveAndDevelop(s)">Approve & let Jarvis develop it</button>
            <select :value="devFor[s.id] ?? '24'" class="form-control form-control-sm dev-for" aria-label="Development mode for how long" @change="devFor[s.id] = ($event.target as HTMLSelectElement).value">
              <option v-for="[v, label] in DEV_CHOICES" :key="v" :value="v">{{ label }}</option>
            </select>
            <button type="button" class="btn-outline theme-secondary" :disabled="busy" @click="reject(s)">Turn down</button>
          </div>
          <span class="text-sm fg-3">While Jarvis develops it, every change it saves is approved by itself (permissions included). Lock it once it works; after that, changes wait for you again.</span>
        </div>

        <pre v-if="logs[s.id] !== undefined" class="log m-0">{{ logs[s.id] }}</pre>
      </div>
    </div>

    <!-- All secrets -->
    <div class="card">
      <div class="card-header"><span class="fw-semibold">Secrets</span></div>
      <div class="card-body vstack gap-2">
        <span class="text-sm fg-3">Passwords and keys for services. A value is never shown again, here or to Jarvis; a service gets one only if you approved it for that secret.</span>
        <div v-for="s in servicesState.secrets.filter((x) => x.set)" :key="s.name" class="d-flex align-items-center gap-2 flex-wrap">
          <code>{{ s.name }}</code>
          <span class="text-sm fg-3">{{ s.description }}<template v-if="s.usedBy.length"> · used by {{ s.usedBy.join(', ') }}</template><template v-if="s.setAt"> · set {{ when(s.setAt) }}</template></span>
          <form class="d-flex gap-2 ms-auto" @submit.prevent="saveSecret(s.name, secretInput[s.name] ?? '')">
            <input v-model="secretInput[s.name]" type="password" class="form-control form-control-sm font-monospace" autocomplete="off" :aria-label="`New value of ${s.name}`" placeholder="New value" />
            <button type="submit" class="btn-outline theme-secondary btn-sm" :disabled="busy || !secretInput[s.name]">Replace</button>
            <button type="button" class="btn-outline theme-danger btn-sm" :disabled="busy" @click="clearSecret(s.name)">Forget</button>
          </form>
        </div>
        <form class="d-flex gap-2 flex-wrap" @submit.prevent="saveSecret(newSecret.name.trim(), newSecret.value)">
          <input v-model="newSecret.name" class="form-control form-control-sm font-monospace name" pattern="[A-Za-z0-9_\-]{1,40}" placeholder="name" aria-label="New secret's name" />
          <input v-model="newSecret.value" type="password" class="form-control form-control-sm font-monospace flex-grow-1" autocomplete="off" placeholder="value" aria-label="New secret's value" />
          <button type="submit" class="btn-outline theme-secondary btn-sm" :disabled="busy || !newSecret.name.trim() || !newSecret.value">Add secret</button>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.intro {
  max-width: 70ch;
}
.secret-needed {
  border-color: var(--warning, #d29922);
}
.diff,
.log {
  font-size: 0.8rem;
  max-height: 28rem;
  overflow: auto;
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  background: rgb(127 127 127 / 0.08);
  white-space: pre;
}
.log {
  white-space: pre-wrap;
}
.diff .add {
  color: #1a7f37;
  background: rgb(46 160 67 / 0.12);
  display: inline-block;
  min-width: 100%;
}
.diff .del {
  color: #cf222e;
  background: rgb(248 81 73 / 0.12);
  display: inline-block;
  min-width: 100%;
}
.diff .gap {
  opacity: 0.5;
}
.name {
  max-width: 12rem;
}
.dev-for {
  width: auto;
}
.review {
  border-top: 1px solid rgb(127 127 127 / 0.2);
  padding-top: 0.75rem;
}
</style>
