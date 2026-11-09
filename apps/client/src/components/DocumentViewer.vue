<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { closeFile, openFile, resolvePath, viewer } from '../viewer'

// A workspace file, read-only: Markdown formatted (headings, lists, tables,
// to-do checkboxes, code) with its linked images loaded from the workspace;
// images, PDFs and other text shown as they are. Links to other Markdown files
// open here too. Re-reads the file when it changes (viewer.version).

const props = defineProps<{ standalone?: boolean }>()

const html = ref('')
const text = ref<string | null>(null)
const error = ref('')
const loading = ref(false)
const body = ref<HTMLElement | null>(null)

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

async function load(): Promise<void> {
  if (!viewer.path || kind.value === 'image' || kind.value === 'pdf') return
  const at = viewer.path
  loading.value = true
  error.value = ''
  try {
    const response = await fetch(url(at), { cache: 'no-store' })
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`)
    const source = await response.text()
    if (viewer.path !== at) return
    if (kind.value === 'markdown') {
      html.value = DOMPurify.sanitize(await marked.parse(source, { gfm: true, breaks: false }))
      text.value = null
      await nextTick()
      fixLinks(at)
    } else {
      text.value = source
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
    if (src && !external(src)) img.src = url(resolvePath(from, src))
    img.loading = 'lazy'
  }
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? ''
    if (!href || href.startsWith('#')) continue
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

function openInTab(): void {
  window.open(`/?view=${encodeURIComponent(path.value)}`, '_blank', 'noopener')
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !props.standalone && viewer.path) closeFile()
}

watch(() => [viewer.path, viewer.version], () => void load(), { immediate: true })
// Back to the tab: it may have changed meanwhile.
const onFocus = () => void load()
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('focus', onFocus)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('focus', onFocus)
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
        <span class="ms-auto d-flex gap-1">
          <button type="button" class="btn-text btn-sm" title="Reload" aria-label="Reload" @click="load">⟳</button>
          <button v-if="!standalone" type="button" class="btn-text btn-sm" title="Open in a new tab" aria-label="Open in a new tab" @click="openInTab">↗</button>
          <a class="btn-text btn-sm" :href="`${url(path)}&download=1`" title="Download" aria-label="Download">⤓</a>
          <button v-if="!standalone" type="button" class="btn-text btn-sm" title="Close (Esc)" aria-label="Close" @click="closeFile">✕</button>
        </span>
      </div>
    </div>
    <div class="card-body viewer-body">
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
  max-width: 52rem;
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
