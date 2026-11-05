<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

interface Conversation {
  id: number
  startedAt: string
  endedAt: string | null
  device: string
  keep: boolean
  keepNote: string | null
  phraseCount: number
  speechMs: number
  audioBytes: number
  preview: string
}

interface Phrase {
  id: number
  seq: number
  startedAt: string
  durationMs: number
  text: string
  status: 'ok' | 'dropped' | 'error'
  hasAudio: boolean
  keep: boolean
}

const PAGE_SIZE = 30

const conversations = ref<Conversation[]>([])
const phrases = reactive<Record<number, Phrase[] | 'loading'>>({})
const open = reactive<Record<number, boolean>>({})
const loading = ref(false)
const hasMore = ref(false)
const error = ref('')

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

async function load(more = false): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const before = more ? conversations.value.at(-1)?.id : undefined
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (before) params.set('before', String(before))
    const { conversations: page } = await api<{ conversations: Conversation[] }>(`/api/conversations?${params}`)
    conversations.value = more ? [...conversations.value, ...page] : page
    hasMore.value = page.length === PAGE_SIZE
    // Refresh any expanded conversations (new phrases may have arrived).
    if (!more) for (const id of Object.keys(open).map(Number)) if (open[id]) void loadPhrases(id)
  } catch (err) {
    error.value = `Could not load history: ${(err as Error).message}`
  } finally {
    loading.value = false
  }
}

async function loadPhrases(id: number): Promise<void> {
  if (!phrases[id]) phrases[id] = 'loading'
  try {
    phrases[id] = (await api<{ phrases: Phrase[] }>(`/api/conversations/${id}/phrases`)).phrases
  } catch (err) {
    delete phrases[id]
    error.value = `Could not load conversation ${id}: ${(err as Error).message}`
  }
}

function phraseList(id: number): Phrase[] {
  const list = phrases[id]
  return Array.isArray(list) ? list : []
}

function toggle(id: number): void {
  open[id] = !open[id]
  if (open[id]) void loadPhrases(id)
}

async function setKeep(kind: 'conversations' | 'phrases', item: { id: number; keep: boolean }): Promise<void> {
  const keep = !item.keep
  try {
    await api(`/api/${kind}/${item.id}/keep`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keep }),
    })
    item.keep = keep
  } catch (err) {
    error.value = `Could not update: ${(err as Error).message}`
  }
}

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const seconds = (ms: number) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`)
const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`)

defineExpose({ refresh: () => load() })
onMounted(() => load())
</script>

<template>
  <div class="vstack gap-4">
    <div class="d-flex align-items-center gap-3">
      <span class="fg-3 text-sm">
        Every phrase is kept with its audio. “Keep forever” protects it from any future clean-up of old audio.
      </span>
      <button type="button" class="btn-outline theme-secondary btn-sm ms-auto" :disabled="loading" @click="load()">
        Refresh
      </button>
    </div>

    <div v-if="error" class="alert theme-danger" role="alert">{{ error }}</div>

    <p v-if="!loading && conversations.length === 0" class="fg-3 m-0">Nothing recorded yet.</p>

    <div v-for="c in conversations" :key="c.id" class="card">
      <div class="card-header">
        <div class="d-flex align-items-center gap-3 flex-wrap w-100">
          <button type="button" class="btn-text" :aria-expanded="!!open[c.id]" @click="toggle(c.id)">
            {{ open[c.id] ? '▾' : '▸' }} <span class="fw-semibold">{{ dateTime(c.startedAt) }}</span>
          </button>
          <span class="badge theme-secondary">{{ c.device }}</span>
          <span class="text-sm fg-3">
            {{ c.phraseCount }} phrase{{ c.phraseCount === 1 ? '' : 's' }} · {{ seconds(c.speechMs) }} of speech ·
            {{ kb(c.audioBytes) }}
          </span>
          <span v-if="!c.endedAt" class="badge theme-danger">recording</span>
          <button
            type="button"
            class="btn-sm ms-auto"
            :class="c.keep ? 'btn-solid theme-warning' : 'btn-outline theme-secondary'"
            :aria-pressed="c.keep"
            @click="setKeep('conversations', c)"
          >
            {{ c.keep ? '★ Kept forever' : '☆ Keep forever' }}
          </button>
        </div>
      </div>

      <div v-if="!open[c.id]" class="card-body py-3">
        <p class="m-0 text-truncate fg-3">{{ c.preview || '(no transcribed speech)' }}</p>
      </div>

      <ul v-else class="list-group list-group-flush">
        <li v-if="phrases[c.id] === 'loading'" class="list-group-item fg-3">Loading…</li>
        <template v-else>
          <li v-for="p in phraseList(c.id)" :key="p.id" class="list-group-item">
            <div class="d-flex align-items-start gap-3">
              <span class="font-monospace text-sm fg-3 text-nowrap">{{ time(p.startedAt) }}</span>
              <div class="flex-grow-1 vstack gap-2">
                <span v-if="p.status === 'ok'">{{ p.text }}</span>
                <span v-else class="fg-3">
                  <span class="badge" :class="p.status === 'error' ? 'theme-danger' : 'theme-secondary'">
                    {{ p.status === 'error' ? 'transcription failed' : 'no speech recognised' }}
                  </span>
                </span>
                <audio
                  v-if="p.hasAudio"
                  class="w-100"
                  controls
                  preload="none"
                  :src="`/api/phrases/${p.id}/audio`"
                ></audio>
              </div>
              <span class="font-monospace text-sm fg-3 text-nowrap">{{ seconds(p.durationMs) }}</span>
              <button
                type="button"
                class="btn-sm"
                :class="p.keep ? 'btn-solid theme-warning' : 'btn-text'"
                :aria-pressed="p.keep"
                :title="p.keep ? 'Kept forever' : 'Keep forever'"
                @click="setKeep('phrases', p)"
              >
                {{ p.keep ? '★' : '☆' }}
              </button>
            </div>
          </li>
        </template>
      </ul>
    </div>

    <button v-if="hasMore" type="button" class="btn-outline theme-secondary" :disabled="loading" @click="load(true)">
      Load older conversations
    </button>
  </div>
</template>
