<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { onMounted, reactive, ref } from 'vue'

// The skills (server: apps/server/src/skills/routes.ts): how Jarvis handles the
// to-do list, logs and other kinds of things. View, create, edit, delete,
// export (one .md, or all as a bundle) and import (.md files or a bundle).

interface SkillInfo {
  id: string
  name: string
  description: string
  files: string[]
  triggers: string[]
  /** As written: comments and Jarvis's dated rules kept. */
  rules: string
  template: string
  hasTemplate: boolean
}

const skills = ref<SkillInfo[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const viewing = reactive<Record<string, boolean>>({})
const importer = ref<HTMLInputElement | null>(null)
const onConflict = ref<'rename' | 'replace' | 'skip'>('rename')

/** The editor: null when closed; `id` null when creating. */
const editing = ref<{ id: string | null } | null>(null)
const form = reactive({ name: '', id: '', idTouched: false, description: '', files: '', triggers: '', rules: '', template: '' })

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function act(what: () => Promise<void>): Promise<boolean> {
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    await what()
    return true
  } catch (err) {
    error.value = (err as Error).message
    return false
  } finally {
    busy.value = false
  }
}

const load = () => act(async () => void (skills.value = (await api<{ skills: SkillInfo[] }>('/api/skills')).skills))

const slug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
const list = (text: string) => text.split(',').map((t) => t.trim()).filter(Boolean)

function startCreate(): void {
  Object.assign(form, { name: '', id: '', idTouched: false, description: '', files: '', triggers: '', rules: '## Layout\n- \n\n## Adding\n- \n\n## Ask if missing\n- ', template: '' })
  editing.value = { id: null }
}

function startEdit(s: SkillInfo): void {
  Object.assign(form, { name: s.name, id: s.id, idTouched: true, description: s.description, files: s.files.join(', '), triggers: s.triggers.join(', '), rules: s.rules, template: s.template })
  editing.value = { id: s.id }
}

function onName(): void {
  if (editing.value?.id === null && !form.idTouched) form.id = slug(form.name)
}

async function save(): Promise<void> {
  const body = { name: form.name, description: form.description, files: list(form.files), triggers: list(form.triggers), rules: form.rules, template: form.template }
  const id = editing.value?.id
  const ok = await act(async () => {
    skills.value = (id ? await api<{ skills: SkillInfo[] }>(`/api/skills/${encodeURIComponent(id)}`, json('PUT', body)) : await api<{ skills: SkillInfo[] }>('/api/skills', json('POST', { ...body, id: form.id || undefined }))).skills
  })
  if (ok) {
    notice.value = id ? `Saved “${form.name}”.` : `Created “${form.name}”.`
    editing.value = null
  }
}

async function remove(s: SkillInfo): Promise<void> {
  if (!confirm(`Delete the skill “${s.name}”? Its file (skills/${s.id}.md) is removed; the files it governs stay. Export it first if you may want it back.`)) return
  if (await act(async () => void (skills.value = (await api<{ skills: SkillInfo[] }>(`/api/skills/${encodeURIComponent(s.id)}`, { method: 'DELETE' })).skills))) notice.value = `Deleted “${s.name}”.`
}

async function importFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length) return
  await act(async () => {
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })))
    const r = await api<{ results: { file: string; id?: string; result: string; error?: string }[]; skills: SkillInfo[] }>('/api/skills/import', json('POST', { files: payload, onConflict: onConflict.value }))
    skills.value = r.skills
    const count = (kind: string) => r.results.filter((x) => x.result === kind).length
    const parts = [
      count('created') && `${count('created')} added`,
      count('replaced') && `${count('replaced')} replaced`,
      count('skipped') && `${count('skipped')} skipped (already there)`,
    ].filter(Boolean)
    const failed = r.results.filter((x) => x.result === 'error')
    notice.value = parts.length ? `Imported: ${parts.join(', ')}.` : ''
    if (failed.length) error.value = failed.map((x) => `${x.file}${x.id ? ` (${x.id})` : ''}: ${x.error}`).join(' · ')
  })
}

const rendered = (s: SkillInfo) => DOMPurify.sanitize(marked.parse(s.rules.replace(/<!--[\s\S]*?-->/g, ''), { async: false }) as string)

