<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { closeReader, loadVoices, pause, play, reader, remember, resume, seek, setRate, setSegments, setVoice, step, stop, type Segment } from '../reader'

// Read aloud, beside the conversation: paste text (or open a document here),
// then play it in a chosen voice. The sentence being read is highlighted, and
// the word in it. Click a word, or select some text, to read from there.

const editing = ref(!reader.text)
const draft = ref(reader.text)
const body = ref<HTMLElement | null>(null)
/** Each sentence's word elements, to highlight. */
let words: HTMLElement[][] = []

const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dt,dd,figcaption'
const ABBREVIATION = /^(mr|mrs|ms|dr|prof|st|vs|etc|e\.g|i\.e|no|fig|approx|inc|ltd|jr|sr)\.$/i
const ENDS_SENTENCE = /[.!?…]["'”’)\]]*$/
/** A sentence longer than this is split at its next comma, so each piece is quick to synthesise. */
const LONG = 220

const position = computed(() => (reader.total ? `Sentence ${Math.min(reader.s + 1, reader.total)} of ${reader.total}` : ''))
const onlyJarvis = computed(() => reader.voices.length > 0 && reader.voices.every((v) => v === reader.jarvisVoice))

async function render(): Promise<void> {
  await nextTick()
  const root = body.value
  if (!root) return
  // Rebuilt from the text every time (never re-wrapping words already wrapped).
  root.innerHTML = DOMPurify.sanitize(marked.parse(reader.text, { async: false, gfm: true }) as string)
  // Every word in its own span (code blocks aren't read), then words grouped into sentences.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('pre,script,style') || !n.nodeValue?.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  const all: { el: HTMLElement; block: Element }[] = []
  for (const node of nodes) {
    const block = node.parentElement?.closest(BLOCK) ?? root
    const frag = document.createDocumentFragment()
    let last: HTMLElement | null = null
    for (const token of node.nodeValue!.split(/(\s+)/)) {
      if (!token) continue
      if (/^\s+$/.test(token)) {
        // The space after a word goes in its span, so a highlighted sentence is one band, not patches.
        if (last) last.append(token)
        else frag.append(token)
        continue
      }
      const el = document.createElement('span')
      el.className = 'rw'
      el.textContent = token
      frag.append(el)
      last = el
      all.push({ el, block })
    }
    node.replaceWith(frag)
  }
  const segments: Segment[] = []
  words = []
  let cur: HTMLElement[] = []
  let chars = 0
  let block: Element | null = null
  const flush = () => {
    if (!cur.length) return
    words.push(cur)
    segments.push({ words: cur.map((el) => (el.textContent ?? '').trim()) })
    cur = []
    chars = 0
  }
  for (const { el, block: b } of all) {
    if (cur.length && b !== block) flush()
    block = b
    el.dataset.s = String(words.length)
    el.dataset.w = String(cur.length)
    cur.push(el)
    const text = (el.textContent ?? '').trim()
    chars += text.length + 1
    if ((ENDS_SENTENCE.test(text) && !ABBREVIATION.test(text) && !/^[A-Z]\.$/.test(text)) || (chars > LONG && /[,;:—–]$/.test(text))) flush()
  }
  flush()
  setSegments(segments)
  highlight()
}

let marked_: HTMLElement[] = []
/** The sentence being read (or where reading will start), and its word. */
function highlight(): void {
  for (const el of marked_) el.classList.remove('rs', 'rs-active', 'rw-now', 'rw-start')
  marked_ = []
  const sentence = words[reader.s]
  if (!sentence) return
  const active = reader.state === 'playing' || reader.state === 'loading'
  for (const el of sentence) {
    el.classList.add('rs')
    if (active) el.classList.add('rs-active')
    marked_.push(el)
  }
  const word = sentence[Math.min(reader.w, sentence.length - 1)]
  if (word) {
    word.classList.add(active ? 'rw-now' : 'rw-start')
    keepInView(word)
  }
}

function keepInView(el: HTMLElement): void {
  const box = body.value?.parentElement
  if (!box) return
  const r = el.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  if (r.top < b.top + 24 || r.bottom > b.bottom - 24) el.scrollIntoView({ block: 'center', behavior: reader.state === 'playing' ? 'smooth' : 'auto' })
}

const at = (el: HTMLElement) => ({ s: Number(el.dataset.s), w: Number(el.dataset.w) })

/** A click on a word: read from there (now, if reading; otherwise when play is pressed). */
function onClick(event: MouseEvent): void {
  if (!window.getSelection()?.isCollapsed) return
  const el = (event.target as HTMLElement).closest<HTMLElement>('.rw')
  if (el) seek(at(el))
}

/** Text selected: read from its first word. */
function onSelect(): void {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !body.value || !body.value.contains(sel.anchorNode)) return
  const range = sel.getRangeAt(0)
  const first = [...body.value.querySelectorAll<HTMLElement>('.rw')].find((el) => range.intersectsNode(el))
  if (first) seek(at(first))
}

function toggle(): void {
  if (reader.state === 'playing' || reader.state === 'loading') pause()
  else if (reader.state === 'paused') resume()
  else void play()
}

function startReading(): void {
  reader.text = draft.value
  reader.title = ''
  reader.s = 0
  reader.w = 0
  remember()
  editing.value = false
}

function edit(): void {
  stop()
  draft.value = reader.text
  editing.value = true
}

watch(() => [reader.s, reader.w, reader.state], highlight)
// New text (pasted here, or a document opened from the viewer): render it.
watch(
  () => reader.text,
  async (text) => {
    if (!text) {
      editing.value = true
      return
    }
    if (editing.value && text !== draft.value) editing.value = false
    if (!editing.value) await render()
  },
)
watch(editing, async (now) => {
  if (!now && reader.text) await render()
})

