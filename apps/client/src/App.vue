<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, toRaw, watch } from 'vue'
import {
  StreamTranscriber,
  type FrameStats,
  type PhraseState,
  type RequestLog,
  type SpeakerTag,
  type UploadStats,
} from './audio/streamTranscriber'
import HistoryPanel from './components/HistoryPanel.vue'
import MonitorPanel from './components/MonitorPanel.vue'
import PeoplePanel from './components/PeoplePanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import SpeakerBadge from './components/SpeakerBadge.vue'
import VoicePanel from './components/VoicePanel.vue'
import { settings } from './settings'

/** Passed to Qwen3-ASR. Forcing the language stops it guessing at noise. */
const LANGUAGE = 'English'

type Status = 'idle' | 'starting' | 'listening' | 'finishing'
type Tab = 'live' | 'history' | 'people' | 'voice'

const tab = ref<Tab>('live')

interface Phrase {
  id: number
  /** Position in the transcript (pieces of a split phrase sit where it was). */
  order: number
  text: string
  final: boolean
  speaker?: SpeakerTag
  speakerFinal?: boolean
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
/** Most recent final speaker decision, for the Monitor. */
const lastSpeaker = shallowRef<SpeakerTag | null>(null)
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
/** Whether any phrase carries a speaker tag (i.e. your voice is trained). */
const hasSpeakers = computed(() => recordings.value.some((phrases) => phrases.some((p) => p.speaker?.isOwner != null || !!p.speaker?.name)))

function phraseFor(phrases: Phrase[], id: number): Phrase {
  let phrase = phrases.find((p) => p.id === id)
  if (!phrase) {
    // Phrases can finish out of order; keep them in speaking order.
    phrases.push({ id, order: id, text: '', final: false })
    phrases.sort((a, b) => a.order - b.order)
    phrase = phrases.find((p) => p.id === id)!
  }
  return phrase
}

/** One phrase turned out to hold several speakers: replace it with its pieces, in place. */
function splitPhrase(phrases: Phrase[], id: number, into: number[]): void {
  const index = phrases.findIndex((p) => p.id === id)
  const order = index === -1 ? id : phrases[index]!.order
  const next = phrases.find((p) => p.order > order)?.order ?? order + 1
  const pieces = into.map((pieceId, k) => ({ id: pieceId, order: order + ((next - order) * k) / into.length, text: '', final: false }))
  if (index === -1) phrases.push(...pieces)
  else phrases.splice(index, 1, ...pieces)
  phrases.sort((a, b) => a.order - b.order)
}

function upsertPhrase(phrases: Phrase[], id: number, text: string, final: boolean): void {
  const phrase = phraseFor(phrases, id)
  phrase.text = text
  phrase.final = final
}

function setSpeaker(phrases: Phrase[], id: number, speaker: SpeakerTag, final: boolean): void {
  const phrase = phraseFor(phrases, id)
  if (phrase.speakerFinal && !final) return // never replace the decision with an early guess
  phrase.speaker = speaker
  phrase.speakerFinal = final
  if (final) lastSpeaker.value = speaker
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
  lastSpeaker.value = null
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
      onSpeaker: (id, speaker, final) => setSpeaker(current, id, speaker, final),
      onSplit: (id, into) => splitPhrase(current, id, into),
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

        <ul class="nav nav-tabs">
          <li class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === 'live' }" @click="tab = 'live'">Live</button>
          </li>
          <li class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === 'history' }" @click="tab = 'history'">
              History
            </button>
          </li>
          <li class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === 'people' }" @click="tab = 'people'">
              People
            </button>
          </li>
          <li class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === 'voice' }" @click="tab = 'voice'">
              Your voice
            </button>
          </li>
        </ul>
      </div>
    </div>

    <!-- Live stays mounted (v-show) so listening continues while browsing history. -->
    <div v-show="tab === 'live'" class="row justify-content-center mt-5">
      <div class="col-12 vstack gap-5">
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
              <!-- Once your voice is trained, one line per phrase with who said it; before that, flowing text. -->
              <div v-if="phrases.length && hasSpeakers" class="vstack gap-2 mb-4">
                <div v-for="phrase in phrases" :key="phrase.id" class="d-flex gap-3 align-items-baseline">
                  <span class="text-nowrap"><SpeakerBadge :speaker="phrase.speaker" :early="!phrase.speakerFinal" /></span>
                  <span :class="{ 'fg-3': !phrase.final }">{{ phrase.text }}</span>
                </div>
              </div>
              <p v-else-if="phrases.length">
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

    <div v-show="tab === 'live'" class="row justify-content-center gy-5 mt-0">
      <div class="col-12 lg:col-7">
        <MonitorPanel
          :listening="status === 'listening' || status === 'finishing'"
          :frame="frame"
          :upload="upload"
          :phrase-state="phraseState"
          :requests="requests"
          :last-speaker="lastSpeaker"
        />
      </div>
      <div class="col-12 lg:col-5">
        <SettingsPanel />
      </div>
    </div>

    <div v-if="tab === 'history'" class="row justify-content-center mt-5">
      <div class="col-12">
        <HistoryPanel />
      </div>
    </div>

    <div v-if="tab === 'people'" class="row justify-content-center mt-5">
      <div class="col-12">
        <PeoplePanel />
      </div>
    </div>

    <div v-if="tab === 'voice'" class="row justify-content-center mt-5">
      <div class="col-12">
        <VoicePanel :live-busy="status !== 'idle'" />
      </div>
    </div>
  </main>
</template>
