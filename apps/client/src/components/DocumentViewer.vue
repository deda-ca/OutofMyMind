<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { plugins, readAloud } from '../plugins'
import { closeFile, openFile, resolvePath, viewer } from '../viewer'

// A workspace file: Markdown formatted (headings, lists, tables, to-do
// checkboxes, code) with its linked images loaded from the workspace; images,
// PDFs and other text shown as they are. Links to other Markdown files open
// here too. Re-reads the file when it changes (viewer.version).
//
// Markdown can be edited as its source (CodeMirror), alone or beside the
// preview, which follows what's typed. Save (Ctrl+S) writes exactly that text.
// While there are unsaved edits the file isn't re-read under them; if it
// changed on disk meanwhile, saving says so instead of overwriting.

// Loaded the first time someone edits, not with the app.
const MarkdownEditor = defineAsyncComponent(() => import('./MarkdownEditor.vue'))

const props = defineProps<{ standalone?: boolean }>()

type Mode = 'preview' | 'edit' | 'split'
const MODE_KEY = 'jarvis.viewer.mode'
function savedMode(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY)
    return m === 'edit' || m === 'split' ? m : 'preview'
  } catch {
    return 'preview'
  }
}
const mode = ref<Mode>(savedMode())
watch(mode, (m) => {
  try {
    localStorage.setItem(MODE_KEY, m)
  } catch {
    /* private window: just not remembered */
  }
})

const text = ref<string | null>(null)
/** The file's text as last read or saved: what a save expects to still be on disk. */
const source = ref('')
/** The Markdown being edited (equal to `source` until someone types). */
const draft = ref('')
const html = ref('')
const error = ref('')
const loading = ref(false)
const body = ref<HTMLElement | null>(null)
const saving = ref(false)
const saveError = ref('')
/** The file changed on disk while there were unsaved edits. */
const stale = ref(false)
const conflict = ref(false)

const path = computed(() => viewer.path ?? '')
const kind = computed(() => {
  const p = path.value.toLowerCase()
  if (/\.(md|markdown)$/.test(p)) return 'markdown'
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(p)) return 'image'
  if (p.endsWith('.pdf')) return 'pdf'
  return 'text'
})
const url = (p: string) => `/api/workspace-file?path=${encodeURIComponent(p)}`
const name = computed(() => path.value.split('/').pop() ?? '')
const showEditor = computed(() => kind.value === 'markdown' && !error.value && mode.value !== 'preview')
const showPreview = computed(() => kind.value === 'markdown' && !error.value && mode.value !== 'edit')

watch([draft, source, kind], () => {
  viewer.dirty = kind.value === 'markdown' && draft.value !== source.value
})

const render = (markdown: string) => DOMPurify.sanitize(marked.parse(markdown, { gfm: true, breaks: false, async: false }) as string)

// The preview follows the typing, a moment behind so long files stay smooth.
let renderTimer: ReturnType<typeof setTimeout> | undefined
watch(draft, (value) => {
  clearTimeout(renderTimer)
  renderTimer = setTimeout(() => (html.value = render(value)), 120)
})
// Links and images point at the workspace once the HTML is on the page.
watch([html, body], () => fixLinks(path.value), { flush: 'post' })

async function load(force = false): Promise<void> {
  if (!viewer.path || kind.value === 'image' || kind.value === 'pdf') return
  const at = viewer.path
  if (viewer.dirty && !force) {
    // Don't wipe what's being typed; just note whether the file moved on under it.
    const raw = await fetch(url(at), { cache: 'no-store' }).then((r) => (r.ok ? r.text() : null)).catch(() => null)
    if (viewer.path === at && raw !== null && raw !== source.value) stale.value = true
    return
  }
  loading.value = true
  error.value = ''
  try {
    const response = await fetch(url(at), { cache: 'no-store' })
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`)
    const raw = await response.text()
    if (viewer.path !== at) return
    stale.value = false
    conflict.value = false
    saveError.value = ''
    source.value = raw
    draft.value = raw
    if (kind.value === 'markdown') {
      clearTimeout(renderTimer)
      html.value = render(raw)
      text.value = null
    } else {
      text.value = raw
      html.value = ''
    }
  } catch (err) {
    error.value = `Couldn't open ${at}: ${(err as Error).message}`
    html.value = ''
    text.value = null
  } finally {
    loading.value = false
  }
}

const external = (href: string) => /^(https?:|mailto:|tel:|data:)/i.test(href)

