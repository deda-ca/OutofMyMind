<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, toRaw, watch } from 'vue'
import {
  StreamTranscriber,
  type FrameStats,
  type PhraseState,
  type RequestLog,
  type AssistantMessage,
  type SpeakerTag,
  type UploadStats,
} from './audio/streamTranscriber'
import { BargeIn } from './audio/bargeIn'
import { SpeechPlayer, type PlayerState } from './audio/speechPlayer'
import { signOut, signedIn } from './auth'
import HistoryPanel from './components/HistoryPanel.vue'
import SignInPanel from './components/SignInPanel.vue'
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
  /** A line from Jarvis (reply, "Yes?", "Okay.", or an error), not something heard. */
  jarvis?: 'reply' | 'wake' | 'dismiss' | 'error'
  /** What the agent did while answering (Hermes tool use), or notes. */
  activity?: { kind: string; label: string; emoji?: string }[]
  /** Typed or pasted into the message box, not spoken. */
  typed?: boolean
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
/** Jarvis: idle, or in a conversation (listening for follow-ups until followUpEndsAt). */
const assistant = ref<{ state: 'idle' | 'conversation'; followUpEndsAt: number | null; ownerTrained: boolean } | null>(null)
/** Ticks every second so the follow-up countdown updates. */
const now = ref(Date.now())
const ticker = setInterval(() => (now.value = Date.now()), 1000)
/** What Jarvis's voice is doing. */
const playback = ref<PlayerState>('idle')
const jarvisSpeaking = computed(() => playback.value === 'playing')
/** If a barge-in pause gets no answer from the server (e.g. connection trouble), carry on after this long. */
const BARGE_IN_TIMEOUT_MS = 10000
let bargeInTimer: ReturnType<typeof setTimeout> | undefined
const player = new SpeechPlayer((state) => {
  playback.value = state
  if (state !== 'paused') clearTimeout(bargeInTimer)
  // Jarvis stopped, finished, or the server decided: the next interruption starts fresh.
  if (state !== 'paused') bargeInDetector.reset()
  transcriber?.sendPlayback(state)
})

/** Duck, pause, or fade back up, from the voice detector's frames (see audio/bargeIn.ts). */
const bargeInDetector = new BargeIn()

/**
 * After the server says "that wasn't for Jarvis, carry on" while someone is
 * still talking, don't interrupt again for the same phrase.
 */
let ignoreUntilPhraseEnds = false

/** Each 32 ms frame while Jarvis is talking: is someone interrupting? */
function bargeInFrame(probability: number): void {
  if (settings.bargeIn < 0.5 || ignoreUntilPhraseEnds) return
  if (player.playerState !== 'playing' && !bargeInDetector.ducked) return
  const action = bargeInDetector.frame(probability, { speechThreshold: settings.speechThreshold, pauseAfterMs: settings.bargeInMs })
  if (action === 'duck') player.duck(settings.duckVolume)
  else if (action === 'unduck') player.unduck()
  else if (action === 'pause') {
    player.pause()
    clearTimeout(bargeInTimer)
    bargeInTimer = setTimeout(() => player.resume(), BARGE_IN_TIMEOUT_MS)
  }
}
const followUpSeconds = computed(() =>
  assistant.value?.followUpEndsAt ? Math.max(0, Math.ceil((assistant.value.followUpEndsAt - now.value) / 1000)) : 0,
)
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
/** One line per phrase (with who said it, and Jarvis's replies) once there are speakers or replies; flowing text otherwise. */
const hasSpeakers = computed(() =>
  recordings.value.some((phrases) => phrases.some((p) => p.jarvis || p.speaker?.isOwner != null || !!p.speaker?.name)),
)

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

function upsertPhrase(phrases: Phrase[], id: number, text: string, final: boolean, typed?: boolean): void {
  const phrase = phraseFor(phrases, id)
  phrase.text = text
  phrase.final = final
  if (typed) phrase.typed = true
}

/** The message box: type, paste, or fix a misheard phrase, then send it to Jarvis. */
const draft = ref('')
const composer = ref<HTMLTextAreaElement | null>(null)
const canSend = computed(() => status.value === 'listening' && draft.value.trim().length > 0)

