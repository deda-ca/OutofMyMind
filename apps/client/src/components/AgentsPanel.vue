<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { applyAgents, sessions, type AgentInfo, type AgentListing } from '../sessions'

// Create, edit, delete agents and choose the default one (server:
// apps/server/src/agents/routes.ts). Each agent is a file in
// WORKSPACE_DIR/agents: instructions, which tools it may use, and optionally
// its own temperature and voice.

interface CatalogTool {
  fn: string
  name: string
  plugin: string
  description?: string
  crud: string[]
}

const error = ref('')
const notice = ref('')
const busy = ref(false)
const catalog = ref<CatalogTool[]>([])
/** The text-to-speech voices audio.cpp has, and the one Jarvis speaks in by default (TTS_VOICE). */
const voices = ref<string[]>([])
const defaultVoice = ref('')
/** The LLM connections and their models (config.jsonc llm.connections), for the Model picker. */
interface LlmConnection { id: string; label: string; kind: string; model: string; models: string[]; error?: string }
const llm = ref<{ default: string; connections: LlmConnection[] }>({ default: '', connections: [] })

/** The editor: null when closed; `id` null when creating. */
const editing = ref<{ id: string | null } | null>(null)
const form = reactive({
  name: '',
  id: '',
  idTouched: false,
  description: '',
  /** v-model on a number input gives a number (or '' when empty). */
  temperature: '' as string | number,
  /** '' = the default voice. */
  voice: '',
  /** '' = none (shown as 🤖). */
  icon: '',
  /** "connection/model"; '' = the default. */
  model: '',
  toolsMode: 'all' as 'all' | 'none' | 'some',
  picked: new Set<string>(),
  patterns: '',
  body: '',
})

const LETTERS: Record<string, { letter: string; theme: string }> = {
  create: { letter: 'C', theme: 'theme-success' },
  read: { letter: 'R', theme: 'theme-info' },
  update: { letter: 'U', theme: 'theme-warning' },
  delete: { letter: 'D', theme: 'theme-danger' },
}

const plugins = computed(() => {
  const groups = new Map<string, CatalogTool[]>()
  for (const t of catalog.value) groups.set(t.plugin, [...(groups.get(t.plugin) ?? []), t])
  return [...groups.entries()]
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
    return true
  } catch (err) {
    error.value = (err as Error).message
    return false
  } finally {
    busy.value = false
  }
}

async function load(): Promise<void> {
  await act(async () => {
    applyAgents(await api<AgentListing>('/api/agents'))
    const { plugins: list } = await api<{ plugins: { name: string; tools: { name: string; description?: string; crud: string[] }[] }[] }>('/api/tools')
    const tts = await api<{ voices: string[]; jarvis: string }>('/api/tts/voices').catch(() => ({ voices: [], jarvis: '' }))
    voices.value = tts.voices
    defaultVoice.value = tts.jarvis
    llm.value = await api<{ default: string; connections: LlmConnection[] }>('/api/llm').catch(() => ({ default: '', connections: [] }))
    catalog.value = list.flatMap((p) => p.tools.map((t) => ({ fn: `${p.name}__${t.name}`, name: t.name, plugin: p.name, description: t.description, crud: t.crud })))
  })
}

function slug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

function startCreate(): void {
  Object.assign(form, { name: '', id: '', idTouched: false, description: '', temperature: '', voice: '', icon: '', model: '', toolsMode: 'all', picked: new Set(), patterns: '', body: '' })
  editing.value = { id: null }
}

function startEdit(agent: AgentInfo): void {
  const known = new Set(catalog.value.map((t) => t.fn))
  const tools = agent.tools ?? []
  Object.assign(form, {
    name: agent.name,
    id: agent.id,
    idTouched: true,
    description: agent.description,
    temperature: agent.temperature === undefined ? '' : String(agent.temperature),
    voice: agent.voice ?? '',
    icon: agent.icon ?? '',
    model: agent.model ?? '',
    toolsMode: agent.tools === null ? 'all' : agent.tools.length === 0 ? 'none' : 'some',
    // Exact tool names become ticks; wildcards and tools of plugins that aren't running stay as patterns.
    picked: new Set(tools.filter((t) => known.has(t))),
    patterns: tools.filter((t) => !known.has(t)).join(', '),
    body: agent.body,
  })
  editing.value = { id: agent.id }
}