/** Images load from the workspace (relative to this file); links to Markdown open here, the web in a new tab. */
function fixLinks(from: string): void {
  const root = body.value
  if (!root) return
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    if (src && !external(src) && !src.startsWith('/api/')) img.src = url(resolvePath(from, src))
    img.loading = 'lazy'
  }
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? ''
    if (!href || href.startsWith('#') || href.startsWith('/api/')) continue
    if (external(href)) {
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      continue
    }
    const target = resolvePath(from, href.split('#')[0]!)
    if (/\.(md|markdown)$/i.test(target)) {
      a.addEventListener('click', (e) => {
        e.preventDefault()
        openFile(target)
      })
    } else {
      a.href = url(target)
      a.target = '_blank'
      a.rel = 'noopener'
    }
  }
  for (const table of root.querySelectorAll('table')) table.classList.add('table', 'table-sm')
}

async function save(overwrite = false): Promise<void> {
  if (!viewer.path || !viewer.dirty || saving.value) return
  const at = viewer.path
  const markdown = draft.value
  saving.value = true
  saveError.value = ''
  try {
    const response = await fetch(url(at), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overwrite ? { text: markdown } : { text: markdown, expected: source.value }),
    })
    if (response.status === 409) {
      conflict.value = true
      return
    }
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`)
    if (viewer.path !== at) return
    source.value = markdown
    stale.value = false
    conflict.value = false
  } catch (err) {
    saveError.value = `Couldn't save: ${(err as Error).message}`
  } finally {
    saving.value = false
  }
}

/** Drops the edits and shows the file as it is on disk. */
function discard(): void {
  void load(true)
}

function openInTab(): void {
  window.open(`/?view=${encodeURIComponent(path.value)}`, '_blank', 'noopener')
}

function onKey(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && viewer.path && kind.value === 'markdown') {
    event.preventDefault()
    void save()
    return
  }
  // Escape in the editor is the editor's (closing search); elsewhere it closes the viewer.
  if (event.key === 'Escape' && !props.standalone && viewer.path && !(event.target as Element | null)?.closest?.('.cm-editor')) closeFile()
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (viewer.dirty) event.preventDefault()
}

