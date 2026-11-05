<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, toRaw, watch } from 'vue'
import {
  StreamTranscriber,
  type FrameStats,
  type PhraseState,
  type RequestLog,
  type UploadStats,
} from './audio/streamTranscriber'
import MonitorPanel from './components/MonitorPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import { settings } from './settings'

/** Passed to Qwen3-ASR. Forcing the language stops it guessing at noise. */
const LANGUAGE = 'English'

type Status = 'idle' | 'starting' | 'listening' | 'finishing'

interface Phrase {
  id: number
  text: string
  final: boolean
}

const status = ref<Status>('idle')
const error = ref('')
/** One entry per recording; each recording is a list of phrases. */
const recordings = ref<Phrase[][]>([])

/** Monitoring: latest local VAD frame, upload counters, the server's phrase state, and its request log. */
const frame = shallowRef<FrameStats | null>(null)
const upload = shallowRef<UploadStats | null>(null)
const phraseState = shallowRef<PhraseState | null>(null)
const requests = shallowRef<RequestLog[]>([])
/** The server has a phrase open: you're talking, or in a pause it hasn't ended yet. */
const speaking = computed(() => phraseState.value?.inPhrase ?? false)
const MAX_REQUEST_LOG = 200

let transcriber: StreamTranscriber | undefined

// Settings changes apply to a recording in progress straight away.
watch(settings, (value) => transcriber?.updateSettings({ ...toRaw(value) }), { deep: true })

const buttonLabel = computed(() => {
  switch (status.value) {
    case 'starting':
      return 'Starting…'
    case 'listening':
      return 'Stop listening'
    case 'finishing':
      return 'Finishing…'
    default:
      return 'Start listening'
  }
})

const hasText = computed(() => recordings.value.some((phrases) => phrases.some((p) => p.text)))

function upsertPhrase(phrases: Phrase[], id: number, text: string, final: boolean): void {
  const existing = phrases.find((p) => p.id === id)
  if (existing) {
    existing.text = text
    existing.final = final
  } else {
    // Phrases can finish out of order; keep them in speaking order.
    phrases.push({ id, text, final })
    phrases.sort((a, b) => a.id - b.id)
  }
}

async function start(): Promise<void> {
  error.value = ''
  status.value = 'starting'
  recordings.value.push([])
  // Take it back out of the ref so edits go through Vue's reactive proxy.
  const current = recordings.value.at(-1)!

  frame.value = null
  upload.value = null
  phraseState.value = null
  requests.value = []
  const session = new StreamTranscriber(
    { language: LANGUAGE, settings: { ...toRaw(settings) } },
    {
      onFrame: (stats, uploadStats) => {
        frame.value = stats
        upload.value = uploadStats
      },
      onState: (state) => (phraseState.value = state),
      onRequest: (log) => (requests.value = [...requests.value.slice(-(MAX_REQUEST_LOG - 1)), log]),
      onPhrase: (id, text, final) => upsertPhrase(current, id, text, final),
      onPhraseDropped: (id) => {
        const index = current.findIndex((p) => p.id === id)
        if (index !== -1) current.splice(index, 1)
      },
      onError: (message) => (error.value = message),
    },
  )
  transcriber = session
  try {
    await session.start()
    status.value = 'listening'
  } catch (err) {
    transcriber = undefined
    session.cancel()
    status.value = 'idle'
    if (current.length === 0) recordings.value.pop()
    error.value =
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it in the browser and try again.'
        : err instanceof Error
          ? err.message
          : String(err)
  }
}

async function stop(): Promise<void> {
  if (!transcriber) return
  status.value = 'finishing'
  await transcriber.stop()
  transcriber = undefined
  frame.value = null
  phraseState.value = null
  if (recordings.value.at(-1)?.length === 0) recordings.value.pop()
  status.value = 'idle'
}

function toggle(): void {
  if (status.value === 'idle') void start()
  else if (status.value === 'listening') void stop()
}

function clear(): void {
  recordings.value = []
}

onBeforeUnmount(() => transcriber?.cancel())
</script>

<template>
  <main class="container py-6">
    <div class="row justify-content-center">
      <div class="col-12 vstack gap-5">
        <header class="d-flex align-items-center gap-3">
          <h1 class="text-3xl fw-semibold m-0">Jarvis</h1>
          <span v-if="status === 'listening'" class="badge" :class="speaking ? 'theme-danger' : 'theme-secondary'">
            <span v-if="speaking" class="spinner-grow spinner-sm" aria-hidden="true"></span>
            {{ speaking ? 'Hearing you' : 'Listening' }}
          </span>
        </header>

        <div class="d-flex gap-3">
          <button
            type="button"
            class="btn-solid btn-lg"
            :class="status === 'listening' ? 'theme-danger' : 'theme-primary'"
            :disabled="status === 'starting' || status === 'finishing'"
            @click="toggle"
          >
            <span
              v-if="status === 'starting' || status === 'finishing'"
              class="spinner-border spinner-sm"
              aria-hidden="true"
            ></span>
            {{ buttonLabel }}
          </button>
          <button
            type="button"
            class="btn-outline theme-secondary btn-lg"
            :disabled="!hasText || status !== 'idle'"
            @click="clear"
          >
            Clear
          </button>
        </div>

        <div v-if="error" class="alert theme-danger" role="alert">{{ error }}</div>

        <div class="card">
          <div class="card-body text-lg" aria-live="polite">
            <template v-for="(phrases, index) in recordings" :key="index">
              <p v-if="phrases.length">
                <template v-for="phrase in phrases" :key="phrase.id">
                  <span :class="{ 'fg-3': !phrase.final }">{{ phrase.text }}</span>{{ ' ' }}
                </template>
              </p>
            </template>
            <p v-if="!hasText" class="fg-3 m-0">
              {{ status === 'listening' ? 'Speak now.' : 'Press “Start listening” and start talking.' }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <div class="row justify-content-center gy-5 mt-0">
      <div class="col-12 lg:col-7">
        <MonitorPanel
          :listening="status === 'listening' || status === 'finishing'"
          :frame="frame"
          :upload="upload"
          :phrase-state="phraseState"
          :requests="requests"
        />
      </div>
      <div class="col-12 lg:col-5">
        <SettingsPanel />
      </div>
    </div>
  </main>
</template>