function onName(): void {
  if (editing.value?.id === null && !form.idTouched) form.id = slug(form.name)
}

function toggleTool(fn: string, on: boolean): void {
  const next = new Set(form.picked)
  if (on) next.add(fn)
  else next.delete(fn)
  form.picked = next
}

function pickWhere(test: (t: CatalogTool) => boolean): void {
  form.picked = new Set(catalog.value.filter(test).map((t) => t.fn))
}

const extraPatterns = computed(() =>
  form.patterns
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean),
)

/** What the chosen tools add up to, for the line under the picker. */
const allowedCount = computed(() => {
  if (form.toolsMode === 'all') return catalog.value.length
  if (form.toolsMode === 'none') return 0
  const patterns = extraPatterns.value.map((p) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`))
  return catalog.value.filter((t) => form.picked.has(t.fn) || patterns.some((r) => r.test(t.fn))).length
})

async function save(): Promise<void> {
  const tools = form.toolsMode === 'all' ? null : form.toolsMode === 'none' ? [] : [...form.picked, ...extraPatterns.value]
  if (form.toolsMode === 'some' && tools!.length === 0) {
    error.value = 'Pick at least one tool, or choose “No tools”.'
    return
  }
  const temperature = String(form.temperature).trim() === '' ? null : Number(form.temperature)
  const body = { name: form.name, description: form.description, tools, temperature, voice: form.voice, icon: form.icon.trim(), model: form.model, body: form.body }
  const id = editing.value?.id
  const ok = await act(async () => {
    applyAgents(id ? await api<AgentListing>(`/api/agents/${encodeURIComponent(id)}`, json('PUT', body)) : await api<AgentListing>('/api/agents', json('POST', { ...body, id: form.id || undefined })))
  }, id ? `Saved “${form.name}”.` : `Created “${form.name}”.`)
  if (ok) editing.value = null
}

async function makeDefault(agent: AgentInfo): Promise<void> {
  await act(async () => applyAgents(await api<AgentListing>('/api/default-agent', json('PUT', { id: agent.id }))), `${agent.name} is now the default agent.`)
}

async function remove(agent: AgentInfo): Promise<void> {
  if (!confirm(`Delete the agent “${agent.name}”? Its file (agents/${agent.id}.md) is removed. Sessions that used it switch to the default agent.`)) return
  await act(async () => applyAgents(await api<AgentListing>(`/api/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE' })), `Deleted “${agent.name}”.`)
}

/** The agent's model, if no connection offers it any more (so it's shown, and kept unless changed). */
const missingModel = computed(() => (form.model && !llm.value.connections.some((c) => c.models.some((m) => `${c.id}/${m}` === form.model)) ? form.model : ''))

/** Quick picks for an agent's icon. */
const ICONS = ['🤖', '🧠', '✉️', '📅', '💼', '🏠', '🍳', '🎓', '🧾', '💪', '🎵', '🛠️', '🌿', '❤️']

/** The voice options: audio.cpp's, plus the agent's own if audio.cpp doesn't have it (so it isn't lost on save). */
const voiceOptions = computed(() => (form.voice && !voices.value.includes(form.voice) ? [...voices.value, form.voice] : voices.value))

let sample: HTMLAudioElement | undefined
const sampling = ref(false)
/** Hear the chosen voice. */
async function hearVoice(): Promise<void> {
  sample?.pause()
  sampling.value = true
  try {
    const voice = form.voice || defaultVoice.value
    const response = await fetch('/api/tts', json('POST', { text: `Hello, I'm ${form.name.trim() || 'your assistant'}. This is how I sound.`, voice }))
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`)
    const url = URL.createObjectURL(await response.blob())
    sample = new Audio(url)
    sample.onended = () => URL.revokeObjectURL(url)
    await sample.play()
  } catch (err) {
    error.value = `Couldn't play the voice: ${(err as Error).message}`
  } finally {
    sampling.value = false
  }
}

function toolsSummary(agent: AgentInfo): string {
  if (agent.tools === null) return 'All tools'
  if (agent.tools.length === 0) return 'No tools'
  return `${agent.tools.length} tool${agent.tools.length === 1 ? '' : 's'}: ${agent.tools.join(', ')}`
}

onMounted(load)
</script>

<template>
  <div class="vstack gap-4">
    <div class="d-flex align-items-center gap-3 flex-wrap">
      <span class="text-sm fg-3">
        An agent is who Jarvis is in a session: its instructions (added to SYSTEM.md in every request), which tools it
        may use, and optionally its own model, temperature, voice and icon. Sessions without their own agent use the default one.
        Agents are files in the workspace's <code>agents/</code> folder.
      </span>
      <button type="button" class="btn-solid theme-primary btn-sm ms-auto" :disabled="busy || editing !== null" @click="startCreate">+ New agent</button>
    </div>

    <div v-if="error" class="alert theme-danger m-0" role="alert">{{ error }}</div>
    <div v-if="notice" class="alert theme-success m-0" role="status">{{ notice }}</div>

    <!-- The editor -->
    <form v-if="editing" class="card" @submit.prevent="save">
      <div class="card-header">
        <div class="d-flex align-items-center gap-2 w-100">
          <span class="fw-semibold">{{ editing.id ? `Edit ${form.name || editing.id}` : 'New agent' }}</span>
        </div>
      </div>
      <div class="card-body vstack gap-4">
        <div class="row g-3">
          <div class="col-12 md:col-6 vstack gap-1">
            <label for="agent-name" class="form-label m-0 fw-semibold">Name</label>
            <input id="agent-name" v-model="form.name" class="form-control" maxlength="60" required placeholder="e.g. Email" @input="onName" />
          </div>
          <div class="col-12 md:col-6 vstack gap-1">
            <label for="agent-id" class="form-label m-0 fw-semibold">File name</label>
            <div class="d-flex align-items-center gap-2">
              <span class="fg-3 text-sm text-nowrap">agents/</span>
              <input
                id="agent-id"
                v-model="form.id"
                class="form-control font-monospace"
                :disabled="editing.id !== null"
                pattern="[A-Za-z0-9_\-]{1,64}"
                maxlength="64"
                @input="form.idTouched = true"
              />
              <span class="fg-3 text-sm">.md</span>
            </div>
            <span v-if="editing.id !== null" class="form-text m-0">Stays the same when the agent is renamed.</span>
          </div>
          <div class="col-12 vstack gap-1">
            <label for="agent-description" class="form-label m-0 fw-semibold">Description</label>
            <input id="agent-description" v-model="form.description" class="form-control" maxlength="200" placeholder="What it's for, shown in the session picker" />
          </div>
          <div class="col-12 vstack gap-1">
            <label for="agent-model" class="form-label m-0 fw-semibold">Model</label>
            <select id="agent-model" v-model="form.model" class="form-select" aria-describedby="agent-model-help">
              <option value="">Default{{ llm.default ? ` (${llm.default})` : '' }}</option>
              <optgroup v-for="c in llm.connections" :key="c.id" :label="`${c.label}${c.error ? ' (couldn\'t list its models)' : ''}`">
                <option v-for="m in c.models" :key="m" :value="`${c.id}/${m}`">{{ m }}</option>
              </optgroup>
              <option v-if="missingModel" :value="missingModel">{{ missingModel }} (not in config.jsonc)</option>
            </select>
            <span id="agent-model-help" class="form-text m-0">Which LLM it thinks with: the connections are <code>llm.connections</code> in config.jsonc.</span>
          </div>
          <div class="col-12 md:col-6 vstack gap-1">
            <label for="agent-temperature" class="form-label m-0 fw-semibold">Temperature</label>
            <input id="agent-temperature" v-model="form.temperature" type="number" min="0" max="2" step="0.1" class="form-control" placeholder="Default" />
            <span class="form-text m-0">Lower is steadier and more literal, higher more varied. Leave empty for the default. Claude doesn't take one.</span>
          </div>
          <div class="col-12 md:col-6 vstack gap-1">
            <label for="agent-voice" class="form-label m-0 fw-semibold">Voice</label>
            <div class="d-flex gap-2">
              <select id="agent-voice" v-model="form.voice" class="form-select">
                <option value="">Default{{ defaultVoice ? ` (${defaultVoice})` : '' }}</option>
                <option v-for="v in voiceOptions" :key="v" :value="v">{{ v }}{{ voices.includes(v) ? '' : ' (not on audio.cpp)' }}</option>
              </select>
              <button type="button" class="btn-outline theme-secondary" :disabled="sampling" title="Hear this voice" @click="hearVoice">{{ sampling ? '…' : '▶\uFE0E' }}</button>
            </div>
            <span class="form-text m-0">What it speaks in. Voices are the ones audio.cpp has; leave on Default for TTS_VOICE.</span>
          </div>
          <div class="col-12 vstack gap-1">
            <label for="agent-icon" class="form-label m-0 fw-semibold">Icon</label>
            <div class="d-flex gap-2 align-items-center flex-wrap">
              <input id="agent-icon" v-model="form.icon" class="form-control icon-input" maxlength="8" placeholder="🤖" aria-describedby="agent-icon-help" />
              <button
                v-for="i in ICONS"
                :key="i"
                type="button"
                class="btn-text icon-pick"
                :class="{ picked: form.icon === i }"
                :aria-label="`Use ${i}`"
                @click="form.icon = i"
              >{{ i }}</button>
            </div>
            <span id="agent-icon-help" class="form-text m-0">Shown with its name in the sessions list and on its replies. An emoji, or type one of your own.</span>
          </div>
        </div>

        <fieldset class="vstack gap-2">
          <legend class="form-label fw-semibold m-0 fs-6">Tools</legend>
          <div class="d-flex gap-4 flex-wrap">
            <label class="d-flex align-items-center gap-2 m-0"><input v-model="form.toolsMode" type="radio" value="all" /> All tools</label>
            <label class="d-flex align-items-center gap-2 m-0"><input v-model="form.toolsMode" type="radio" value="none" /> No tools</label>
            <label class="d-flex align-items-center gap-2 m-0"><input v-model="form.toolsMode" type="radio" value="some" /> Only these</label>
          </div>
          <template v-if="form.toolsMode === 'some'">
            <div class="d-flex gap-2 flex-wrap">
              <button type="button" class="btn-outline theme-secondary btn-sm" @click="pickWhere((t) => t.crud.length === 1 && t.crud[0] === 'read')">Read-only tools</button>
              <button type="button" class="btn-outline theme-secondary btn-sm" @click="pickWhere(() => true)">All</button>
              <button type="button" class="btn-outline theme-secondary btn-sm" @click="form.picked = new Set()">None</button>
            </div>
            <div class="tool-picker vstack gap-3">
              <div v-for="[plugin, tools] in plugins" :key="plugin" class="vstack gap-1">
                <span class="fw-semibold text-sm">{{ plugin }}</span>
                <label v-for="t in tools" :key="t.fn" class="d-flex align-items-center gap-2 m-0 text-sm" :title="t.description">
                  <input type="checkbox" :checked="form.picked.has(t.fn)" @change="toggleTool(t.fn, ($event.target as HTMLInputElement).checked)" />
                  <code>{{ t.name }}</code>
                  <span class="d-flex gap-1 ms-auto">
                    <span v-for="k in t.crud" :key="k" class="badge crud" :class="LETTERS[k]?.theme">{{ LETTERS[k]?.letter ?? k }}</span>
                  </span>
                </label>
              </div>
              <p v-if="!plugins.length" class="text-sm fg-3 m-0">No plugins are running, so there's nothing to pick; use patterns below.</p>
            </div>
            <div class="vstack gap-1">
              <label for="agent-patterns" class="form-label m-0 text-sm">Patterns <span class="fg-3">(optional, for tools of plugins added later)</span></label>
              <input id="agent-patterns" v-model="form.patterns" class="form-control form-control-sm font-monospace" placeholder="e.g. files__read_*, email__*" />
            </div>
          </template>
          <span class="form-text m-0">
            {{ allowedCount }} of {{ catalog.length }} current tools allowed. The Tools tab's switches still apply on top.
          </span>
        </fieldset>

        <div class="vstack gap-1">
          <label for="agent-body" class="form-label m-0 fw-semibold">Instructions</label>
          <textarea id="agent-body" v-model="form.body" class="form-control font-monospace instructions" rows="12" maxlength="20000"
            placeholder="What this agent does and how. Short and concrete works best; a few example replies help most."></textarea>
          <span class="form-text m-0">Added after SYSTEM.md. <code v-pre>{{owner}}</code> becomes your name; <code>&lt;!-- comments --&gt;</code> are notes for you and never sent.</span>
        </div>

        <div class="d-flex gap-2">
          <button type="submit" class="btn-solid theme-primary" :disabled="busy || !form.name.trim()">{{ editing.id ? 'Save' : 'Create' }}</button>
          <button type="button" class="btn-outline theme-secondary" :disabled="busy" @click="editing = null">Cancel</button>
        </div>
      </div>
    </form>

    <!-- The agents -->
    <div v-for="agent in sessions.agents" :key="agent.id" class="card">
      <div class="card-body vstack gap-2">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="fw-semibold"><span class="me-1" aria-hidden="true">{{ agent.icon || '🤖' }}</span>{{ agent.name }}</span>
          <span v-if="agent.isDefault" class="badge theme-primary">Default</span>
          <code class="text-sm fg-3">agents/{{ agent.id }}.md</code>
          <span class="d-flex gap-2 ms-auto">
            <button v-if="!agent.isDefault" type="button" class="btn-outline theme-secondary btn-sm" :disabled="busy" @click="makeDefault(agent)">Make default</button>
            <button type="button" class="btn-outline theme-secondary btn-sm" :disabled="busy || editing !== null" @click="startEdit(agent)">Edit</button>
            <button v-if="!agent.builtIn" type="button" class="btn-outline theme-danger btn-sm" :disabled="busy" @click="remove(agent)">Delete</button>
          </span>
        </div>
        <span v-if="agent.description" class="text-sm">{{ agent.description }}</span>
        <span class="text-sm fg-3">
          {{ toolsSummary(agent) }}
          <template v-if="agent.temperature !== undefined"> · temperature {{ agent.temperature }}</template>
          <template v-if="agent.model"> · {{ agent.model }}</template>
          <template v-if="agent.voice"> · voice {{ agent.voice }}</template>
          <template v-if="agent.builtIn"> · the fallback agent: can be edited, not deleted</template>
        </span>
        <pre v-if="agent.body" class="instructions-preview m-0">{{ agent.body }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-picker {
  max-height: 22rem;
  overflow-y: auto;
  padding: 0.75rem;
  border: 1px solid var(--bs-border-color, rgba(127, 127, 127, 0.3));
  border-radius: var(--bs-border-radius, 0.375rem);
}

.crud {
  font-family: var(--bs-font-monospace, monospace);
  min-width: 1.4rem;
  justify-content: center;
}

.instructions {
  font-size: 0.875rem;
}

.instructions-preview {
  max-height: 8rem;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 0.8rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  background: var(--bs-tertiary-bg, rgba(127, 127, 127, 0.1));
}
.icon-input {
  width: 5rem;
  text-align: center;
  font-size: 1.2rem;
}
.icon-pick {
  font-size: 1.2rem;
  padding: 0.1rem 0.3rem;
  border-radius: 0.375rem;
}
.icon-pick.picked {
  outline: 2px solid var(--bs-primary, #0d6efd);
}
</style>