watch(() => [viewer.path, viewer.version], () => void load(), { immediate: true })
// Back to the tab: it may have changed meanwhile.
const onFocus = () => void load()
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('focus', onFocus)
  window.addEventListener('beforeunload', onBeforeUnload)
})
onBeforeUnmount(() => {
  clearTimeout(renderTimer)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('focus', onFocus)
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<template>
  <section class="viewer card" :class="{ standalone }" :aria-label="`Viewing ${name}`">
    <div class="card-header">
      <div class="d-flex align-items-center gap-2 w-100">
        <span aria-hidden="true">{{ kind === 'markdown' ? '📝' : kind === 'image' ? '🖼️' : kind === 'pdf' ? '📕' : '📄' }}</span>
        <span class="fw-semibold text-truncate" :title="`workspace/${path}`">{{ name }}</span>
        <code class="text-sm fg-3 text-truncate d-none sm:d-inline">workspace/{{ path }}</code>
        <span v-if="loading" class="spinner-border spinner-sm" aria-label="Loading"></span>
        <span class="ms-auto d-flex gap-1 align-items-center">
          <template v-if="viewer.dirty">
            <button type="button" class="btn-text btn-sm" title="Discard your changes" :disabled="saving" @click="discard">Discard</button>
            <button type="button" class="btn-solid btn-sm theme-primary" title="Save (Ctrl+S)" :disabled="saving" @click="save()">
              {{ saving ? 'Saving…' : 'Save' }}
            </button>
          </template>
          <span v-if="kind === 'markdown' && !error" class="modes" role="group" aria-label="View">
            <button type="button" class="btn-text btn-sm" :class="{ active: mode === 'preview' }" :aria-pressed="mode === 'preview'" title="Preview" @click="mode = 'preview'">Preview</button>
            <button type="button" class="btn-text btn-sm" :class="{ active: mode === 'edit' }" :aria-pressed="mode === 'edit'" title="Edit the Markdown" @click="mode = 'edit'">Edit</button>
            <button type="button" class="btn-text btn-sm split-button" :class="{ active: mode === 'split' }" :aria-pressed="mode === 'split'" title="Edit beside the preview" @click="mode = 'split'">Split</button>
          </span>
          <button
            v-if="!standalone && (kind === 'markdown' || kind === 'text') && draft && plugins.list.some((p) => p.name === 'reader')"
            type="button"
            class="btn-text btn-sm"
            title="Read it aloud"
            aria-label="Read it aloud"
            @click="readAloud(draft, name)"
          >🔊</button>
          <button v-if="!viewer.dirty" type="button" class="btn-text btn-sm" title="Reload" aria-label="Reload" @click="load()">⟳</button>
          <button v-if="!standalone" type="button" class="btn-text btn-sm" title="Open in a new tab" aria-label="Open in a new tab" @click="openInTab">↗</button>
          <a class="btn-text btn-sm" :href="`${url(path)}&download=1`" title="Download" aria-label="Download">⤓</a>
          <button v-if="!standalone" type="button" class="btn-text btn-sm" title="Close (Esc)" aria-label="Close" @click="closeFile">✕</button>
        </span>
      </div>
    </div>
    <div v-if="conflict || (stale && viewer.dirty) || saveError" class="notices">
      <div v-if="conflict" class="alert theme-warning m-0 d-flex flex-wrap align-items-center gap-2" role="alert">
        <span>This file changed on disk since you started editing (maybe Jarvis edited it).</span>
        <span class="ms-auto d-flex gap-1">
          <button type="button" class="btn-outline btn-sm theme-secondary" @click="discard">Load theirs</button>
          <button type="button" class="btn-solid btn-sm theme-danger" @click="save(true)">Overwrite with mine</button>
        </span>
      </div>
      <div v-else-if="stale && viewer.dirty" class="alert theme-info m-0 text-sm" role="status">
        The file changed on disk while you were editing. Saving will ask before overwriting it.
      </div>
      <div v-if="saveError" class="alert theme-danger m-0" role="alert">{{ saveError }}</div>
    </div>
    <div v-if="showEditor" class="card-body viewer-body panes" :class="mode">
      <MarkdownEditor v-model="draft" class="pane editor-pane" />
      <!-- eslint-disable-next-line vue/no-v-html: sanitized with DOMPurify -->
      <article v-if="showPreview" ref="body" class="pane markdown" v-html="html"></article>
    </div>
    <div v-else class="card-body viewer-body">
      <div v-if="error" class="alert theme-danger m-0" role="alert">{{ error }}</div>
      <img v-else-if="kind === 'image'" :src="url(path)" :alt="name" class="whole-image" />
      <iframe v-else-if="kind === 'pdf'" :src="url(path)" :title="name" class="pdf"></iframe>
      <pre v-else-if="text !== null" class="plain">{{ text }}</pre>
      <!-- eslint-disable-next-line vue/no-v-html: sanitized with DOMPurify -->
      <article v-else ref="body" class="markdown" v-html="html"></article>
    </div>
  </section>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.viewer > .card-header {
  flex: none;
}
.viewer-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.notices {
  flex: none;
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem 1rem 0;
}
.modes {
  display: inline-flex;
  border: 1px solid var(--bs-border-color, rgba(127, 127, 127, 0.35));
  border-radius: 0.375rem;
  overflow: hidden;
}
.modes > button {
  border-radius: 0;
}
.modes > button.active {
  background: var(--bs-tertiary-bg, rgba(127, 127, 127, 0.15));
  font-weight: 600;
}
/* Editing: the editor (and the preview beside it) each scroll on their own. */
.panes {
  display: grid;
  overflow: hidden;
  padding: 0;
}
.panes.split {
  grid-template-columns: 1fr 1fr;
}
.pane {
  min-height: 0;
  min-width: 0;
  overflow: auto;
  padding: 0.75rem 1rem;
}
.panes.split > .pane + .pane {
  border-inline-start: 1px solid var(--bs-border-color, rgba(127, 127, 127, 0.25));
}
.editor-pane {
  padding: 0.25rem 0.5rem;
  overflow: hidden;
}
@media (max-width: 767.98px) {
  /* Too narrow for side by side: editor above, preview below. */
  .panes.split {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .panes.split > .pane + .pane {
    border-inline-start: 0;
    border-top: 1px solid var(--bs-border-color, rgba(127, 127, 127, 0.25));
  }
}
.standalone {
  height: 100dvh;
  border-radius: 0;
}
.whole-image {
  display: block;
  max-width: 100%;
  margin-inline: auto;
}
.pdf {
  width: 100%;
  height: 100%;
  min-height: 70vh;
  border: 0;
}
.plain {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.markdown {
  line-height: 1.6;
}
.markdown :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 0.375rem;
}
.markdown :deep(pre) {
  padding: 0.75rem 1rem;
  border-radius: 0.375rem;
  background: var(--bs-tertiary-bg, rgba(127, 127, 127, 0.1));
  overflow-x: auto;
}
.markdown :deep(blockquote) {
  margin-inline: 0;
  padding-inline-start: 1rem;
  border-inline-start: 3px solid var(--bs-border-color, rgba(127, 127, 127, 0.4));
  color: var(--bs-secondary-color, inherit);
}
.markdown :deep(li:has(> input[type='checkbox'])) {
  list-style: none;
  margin-inline-start: -1.25rem;
}
.markdown :deep(input[type='checkbox']) {
  margin-inline-end: 0.5rem;
}
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3) {
  margin-top: 1.25em;
}
.markdown :deep(> :first-child) {
  margin-top: 0;
}
</style>