function sendDraft(): void {
  if (!canSend.value || !transcriber?.sendText(draft.value.trim())) return
  draft.value = ''
  // Show the message and Jarvis's answer, even if you'd scrolled up to copy something.
  followTranscript.value = true
}

/** Enter sends; Shift+Enter is a new line (and Enter while an IME is composing is left alone). */
function composerKey(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  sendDraft()
}

/** Put a phrase into the message box to correct it and send it again. */
function editPhrase(phrase: Phrase): void {
  draft.value = phrase.text
  composer.value?.focus()
}

/** Jarvis's replies sit right after the phrase they answer. Reply ids are negative so they never clash with phrase ids. */
function onAssistant(phrases: Phrase[], message: AssistantMessage): void {
  if (message.type === 'assistant.state') {
    assistant.value = { state: message.state, followUpEndsAt: message.followUpEndsAt, ownerTrained: message.ownerTrained }
    return
  }
  if (message.type === 'assistant.tool') {
    const line = phrases.find((p) => p.id === -message.replyId)
    if (line) (line.activity ??= []).push({ kind: message.kind, label: message.label, emoji: message.emoji })
    return
  }
  if (message.type === 'assistant.audio') {
    player.add(message.replyId, message.seq, message.wav)
    return
  }
  if (message.type === 'assistant.control') {
    if (message.action === 'stop') player.stop()
    else if (message.action === 'continue') player.continueSpeaking()
    else if (message.action === 'repeat') player.repeat(message.replyId)
    else {
      player.resume()
      if (bargeInDetector.ducked) player.unduck()
      bargeInDetector.reset()
      if (phraseState.value?.inPhrase) ignoreUntilPhraseEnds = true
    }
    return
  }
  const id = -message.replyId
  if (message.type === 'assistant.start') {
    const to = phrases.find((p) => p.id === message.toPhraseId)
    phrases.push({ id, order: (to?.order ?? message.toPhraseId) + 0.001, text: '', final: false, jarvis: 'reply' })
    phrases.sort((a, b) => a.order - b.order)
    return
  }
  const line = phrases.find((p) => p.id === id)
  if (!line) return
  if (message.type === 'assistant.delta') line.text += message.delta
  else if (message.type === 'assistant.done') {
    line.text = message.text
    line.final = true
    line.jarvis = message.kind
  } else {
    line.text = message.message
    line.final = true
    line.jarvis = 'error'
  }
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
  // Unlock audio output now, while we're handling the click.
  void player.unlock()
  const session = new StreamTranscriber(
    { language: LANGUAGE, settings: { ...toRaw(settings) } },
    {
      onFrame: (stats, uploadStats) => {
        frame.value = stats
        upload.value = uploadStats
        bargeInFrame(stats.probability)
      },
      onState: (state) => {
        phraseState.value = state
        if (!state.inPhrase) ignoreUntilPhraseEnds = false
      },
      onRequest: (log) => (requests.value = [...requests.value.slice(-(MAX_REQUEST_LOG - 1)), log]),
      onPhrase: (id, text, final, typed) => upsertPhrase(current, id, text, final, typed),
      onSpeaker: (id, speaker, final) => setSpeaker(current, id, speaker, final),
      onSplit: (id, into) => splitPhrase(current, id, into),
      onAssistant: (message) => onAssistant(current, message),
      onServerSettings: (server) => {
        // Only the brain is changed by the server itself (by voice); keep the switch in step.
        if (server.brain !== settings.brain) settings.brain = server.brain
      },
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
  assistant.value = null
  player.cancel()
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

/** Opens the settings dialog (gear button). */
const settingsPanel = ref<InstanceType<typeof SettingsPanel> | null>(null)

/**
 * The transcript fills the page and follows the conversation: while you're at
 * the bottom it scrolls as text arrives. Scroll up to read back and it stays
 * put; scroll down again (or press "Latest") and it follows again.
 */
const transcriptEl = ref<HTMLElement | null>(null)
const followTranscript = ref(true)
/** How close to the bottom still counts as "at the bottom" (a line or so). */
const BOTTOM_SLACK_PX = 48

function onTranscriptScroll(): void {
  const el = transcriptEl.value
  if (el) followTranscript.value = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX
}

function scrollTranscriptToEnd(): void {
  const el = transcriptEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  followTranscript.value = true
}

// Phrases, live text and Jarvis's streaming replies all change `recordings`.
watch(recordings, () => followTranscript.value && scrollTranscriptToEnd(), { deep: true, flush: 'post' })
// Back on the Live tab (it was hidden, so nothing could scroll).
watch(tab, (value) => value === 'live' && followTranscript.value && nextTick(scrollTranscriptToEnd))

onBeforeUnmount(() => {
  transcriber?.cancel()
  player.close()
  clearInterval(ticker)
})
</script>

<template>
  <main v-if="signedIn === false" class="container py-6">
    <h1 class="text-3xl fw-semibold">Jarvis</h1>
    <SignInPanel />
  </main>
  <main v-else-if="signedIn" class="container py-6">
    <div class="row justify-content-center">
      <div class="col-12 vstack gap-5">
        <header class="d-flex align-items-center gap-3">
          <h1 class="text-3xl fw-semibold m-0">Jarvis</h1>
          <span v-if="status === 'listening'" class="badge" :class="speaking ? 'theme-danger' : 'theme-secondary'">
            <span v-if="speaking" class="spinner-grow spinner-sm" aria-hidden="true"></span>
            {{ speaking ? 'Hearing you' : 'Listening' }}
          </span>
          <template v-if="status === 'listening' && assistant">
            <span v-if="jarvisSpeaking" class="badge theme-info">
              <span class="spinner-grow spinner-sm" aria-hidden="true"></span>
              Jarvis speaking
            </span>
            <span v-else-if="playback === 'paused'" class="badge theme-warning">Jarvis paused · listening to you</span>
            <span v-else-if="playback === 'stopped'" class="badge theme-secondary" title="Say “continue” or “repeat”">
              Jarvis stopped
            </span>
            <span v-if="assistant.state === 'conversation'" class="badge theme-info">
              Talking with Jarvis{{ assistant.followUpEndsAt ? ` · follow-ups ${followUpSeconds} s` : '' }}
            </span>
            <span v-else class="text-sm fg-3">Say “Jarvis” to talk to it</span>
            <span class="badge theme-secondary badge-subtle" :title="settings.brain >= 0.5 ? 'Answers come from Nous Hermes Agent (tools, memory)' : 'Answers come straight from the local LLM'">
              {{ settings.brain >= 0.5 ? 'Brain: Hermes' : 'Brain: local LLM' }}
            </span>
            <span v-if="!assistant.ownerTrained" class="badge theme-warning badge-subtle" title="Train your voice on the “Your voice” tab so only you can talk to Jarvis">
              Anyone can talk to Jarvis until you train your voice
            </span>
          </template>
          <button
            type="button"
            class="btn-text btn-sm ms-auto settings-button"
            title="Settings"
            aria-label="Settings"
            aria-haspopup="dialog"
            @click="settingsPanel?.open()"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button type="button" class="btn-text btn-sm" :disabled="status !== 'idle'" @click="signOut">Sign out</button>
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

        <div class="card position-relative">
          <div ref="transcriptEl" class="card-body text-lg transcript" aria-live="polite" @scroll.passive="onTranscriptScroll">
            <template v-for="(phrases, index) in recordings" :key="index">
              <!-- Once your voice is trained, one line per phrase with who said it; before that, flowing text. -->
              <div v-if="phrases.length && hasSpeakers" class="vstack gap-2 mb-4">
                <div v-for="phrase in phrases" :key="phrase.id" class="d-flex gap-3 align-items-baseline">
                  <template v-if="phrase.jarvis">
                    <span class="text-nowrap"><span class="badge theme-info">Jarvis</span></span>
                    <span class="vstack gap-1">
                      <span v-for="(a, i) in phrase.activity ?? []" :key="i" class="text-sm" :class="a.kind === 'approval' ? 'fg-warning' : 'fg-3'">
                        {{ a.emoji ?? (a.kind === 'notice' ? 'ℹ️' : '⚙️') }}
                        {{ a.kind === 'approval' ? `Hermes is asking for approval: ${a.label} (approve it in Hermes for now)` : a.label }}
                      </span>
                      <span :class="phrase.jarvis === 'error' ? 'fg-danger' : 'fg-info'">{{ phrase.text || '…' }}</span>
                    </span>
                  </template>
                  <template v-else>
                    <span class="text-nowrap"><SpeakerBadge :speaker="phrase.speaker" :early="!phrase.speakerFinal" /></span>
                    <span class="phrase" :class="{ 'fg-3': !phrase.final }">
                      <span v-if="phrase.typed" class="fg-3 text-sm" title="Typed, not spoken">⌨️</span>
                      {{ phrase.text }}
                      <button
                        v-if="phrase.final && phrase.text"
                        type="button"
                        class="btn-text btn-sm edit-phrase"
                        title="Edit and send to Jarvis"
                        aria-label="Edit and send to Jarvis"
                        @click="editPhrase(phrase)"
                      >
                        ✎
                      </button>
                    </span>
                  </template>
                </div>
              </div>
              <p v-else-if="phrases.length">
                <template v-for="phrase in phrases" :key="phrase.id">
                  <span
                    class="phrase"
                    :class="{ 'fg-3': !phrase.final, 'phrase-editable': phrase.final && phrase.text }"
                    :title="phrase.final && phrase.text ? 'Click to edit and send to Jarvis' : undefined"
                    @click="phrase.final && phrase.text && editPhrase(phrase)"
                  >{{ phrase.text }}</span>{{ ' ' }}
                </template>
              </p>
            </template>
            <p v-if="!hasText" class="fg-3 m-0">
              {{ status === 'listening' ? 'Speak now.' : 'Press “Start listening” and start talking.' }}
            </p>
          </div>
          <button
            v-if="!followTranscript"
            type="button"
            class="btn-solid theme-secondary btn-sm latest-button"
            @click="scrollTranscriptToEnd"
          >
            ↓ Latest
          </button>
        </div>

        <form class="vstack gap-2" @submit.prevent="sendDraft">
          <label for="composer" class="visually-hidden">Message to Jarvis</label>
          <div class="d-flex gap-3 align-items-end">
            <textarea
              id="composer"
              ref="composer"
              v-model="draft"
              class="form-control"
              rows="2"
              :disabled="status !== 'listening'"
              :placeholder="
                status === 'listening'
                  ? 'Type or paste a message for Jarvis, or press ✎ on something you said to fix it…'
                  : 'Start listening to talk or type to Jarvis.'
              "
              @keydown="composerKey"
            ></textarea>
            <button type="submit" class="btn-solid theme-primary" :disabled="!canSend">Send</button>
          </div>
          <div class="form-text m-0">
            Enter sends, Shift+Enter adds a line. Typed messages always go to Jarvis, no “Jarvis” needed.
          </div>
        </form>
      </div>
    </div>

    <div v-show="tab === 'live'" class="row justify-content-center mt-5">
      <div class="col-12">
        <MonitorPanel
          :listening="status === 'listening' || status === 'finishing'"
          :frame="frame"
          :upload="upload"
          :phrase-state="phraseState"
          :requests="requests"
          :last-speaker="lastSpeaker"
        />
      </div>
    </div>

    <SettingsPanel ref="settingsPanel" />

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

<style scoped>
/* The ✎ on your phrases shows on hover (always on touch screens, which can't hover). */
.edit-phrase {
  padding-block: 0;
  line-height: 1;
}
@media (hover: hover) {
  .edit-phrase {
    opacity: 0;
  }
  .phrase:hover .edit-phrase,
  .edit-phrase:focus-visible {
    opacity: 1;
  }
}
/*
 * The transcript fits the page: roughly the window height minus the header,
 * tabs and buttons above it and the message box below, so the newest line and
 * the box stay on screen. It scrolls inside itself (see followTranscript).
 */
.transcript {
  height: max(14rem, calc(100dvh - 26rem));
  overflow-y: auto;
  overscroll-behavior: contain;
}
.latest-button {
  position: absolute;
  inset-block-end: 0.75rem;
  inset-inline-end: 1rem;
  box-shadow: var(--bs-box-shadow);
}
.settings-button {
  padding-inline: 0.375rem;
}
.phrase-editable {
  cursor: text;
  border-radius: 0.25rem;
}
.phrase-editable:hover {
  text-decoration: underline dotted;
}
</style>