onMounted(load)
</script>

<template>
  <div class="vstack gap-4">
    <div class="d-flex align-items-start gap-3 flex-wrap">
      <span class="text-sm fg-3 flex-grow-1 intro">
        A skill tells Jarvis how to handle a kind of thing (the to-do list, a log…): which files it covers, which words
        call for it, its rules, and a template the file starts as. Jarvis follows them when they apply, and can add rules
        when you ask (“from now on…”). They're files in the workspace's <code>skills/</code> folder.
      </span>
      <div class="d-flex gap-2 flex-wrap align-items-center">
        <button type="button" class="btn-solid theme-primary btn-sm" :disabled="busy || editing !== null" @click="startCreate">+ New skill</button>
        <input ref="importer" type="file" class="d-none" accept=".md,.markdown,.txt,.json" multiple @change="importFiles" />
        <button type="button" class="btn-outline theme-secondary btn-sm" :disabled="busy" title="Import .md skill files, or a bundle from “Export all”" @click="importer?.click()">Import…</button>
        <select v-model="onConflict" class="form-control form-control-sm conflict" aria-label="When an imported skill already exists" title="When an imported skill already exists">
          <option value="rename">If it exists: keep both</option>
          <option value="replace">If it exists: replace</option>
          <option value="skip">If it exists: skip</option>
        </select>
        <a class="btn-outline theme-secondary btn-sm" href="/api/skills-export" download title="All skills in one file, to import elsewhere">Export all</a>
      </div>
    </div>

    <div v-if="error" class="alert theme-danger m-0" role="alert">{{ error }}</div>
    <div v-if="notice" class="alert theme-success m-0" role="status">{{ notice }}</div>

    <!-- The editor -->
    <form v-if="editing" class="card" @submit.prevent="save">
      <div class="card-header">
        <div class="d-flex align-items-center w-100"><span class="fw-semibold">{{ editing.id ? `Edit ${form.name || editing.id}` : 'New skill' }}</span></div>
      </div>
      <div class="card-body vstack gap-3">
        <div class="row g-3">
          <div class="col-12 md:col-6 vstack gap-1">
            <label for="skill-name" class="form-label m-0 fw-semibold">Name</label>
            <input id="skill-name" v-model="form.name" class="form-control" maxlength="60" required placeholder="e.g. Sleep log" @input="onName" />
          </div>
          <div class="col-12 md:col-6 vstack gap-1">
            <label for="skill-id" class="form-label m-0 fw-semibold">File name</label>
            <div class="d-flex align-items-center gap-2">
              <span class="fg-3 text-sm text-nowrap">skills/</span>
              <input id="skill-id" v-model="form.id" class="form-control font-monospace" :disabled="editing.id !== null" pattern="[a-z0-9][a-z0-9_\-]{0,63}" maxlength="64" @input="form.idTouched = true" />
              <span class="fg-3 text-sm">.md</span>
            </div>
          </div>
          <div class="col-12 vstack gap-1">
            <label for="skill-description" class="form-label m-0 fw-semibold">Description</label>
            <input id="skill-description" v-model="form.description" class="form-control" maxlength="300" placeholder="One line: what it covers (shown to Jarvis in every request)" />
          </div>
          <div class="col-12 md:col-6 vstack gap-1">
            <label for="skill-files" class="form-label m-0 fw-semibold">Files it covers</label>
            <input id="skill-files" v-model="form.files" class="form-control font-monospace" placeholder="logs/sleep.md, logs/2026/*.md" />
            <span class="form-text m-0">Workspace paths, comma-separated. <code>*</code> within a folder, <code>**</code> across folders.</span>
          </div>
          <div class="col-12 md:col-6 vstack gap-1">
            <label for="skill-triggers" class="form-label m-0 fw-semibold">Trigger words</label>
            <input id="skill-triggers" v-model="form.triggers" class="form-control" placeholder="slept, sleep, woke up, went to bed" />
            <span class="form-text m-0">Words or phrases in a request that call for this skill.</span>
          </div>
        </div>
        <div class="vstack gap-1">
          <label for="skill-rules" class="form-label m-0 fw-semibold">Rules</label>
          <textarea id="skill-rules" v-model="form.rules" class="form-control font-monospace code" rows="14" maxlength="20000"></textarea>
          <span class="form-text m-0">Markdown sections, e.g. Layout, Adding, Completing, Ask if missing. Short, concrete rules work best. <code>&lt;!-- comments --&gt;</code> are notes for you, never sent.</span>
        </div>
        <div class="vstack gap-1">
          <label for="skill-template" class="form-label m-0 fw-semibold">Template <span class="fw-normal fg-3">(optional)</span></label>
          <textarea id="skill-template" v-model="form.template" class="form-control font-monospace code" rows="6" maxlength="20000" placeholder="# Sleep log&#10;&#10;| Date | Bedtime | Wake time | Quality | Notes |&#10;|---|---|---|---|---|"></textarea>
          <span class="form-text m-0">What the file starts as: Jarvis creates it from this the first time it's needed, so the layout is always right.</span>
        </div>
        <div class="d-flex gap-2">
          <button type="submit" class="btn-solid theme-primary" :disabled="busy || !form.name.trim()">{{ editing.id ? 'Save' : 'Create' }}</button>
          <button type="button" class="btn-outline theme-secondary" :disabled="busy" @click="editing = null">Cancel</button>
        </div>
      </div>
    </form>

    <p v-if="!skills.length && !editing" class="fg-3 m-0">No skills yet. Create one, or import some.</p>

    <!-- The skills -->
    <div v-for="s in skills" :key="s.id" class="card">
      <div class="card-body vstack gap-2">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="fw-semibold">{{ s.name }}</span>
          <code class="text-sm fg-3">skills/{{ s.id }}.md</code>
          <span v-if="s.hasTemplate" class="badge theme-secondary badge-subtle" title="Has a template: its file is created from it">template</span>
          <span class="d-flex gap-2 ms-auto">
            <button type="button" class="btn-outline theme-secondary btn-sm" :aria-expanded="!!viewing[s.id]" @click="viewing[s.id] = !viewing[s.id]">{{ viewing[s.id] ? 'Hide' : 'View' }}</button>
            <button type="button" class="btn-outline theme-secondary btn-sm" :disabled="busy || editing !== null" @click="startEdit(s)">Edit</button>
            <a class="btn-outline theme-secondary btn-sm" :href="`/api/skills/${encodeURIComponent(s.id)}/export`" download title="Download this skill's .md file">Export</a>
            <button type="button" class="btn-outline theme-danger btn-sm" :disabled="busy" @click="remove(s)">Delete</button>
          </span>
        </div>
        <span v-if="s.description" class="text-sm">{{ s.description }}</span>
        <span class="text-sm fg-3 d-flex gap-2 flex-wrap align-items-center">
          <template v-if="s.files.length">Files: <code v-for="f in s.files" :key="f">{{ f }}</code></template>
          <template v-if="s.triggers.length"><span>· Triggers:</span> <span v-for="t in s.triggers" :key="t" class="badge theme-secondary badge-subtle">{{ t }}</span></template>
        </span>
        <div v-if="viewing[s.id]" class="vstack gap-3 view">
          <!-- eslint-disable-next-line vue/no-v-html: sanitized with DOMPurify -->
          <article class="rules" v-html="rendered(s)"></article>
          <div v-if="s.template" class="vstack gap-1">
            <span class="text-sm fw-semibold">Template</span>
            <pre class="dump m-0">{{ s.template }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.intro {
  min-width: 16rem;
  flex-basis: 24rem;
}
.conflict {
  width: auto;
}
.code {
  font-size: 0.85rem;
}
.view {
  border-top: 1px solid var(--bs-border-color, rgba(127, 127, 127, 0.3));
  padding-top: 0.75rem;
}
.rules :deep(h2) {
  font-size: 1rem;
  font-weight: 600;
  margin: 0.75rem 0 0.25rem;
}
.rules :deep(> :first-child) {
  margin-top: 0;
}
.rules :deep(ul) {
  margin-bottom: 0.25rem;
}
.dump {
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  background: var(--bs-tertiary-bg, rgba(127, 127, 127, 0.1));
  white-space: pre-wrap;
  font-size: 0.85rem;
}
</style>