onMounted(async () => {
  void loadVoices()
  if (!editing.value) await render()
})
</script>

<template>
  <section class="reader card" aria-label="Read aloud">
    <div class="card-header">
      <div class="d-flex align-items-center gap-2 w-100 flex-wrap">
        <span aria-hidden="true">🔊</span>
        <span class="fw-semibold text-truncate">{{ reader.title || 'Read aloud' }}</span>
        <span class="ms-auto d-flex gap-2 align-items-center">
          <select
            class="form-control form-control-sm voice"
            :value="reader.voice"
            aria-label="Voice"
            title="The voice it's read in"
            @change="setVoice(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="v in reader.voices" :key="v" :value="v">{{ v }}{{ v === reader.jarvisVoice ? ' (Jarvis)' : '' }}</option>
          </select>
          <select
            class="form-control form-control-sm rate"
            :value="reader.rate"
            aria-label="Speed"
            title="Speed"
            @change="setRate(Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="r in [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75]" :key="r" :value="r">{{ r }}×</option>
          </select>
          <button v-if="!editing" type="button" class="btn-text btn-sm" title="Change the text" aria-label="Change the text" @click="edit">✎</button>
          <button type="button" class="btn-text btn-sm" title="Close" aria-label="Close" @click="closeReader">✕</button>
        </span>
      </div>
    </div>

    <!-- Paste -->
    <div v-if="editing" class="card-body vstack gap-2 reader-body">
      <label for="reader-text" class="form-label m-0 text-sm fg-3">Paste the text to read aloud (Markdown is fine).</label>
      <textarea id="reader-text" v-model="draft" class="form-control paste" placeholder="Paste or type here…" @keydown.ctrl.enter="draft.trim() && startReading()"></textarea>
      <div class="d-flex gap-2">
        <button type="button" class="btn-solid theme-primary" :disabled="!draft.trim()" @click="startReading">Read this</button>
        <button v-if="reader.text" type="button" class="btn-outline theme-secondary" @click="editing = false">Cancel</button>
      </div>
    </div>

    <!-- Read -->
    <template v-else>
      <div class="controls d-flex align-items-center gap-2 flex-wrap">
        <button type="button" class="btn-outline theme-secondary btn-sm" title="Previous sentence" aria-label="Previous sentence" :disabled="reader.s === 0" @click="step(-1)">⏮</button>
        <button type="button" class="btn-solid theme-primary btn-sm play" :aria-label="reader.state === 'playing' ? 'Pause' : 'Play'" @click="toggle">
          <span v-if="reader.state === 'loading'" class="spinner-border spinner-sm" aria-hidden="true"></span>
          <template v-else>{{ reader.state === 'playing' ? '⏸ Pause' : '▶ Play' }}</template>
        </button>
        <button type="button" class="btn-outline theme-secondary btn-sm" title="Stop" aria-label="Stop" :disabled="reader.state === 'idle'" @click="stop">⏹</button>
        <button type="button" class="btn-outline theme-secondary btn-sm" title="Next sentence" aria-label="Next sentence" :disabled="reader.s >= reader.total - 1" @click="step(1)">⏭</button>
        <span class="text-sm fg-3 ms-auto">{{ position }}</span>
      </div>
      <div v-if="reader.error" class="alert theme-danger m-2" role="alert">{{ reader.error }}</div>
      <div v-if="onlyJarvis" class="text-sm fg-3 px-3 pt-2">Only Jarvis's voice is available: add another voice in audio.cpp to tell them apart.</div>
      <div class="card-body reader-body">
        <p class="text-sm fg-3 mb-3 hint">Click a word, or select some text, to read from there.</p>
        <!-- Filled by render(): the text, sanitized with DOMPurify, every word in a span. -->
        <article ref="body" class="read-text" @click="onClick" @mouseup="onSelect" @keyup="onSelect"></article>
      </div>
    </template>
  </section>
</template>

<style scoped>
.reader {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.reader > .card-header,
.controls {
  flex: none;
}
.controls {
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--bs-border-color, rgba(127, 127, 127, 0.3));
}
.reader-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.paste {
  flex: 1;
  min-height: 12rem;
  resize: none;
}
.voice {
  width: auto;
  max-width: 10rem;
}
.rate {
  width: auto;
}
.play {
  min-width: 6rem;
}
.read-text {
  line-height: 1.75;
  font-size: 1.05rem;
  max-width: 48rem;
}
.read-text :deep(.rw) {
  cursor: pointer;
  border-radius: 0.2rem;
}
.read-text :deep(.rw:hover) {
  text-decoration: underline dotted;
}
/* The sentence: lightly marked where reading will start, clearly while reading. */
.read-text :deep(.rs) {
  background: color-mix(in srgb, var(--bs-warning, #ffc107) 12%, transparent);
}
.read-text :deep(.rs-active) {
  background: color-mix(in srgb, var(--bs-warning, #ffc107) 30%, transparent);
}
/* The word being read, and the start point when stopped. */
.read-text :deep(.rw-now) {
  background: color-mix(in srgb, var(--bs-warning, #ffc107) 75%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--bs-warning, #ffc107) 75%, transparent);
}
.read-text :deep(.rw-start) {
  box-shadow: inset 2px 0 0 var(--bs-primary, #0d6efd);
  background: color-mix(in srgb, var(--bs-primary, #0d6efd) 15%, transparent);
}
.read-text :deep(pre) {
  opacity: 0.6;
  padding: 0.75rem 1rem;
  border-radius: 0.375rem;
  background: var(--bs-tertiary-bg, rgba(127, 127, 127, 0.1));
}
.read-text :deep(img) {
  max-width: 100%;
}
</style>
