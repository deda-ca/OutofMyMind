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
import { replay, toggleReplay } from './audio/replay'
import { SpeechPlayer, type PlayerState } from './audio/speechPlayer'
import { signOut, signedIn } from './auth'
import AgentsPanel from './components/AgentsPanel.vue'
import ServicesPanel from './components/ServicesPanel.vue'
import PhonePanel from './components/PhonePanel.vue'
import PluginTab from './components/PluginTab.vue'
import AgentPicker from './components/AgentPicker.vue'
import { plugins, statusOf, tabRequest, tellTabs } from './plugins'
import { servicesNeedingOwner } from './services'
import ContextMeter from './components/ContextMeter.vue'
import DebugPanel from './components/DebugPanel.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import SignInPanel from './components/SignInPanel.vue'
import MonitorPanel from './components/MonitorPanel.vue'
import PeoplePanel from './components/PeoplePanel.vue'
import SessionsPanel from './components/SessionsPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import SkillsPanel from './components/SkillsPanel.vue'
import SchedulePanel from './components/SchedulePanel.vue'
import NotificationStack from './components/NotificationStack.vue'
import DocumentViewer from './components/DocumentViewer.vue'
import FileChips from './components/FileChips.vue'
import MarkdownText from './components/MarkdownText.vue'
import ToolCallLine from './components/ToolCallLine.vue'
import SpeakerBadge from './components/SpeakerBadge.vue'
import ToolsPanel from './components/ToolsPanel.vue'
import VoicePanel from './components/VoicePanel.vue'
import { loadContext, onContext } from './context'
import { debugEnabled, onDebugMessage } from './debug'
import { monitorEnabled } from './monitor'
import { agentIcon, agentName, loadSessions, sessions, sessionsChanged, shownAgent, type SessionEntry } from './sessions'
import { settings } from './settings'
import type { ToolCallInfo } from './toolCalls'
import { addFiles, type FileRef } from './uploads'
import { openFile, refreshFile, viewer } from './viewer'
import { acknowledge, connectNotifications, disconnectNotifications, notices, unlockSound } from './notifications'
import { stampsFor } from './stamps'
import { answer as answerCall, decline as declineCall, hangUp as hangUpCall, joinAudio, phone } from './phone'

/** Passed to Qwen3-ASR. Forcing the language stops it guessing at noise. */
const LANGUAGE = 'English'

type Status = 'idle' | 'starting' | 'listening' | 'finishing'
type Tab = 'live' | 'history' | 'people' | 'voice' | 'tools' | 'agents' | 'skills' | 'schedule' | 'services' | 'phone' | 'debug' | 'monitor' | `plugin:${string}`

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
  /** What the agent did while answering (tool calls), or notes. */
  activity?: { kind: string; label: string; emoji?: string; call?: ToolCallInfo }[]
  /** Typed or pasted into the message box, not spoken. */
  typed?: boolean
  /** Files the owner dropped in (this line is them, not something heard). */
  files?: FileRef[]
  /** When it started (ms), for the timestamps between groups of messages. */
  at: number
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
/** Talking, or paused mid-sentence (someone started talking over it): ■ can stop it. */
const jarvisTalking = computed(() => playback.value === 'playing' || playback.value === 'paused')
/** The live reply the player is on (for its ■). */
const speakingReplyId = ref<number>()
/** If a barge-in pause gets no answer from the server (e.g. connection trouble), carry on after this long. */
const BARGE_IN_TIMEOUT_MS = 10000
let bargeInTimer: ReturnType<typeof setTimeout> | undefined
const player = new SpeechPlayer((state) => {
  playback.value = state
  speakingReplyId.value = player.currentReplyId
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
// Notifications (timers, alarms, reminders) reach every open tab while signed in, listening or not.
unlockSound()
watch(signedIn, (yes) => (yes ? connectNotifications() : disconnectNotifications()), { immediate: true })
/** Running timers, as countdowns in the header. */
const timers = computed(() =>
  notices.schedules
    .filter((s) => s.kind === 'timer' && s.enabled && s.due)
    .map((s) => {
      const left = Math.max(0, Math.round((new Date(s.due!).getTime() - now.value) / 1000))
      const h = Math.floor(left / 3600)
      const clock = `${h ? `${h}:` : ''}${String(Math.floor((left % 3600) / 60)).padStart(h ? 2 : 1, '0')}:${String(left % 60).padStart(2, '0')}`
      return { id: s.id, title: s.title, clock }
    }),
)
const ringingCount = computed(() => notices.shown.filter((n) => n.ring).length)

const followUpSeconds = computed(() =>
  assistant.value?.followUpEndsAt ? Math.max(0, Math.ceil((assistant.value.followUpEndsAt - now.value) / 1000)) : 0,
)
/** The server has a phrase open: you're talking, or in a pause it hasn't ended yet. */
const speaking = computed(() => phraseState.value?.inPhrase ?? false)
/** Mic muted while listening: nothing is sent, but the session (and the conversation with Jarvis) stays open. */
const muted = ref(false)
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

/** Today (changes at midnight): the timestamps say just the time for today's messages. */
const today = computed(() => new Date(now.value).toDateString())
/** The timestamp before each group of messages: saved ones keyed `saved-<i>`, live ones by phrase id. */
const stamps = computed(() => {
  void today.value
  return stampsFor([
    ...sessions.entries.map((e, i) => ({ key: `saved-${i}`, at: Date.parse(e.at) })),
    ...recordings.value.flatMap((phrases) => phrases.filter((p) => p.text || p.files || p.jarvis).map((p) => ({ key: p.id, at: p.at }))),
  ])
})

const hasText = computed(() => sessions.entries.length > 0 || recordings.value.some((phrases) => phrases.some((p) => p.text)))
/** One line per phrase (with who said it, and Jarvis's replies) once there are speakers or replies; flowing text otherwise. */
const hasSpeakers = computed(() =>
  sessions.entries.length > 0 ||
  recordings.value.some((phrases) => phrases.some((p) => p.jarvis || p.files || p.speaker?.isOwner != null || !!p.speaker?.name)),
)

function phraseFor(phrases: Phrase[], id: number): Phrase {
  let phrase = phrases.find((p) => p.id === id)
  if (!phrase) {
    // Phrases can finish out of order; keep them in speaking order.
    phrases.push({ id, order: id, text: '', final: false, at: Date.now() })
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
  const started = phrases[index]?.at ?? Date.now()
  const pieces = into.map((pieceId, k) => ({ id: pieceId, order: order + ((next - order) * k) / into.length, text: '', final: false, at: started }))
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
  if (message.type === 'assistant.show') {
    openFile(message.path)
    return
  }
  if (message.type === 'assistant.tool') {
    // A finished tool call may have changed the file on screen.
    if (message.call?.status === 'done' && message.call.crud.some((k) => k !== 'read')) refreshFile()
    const line = phrases.find((p) => p.id === -message.replyId)
    if (!line) return
    // A tool call is announced when it starts, then again with its result: update it in place.
    const started = message.call && line.activity?.find((a) => a.call?.id === message.call!.id)
    if (started) started.call = message.call
    else (line.activity ??= []).push({ kind: message.kind, label: message.label, emoji: message.emoji, call: message.call })
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
    phrases.push({ id, order: (to?.order ?? message.toPhraseId) + 0.001, text: '', final: false, jarvis: 'reply', at: Date.now() })
    phrases.sort((a, b) => a.order - b.order)
    return
  }
  if (message.type === 'assistant.cancel') {
    // The owner carried on talking before Jarvis said anything: the next reply answers it all.
    const at = phrases.findIndex((p) => p.id === id)
    if (at !== -1) phrases.splice(at, 1)
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
  if (final && monitorEnabled.value) lastSpeaker.value = speaker
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
        bargeInFrame(stats.probability)
        // ~30 updates a second: only kept while the Monitor tab is switched on.
        if (!monitorEnabled.value) return
        frame.value = stats
        upload.value = uploadStats
      },
      onState: (state) => {
        phraseState.value = state
        if (!state.inPhrase) ignoreUntilPhraseEnds = false
      },
      onRequest: (log) => {
        if (monitorEnabled.value) requests.value = [...requests.value.slice(-(MAX_REQUEST_LOG - 1)), log]
      },
      onPhrase: (id, text, final, typed) => upsertPhrase(current, id, text, final, typed),
      onSpeaker: (id, speaker, final) => setSpeaker(current, id, speaker, final),
      onSplit: (id, into) => splitPhrase(current, id, into),
      onAssistant: (message) => onAssistant(current, message),
      onServerSettings: (server) => {
        // Wake-word-only is changed by the server itself (by voice); keep the switch in step.
        if (server.wakeWordOnly !== settings.wakeWordOnly) settings.wakeWordOnly = server.wakeWordOnly
      },
      onSessionsChanged: (activeId) => void sessionsChanged(activeId),
      onContext,
      onDebug: onDebugMessage,
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
    if (debugEnabled.value) session.setDebug(true)
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
  muted.value = false
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

// The Monitor tab switched off: drop what it was showing (nothing more is collected).
watch(monitorEnabled, (on) => {
  if (on) return
  frame.value = null
  upload.value = null
  requests.value = []
  lastSpeaker.value = null
})

// The Debug tab's switch: the server starts or stops sending LLM traffic on this connection.
watch(debugEnabled, (on) => transcriber?.setDebug(on))

// A phone call (docs/phone.md): this device carries the audio if it placed or answered the call, or if it's
// listening when Jarvis places one (never a call Marvin answered: the caller would hear the room).
// Meanwhile Jarvis's own mic is muted: the call isn't for Jarvis.
watch(
  () => [phone.call?.id, phone.call?.state, phone.call?.deviceJoined, phone.audioOn, phone.call?.marvin] as const,
  ([id, state, joined, audioOn, marvin]) => {
    const live = Boolean(id && state !== 'ended' && !(phone.call?.direction === 'in' && state === 'ringing') && !marvin)
    const jarvisPlaced = phone.call?.direction === 'out' && status.value === 'listening'
    if (live && !joined && !audioOn && (phone.wantAudio || jarvisPlaced)) void joinAudio()
  },
)
let mutedForCall = false
watch(
  () => phone.audioOn,
  (on) => {
    if (status.value !== 'listening' || !transcriber) return
    if (on && !muted.value) {
      mutedForCall = true
      muted.value = true
      transcriber.setMuted(true)
    } else if (!on && mutedForCall) {
      mutedForCall = false
      muted.value = false
      transcriber.setMuted(false)
    }
  },
)

function toggleMute(): void {
  if (status.value !== 'listening' || !transcriber) return
  muted.value = !muted.value
  transcriber.setMuted(muted.value)
}

/** The sessions sidebar: open or hidden. Remembered in this browser; on a narrow screen it starts hidden. */
const SIDEBAR_KEY = 'jarvis.sessionsSidebar'
const narrow = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 991.98px)').matches
function savedSidebar(): boolean {
  if (narrow()) return false
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== 'closed'
  } catch {
    return true
  }
}
const sidebarOpen = ref(savedSidebar())
watch(sidebarOpen, (open) => {
  // Only the wide layout's choice is remembered: on a phone it's a drawer you open when needed.
  if (narrow()) return
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? 'open' : 'closed')
  } catch {
    // storage blocked: not remembered
  }
})
// On a narrow screen the drawer covers the transcript: close it once a session is picked.
watch(
  () => sessions.shownId,
  () => {
    if (narrow()) sidebarOpen.value = false
  },
)

/** Stop Jarvis talking, as saying "stop" does ("continue" picks up again); a replay is cancelled. */
function stopTalking(): void {
  if (replay.key) void toggleReplay(player, replay.key, '')
  else player.stop()
}

/** Whether Jarvis is saying this live reply right now (not as a replay): its button is ■. */
function sayingNow(phrase: Phrase): boolean {
  return jarvisTalking.value && speakingReplyId.value === -phrase.id && !replay.key
}

/** The button on a live reply: ■ while it's being said, else ▶ (play it again) or ■ (stop the replay). */
function replyButton(phrase: Phrase): void {
  if (sayingNow(phrase)) stopTalking()
  else replayReply(`live-${phrase.id}`, phrase.text, -phrase.id)
}

/** The voice of the shown session's agent (undefined: the default voice). */
function sessionVoice(): string | undefined {
  const session = sessions.list.find((s) => s.id === (sessions.shownId ?? sessions.activeId))
  const agentId = (session ? session.agent : sessions.newAgent) || sessions.defaultAgent
  return sessions.agents.find((a) => a.id === agentId)?.voice
}

/** ▶ / ■ on a reply: hear it again in its agent's voice, or stop. */
function replayReply(key: string, text: string, liveReplyId?: number): void {
  toggleReplay(player, key, text, liveReplyId, sessionVoice()).catch((err: Error) => (error.value = `Couldn't replay that: ${err.message}`))
}

/** Saved messages of the session on screen, as transcript lines. */
/** Who answers in the session on screen: its agent, with its icon. */
const replyLabel = computed(() => `${agentIcon(shownAgent())} ${agentName(shownAgent())}`)

function entryBadge(entry: SessionEntry): { label: string; theme: string } {
  if (entry.kind === 'owner') return { label: 'You', theme: 'theme-primary' }
  // Replies are labelled with the session's agent (switching the agent switches who's answering).
  if (entry.kind === 'jarvis') return { label: replyLabel.value, theme: 'theme-info' }
  if (entry.kind === 'context') return { label: entry.who, theme: 'theme-secondary' }
  if (entry.kind === 'note') return { label: 'Note', theme: 'theme-warning badge-subtle' }
  if (entry.kind === 'files') return { label: 'You', theme: 'theme-primary' }
  return { label: 'Before', theme: 'theme-secondary badge-subtle' }
}

/**
 * Files dropped on the conversation (or picked with 📎): saved in the workspace,
 * added to the session as one message, and shown in the transcript. Jarvis can
 * then be asked to file them somewhere ("save that photo in photos/vacation").
 */
const dragging = ref(false)
let dragDepth = 0
const uploading = ref<{ total: number; done: number } | null>(null)
const filePicker = ref<HTMLInputElement | null>(null)
let nextFilesId = 1

const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files')

function onDragEnter(event: DragEvent): void {
  if (!hasFiles(event)) return
  dragDepth++
  dragging.value = true
}
function onDragLeave(event: DragEvent): void {
  if (!hasFiles(event)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}
function onDrop(event: DragEvent): void {
  dragDepth = 0
  dragging.value = false
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length) void addDroppedFiles(files)
}
function onPick(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (files.length) void addDroppedFiles(files)
}

async function addDroppedFiles(files: File[]): Promise<void> {
  if (uploading.value) return
  error.value = ''
  uploading.value = { total: files.length, done: 0 }
  try {
    const result = await addFiles(files, (done) => uploading.value && (uploading.value.done = done))
    // Show them in the live transcript, after what's there.
    if (!recordings.value.length) recordings.value.push([])
    const current = recordings.value.at(-1)!
    const order = Math.max(0, ...current.map((p) => p.order)) + 0.5
    current.push({ id: -1_000_000 - nextFilesId++, order, text: '', final: true, files: result.files, at: Date.now() })
    followTranscript.value = true
    // The session list (a new session may have been made by this); harmless if the live connection already said so.
    void sessionsChanged(result.activeId)
  } catch (err) {
    error.value = `Couldn't add ${files.length === 1 ? files[0]!.name : 'the files'}: ${(err as Error).message}`
  } finally {
    uploading.value = null
  }
}

// Plugin tabs hear when Jarvis talks (Read aloud pauses for it, and carries on after).
watch(playback, (state) => {
  if (state === 'playing') tellTabs('assistant-speaking')
  else if (state === 'idle') tellTabs('assistant-quiet')
})
// A plugin tab, once opened, stays alive while another tab is shown (Read aloud keeps reading).
watch(
  tab,
  (t) => {
    if (t.startsWith('plugin:')) plugins.opened[t.slice('plugin:'.length)] = true
  },
  { immediate: true },
)
// Another part of the page asked for a tab (the document viewer's Read aloud).
watch(
  () => tabRequest.n,
  () => {
    if (tabRequest.tab) tab.value = tabRequest.tab as Tab
  },
)


/** "/?view=todo.md": a tab with just that document (the viewer's ↗ button). */
const standaloneView = new URLSearchParams(location.search).get('view')
if (standaloneView) openFile(standaloneView)

/** "files__append_file" → "files: append_file". */
const toolLabel = (name: string) => name.replace('__', ': ')

// The current session survives a refresh: load it (and the list) once signed in; and the context meter.
watch(signedIn, (yes) => yes && (void loadSessions(), void loadContext()), { immediate: true })

// Another session was opened (or a new one started): the transcript starts over with its saved messages.
watch(
  () => sessions.generation,
  () => {
    if (status.value === 'idle') recordings.value = []
    else {
      // Keep the recording the live transcriber writes into, emptied.
      const live = recordings.value.at(-1)
      live?.splice(0)
      recordings.value = live ? [live] : []
    }
    void nextTick(scrollTranscriptToEnd)
  },
)

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
  <!-- "Open in a new tab": just the document. -->
  <main v-else-if="signedIn && standaloneView" class="app-standalone">
    <DocumentViewer standalone />
  </main>
  <main v-else-if="signedIn" class="app container-fluid" :class="{ 'app-fill': tab === 'live' }">
    <NotificationStack />
    <div class="app-top">
      <div class="vstack gap-3">
        <header class="d-flex align-items-center gap-3 flex-wrap">
          <h1 class="text-3xl fw-semibold m-0">Jarvis</h1>
          <span v-if="status === 'listening' && muted" class="badge theme-warning" title="The mic is open but nothing is sent. Unmute to talk again.">Muted</span>
          <span v-else-if="status === 'listening'" class="badge" :class="speaking ? 'theme-danger' : 'theme-secondary'">
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
              Talking with {{ agentName(shownAgent()) }}{{ assistant.followUpEndsAt ? ` · follow-ups ${followUpSeconds} s` : '' }}
            </span>
            <span v-else class="text-sm fg-3">Say “Jarvis” to talk to it</span>
            <button
              type="button"
              class="badge mode-toggle"
              :class="settings.wakeWordOnly >= 0.5 ? 'theme-warning' : 'theme-secondary badge-subtle'"
              :aria-pressed="settings.wakeWordOnly >= 0.5"
              :title="settings.wakeWordOnly >= 0.5 ? 'Only “Jarvis, …” is for Jarvis (no follow-ups). Click for follow-ups.' : 'Follow-ups on: after an answer, you can talk without “Jarvis”. Click for name-only (when talking with people).'"
              @click="settings.wakeWordOnly = settings.wakeWordOnly >= 0.5 ? 0 : 1"
            >
              {{ settings.wakeWordOnly >= 0.5 ? 'Name only' : 'Follow-ups on' }}
            </button>
            <span v-if="!assistant.ownerTrained" class="badge theme-warning badge-subtle" title="Train your voice on the “Your voice” tab so only you can talk to Jarvis">
              Anyone can talk to Jarvis until you train your voice
            </span>
          </template>
          <button v-for="t in timers" :key="t.id" type="button" class="badge theme-info badge-subtle font-monospace" :title="`Timer: ${t.title}. Click for the Schedule tab.`" @click="tab = 'schedule'">
            ⏱ {{ t.title }} {{ t.clock }}
          </button>
          <button v-if="ringingCount" type="button" class="badge theme-danger" title="Stop what's ringing" @click="acknowledge(null, 'dismiss')">⏰ Stop</button>
          <template v-if="phone.call && phone.call.direction === 'in' && phone.call.state === 'ringing'">
            <span class="badge theme-info">📞 {{ phone.call.name || phone.call.display }} is calling</span>
            <button type="button" class="badge theme-success" @click="answerCall">Answer</button>
            <button type="button" class="badge theme-danger badge-subtle" @click="declineCall">Decline</button>
          </template>
          <template v-else-if="phone.call && phone.call.marvin">
            <button type="button" class="badge theme-info" title="The Phone tab" @click="tab = 'phone'">📞 {{ phone.assistant }}: {{ phone.call.name || phone.call.display }} · {{ phone.call.marvin }}</button>
            <button type="button" class="badge theme-success" title="Take the call here" @click="answerCall">Pick up</button>
          </template>
          <template v-else-if="phone.call && phone.call.state !== 'ended'">
            <button type="button" class="badge theme-info" title="The Phone tab" @click="tab = 'phone'">📞 {{ phone.call.name || phone.call.display }} · {{ phone.call.state === 'active' ? 'on the call' : 'calling…' }}</button>
            <button type="button" class="badge theme-danger" @click="hangUpCall">Hang up</button>
          </template>
          <span class="ms-auto"><ContextMeter /></span>
          <button
            type="button"
            class="btn-text btn-sm settings-button"
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
          <li class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === 'tools' }" @click="tab = 'tools'">
              Tools
            </button>
          </li>
          <li class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === 'agents' }" @click="tab = 'agents'">Agents</button>
          </li>
          <li class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === 'skills' }" @click="tab = 'skills'">Skills</button>
          </li>
          <li class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === 'schedule' }" @click="tab = 'schedule'">
              Schedule<span v-if="notices.schedules.filter((s) => s.enabled && s.due).length" class="badge theme-secondary badge-subtle ms-2">{{ notices.schedules.filter((s) => s.enabled && s.due).length }}</span>
            </button>
          </li>
          <li class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === 'services' }" @click="tab = 'services'">
              Services<span v-if="servicesNeedingOwner()" class="badge theme-warning badge-subtle ms-2" title="Waiting for you: approvals or secrets">{{ servicesNeedingOwner() }}</span>
            </button>
          </li>
          <li v-for="p in plugins.list.filter((x) => x.tab)" :key="p.name" class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === `plugin:${p.name}` }" :title="statusOf(p.name)?.title || p.description" @click="tab = `plugin:${p.name}`">
              <span v-if="statusOf(p.name)?.icon || p.tab!.icon" class="tab-icon" :class="{ 'tab-icon-live': statusOf(p.name)?.animate }" aria-hidden="true">{{ statusOf(p.name)?.icon || p.tab!.icon }}</span
              >{{ p.tab!.title }}<span v-if="statusOf(p.name)?.badge" class="badge theme-info badge-subtle ms-2">{{ statusOf(p.name)!.badge }}</span
              ><span v-if="!p.connected" class="badge theme-warning badge-subtle ms-2" title="The plugin isn't running">off</span>
            </button>
          </li>
          <li v-if="phone.enabled" class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === 'phone' }" @click="tab = 'phone'">
              Phone<span v-if="phone.call" class="badge theme-info badge-subtle ms-2">on a call</span>
            </button>
          </li>
          <li class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === 'debug' }" @click="tab = 'debug'">
              Debug<span v-if="debugEnabled" class="badge theme-warning badge-subtle ms-2" title="Capturing LLM traffic">on</span>
            </button>
          </li>
          <li class="nav-item">
            <button type="button" class="nav-link" :class="{ active: tab === 'monitor' }" @click="tab = 'monitor'">
              Monitor<span v-if="monitorEnabled" class="badge theme-warning badge-subtle ms-2" title="Monitoring the microphone and the server">on</span>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <!-- Live stays mounted (v-show) so listening continues while browsing history.
         It fills the window: only the session list and the transcript scroll. -->
    <div v-show="tab === 'live'" class="live" :class="{ 'sidebar-open': sidebarOpen }">
      <aside id="sessions-sidebar" class="live-sidebar" :aria-hidden="!sidebarOpen" :inert="!sidebarOpen">
        <SessionsPanel @close="sidebarOpen = false" />
      </aside>
      <div class="live-backdrop" aria-hidden="true" @click="sidebarOpen = false"></div>

      <div class="live-main" @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
        <div v-if="dragging" class="drop-overlay" aria-hidden="true">
          <span>Drop files to add them to this conversation</span>
        </div>
        <div class="d-flex gap-3 align-items-center flex-wrap live-fixed">
          <button
            type="button"
            class="btn-outline theme-secondary btn-lg sidebar-toggle"
            :aria-expanded="sidebarOpen"
            aria-controls="sessions-sidebar"
            :title="sidebarOpen ? 'Hide sessions' : 'Show sessions'"
            :aria-label="sidebarOpen ? 'Hide sessions' : 'Show sessions'"
            @click="sidebarOpen = !sidebarOpen"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
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
            v-if="status === 'listening'"
            type="button"
            class="btn-lg"
            :class="muted ? 'btn-solid theme-warning' : 'btn-outline theme-secondary'"
            :aria-pressed="muted"
            :title="muted ? 'Start sending audio again' : 'Stop sending audio without ending the session (Jarvis keeps the conversation)'"
            @click="toggleMute"
          >
            {{ muted ? 'Unmute' : 'Mute' }}
          </button>
          <button
            v-if="jarvisTalking"
            type="button"
            class="btn-lg btn-outline theme-info"
            title="Stop Jarvis talking (say “continue” to hear the rest)"
            @click="stopTalking"
          >
            ■&#xFE0E; Stop talking
          </button>
          <!-- Who you're talking to (the session's agent); a model picker can join it here later. -->
          <AgentPicker class="ms-auto" />
        </div>

        <div v-if="error" class="alert theme-danger m-0 live-fixed" role="alert">{{ error }}</div>

        <div class="card position-relative transcript-card">
          <div ref="transcriptEl" class="card-body text-lg transcript" aria-live="polite" @scroll.passive="onTranscriptScroll">
            <!-- The session's saved messages (from its file), then what's live below. -->
            <div v-if="sessions.entries.length" class="vstack gap-2 mb-4">
              <template v-for="(entry, i) in sessions.entries" :key="i">
              <div v-if="stamps.get(`saved-${i}`)" class="chat-stamp">{{ stamps.get(`saved-${i}`) }}</div>
              <div class="d-flex gap-3 align-items-baseline">
                <span class="text-nowrap"><span class="badge" :class="entryBadge(entry).theme">{{ entryBadge(entry).label }}</span></span>
                <span class="vstack gap-1">
                  <ToolCallLine
                    v-for="(t, k) in entry.kind === 'jarvis' ? (entry.tools ?? []) : []"
                    :key="k"
                    :label="toolLabel(t.name)"
                    :call="{ id: `${i}-${k}`, name: t.name, args: t.args, result: t.result, crud: sessions.toolCrud[t.name] ?? [], status: 'done', isError: t.result.startsWith('Error:') }"
                  />
                  <FileChips v-if="entry.kind === 'files'" :files="entry.files" />
                  <div v-if="entry.kind === 'jarvis' && entry.text" class="reply fg-info">
                    <MarkdownText :text="entry.text" />
                    <button
                      type="button"
                      class="btn-text btn-sm replay-button"
                      :class="{ active: replay.key === `saved-${sessions.activeId}-${i}` }"
                      :title="replay.key === `saved-${sessions.activeId}-${i}` ? 'Stop' : 'Play this again'"
                      :aria-label="replay.key === `saved-${sessions.activeId}-${i}` ? 'Stop playing' : 'Play this reply again'"
                      @click="replayReply(`saved-${sessions.activeId}-${i}`, entry.text)"
                    >
                      <span v-if="replay.key === `saved-${sessions.activeId}-${i}` && replay.loading" class="spinner-border spinner-sm" aria-hidden="true"></span>
                      <template v-else>{{ replay.key === `saved-${sessions.activeId}-${i}` ? '■\uFE0E' : '▶\uFE0E' }}</template>
                    </button>
                  </div>
                  <span v-else-if="entry.text" class="saved-text" :class="entry.kind === 'owner' ? '' : 'fg-3'">{{ entry.text }}</span>
                </span>
              </div>
              </template>
            </div>
            <template v-for="(phrases, index) in recordings" :key="index">
              <!-- Once your voice is trained, one line per phrase with who said it; before that, flowing text. -->
              <div v-if="phrases.length && hasSpeakers" class="vstack gap-2 mb-4">
                <template v-for="phrase in phrases" :key="phrase.id">
                <div v-if="stamps.get(phrase.id)" class="chat-stamp">{{ stamps.get(phrase.id) }}</div>
                <div class="d-flex gap-3 align-items-baseline">
                  <template v-if="phrase.jarvis">
                    <span class="text-nowrap"><span class="badge theme-info">{{ replyLabel }}</span></span>
                    <span class="vstack gap-1">
                      <template v-for="(a, i) in phrase.activity ?? []" :key="i">
                        <ToolCallLine v-if="a.call" :label="a.label" :call="a.call" />
                        <span v-else class="text-sm fg-3">{{ a.emoji ?? (a.kind === 'notice' ? 'ℹ️' : '⚙️') }} {{ a.label }}</span>
                      </template>
                      <div v-if="phrase.jarvis === 'reply' && phrase.text" class="reply fg-info">
                        <MarkdownText :text="phrase.text" />
                        <button
                          v-if="phrase.final || sayingNow(phrase)"
                          type="button"
                          class="btn-text btn-sm replay-button"
                          :class="{ active: replay.key === `live-${phrase.id}` || sayingNow(phrase) }"
                          :title="sayingNow(phrase) ? 'Stop talking' : replay.key === `live-${phrase.id}` ? 'Stop' : 'Play this again'"
                          :aria-label="sayingNow(phrase) ? 'Stop talking' : replay.key === `live-${phrase.id}` ? 'Stop playing' : 'Play this reply again'"
                          @click="replyButton(phrase)"
                        >
                          <span v-if="replay.key === `live-${phrase.id}` && replay.loading" class="spinner-border spinner-sm" aria-hidden="true"></span>
                          <template v-else>{{ sayingNow(phrase) || replay.key === `live-${phrase.id}` ? '■\uFE0E' : '▶\uFE0E' }}</template>
                        </button>
                      </div>
                      <span v-else :class="phrase.jarvis === 'error' ? 'fg-danger' : 'fg-info'">{{ phrase.text || '…' }}</span>
                    </span>
                  </template>
                  <template v-else-if="phrase.files">
                    <span class="text-nowrap"><span class="badge theme-primary">You</span></span>
                    <FileChips :files="phrase.files" />
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
                </template>
              </div>
              <p v-else-if="phrases.length">
                <template v-for="phrase in phrases" :key="phrase.id">
                  <span v-if="stamps.get(phrase.id)" class="chat-stamp">{{ stamps.get(phrase.id) }}</span>
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

        <form class="vstack gap-2 live-fixed" @submit.prevent="sendDraft">
          <label for="composer" class="visually-hidden">Message to Jarvis</label>
          <div v-if="uploading" class="text-sm fg-3 d-flex align-items-center gap-2" role="status">
            <span class="spinner-border spinner-sm" aria-hidden="true"></span>
            Adding {{ uploading.total === 1 ? 'the file' : `files (${uploading.done} of ${uploading.total})` }}…
          </div>
          <div class="d-flex gap-3 align-items-end">
            <input ref="filePicker" type="file" multiple class="d-none" @change="onPick" />
            <button
              type="button"
              class="btn-outline theme-secondary attach-button"
              title="Add files to this conversation (or drop them anywhere here)"
              aria-label="Add files"
              :disabled="!!uploading"
              @click="filePicker?.click()"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
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

      <!-- The side panel: the document viewer, beside the conversation (over it on narrow screens). -->
      <aside v-if="viewer.path" class="live-viewer">
        <DocumentViewer />
      </aside>
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

    <div v-if="tab === 'tools'" class="row justify-content-center mt-5">
      <div class="col-12">
        <ToolsPanel />
      </div>
    </div>

    <div v-if="tab === 'skills'" class="row justify-content-center mt-5">
      <div class="col-12">
        <SkillsPanel />
      </div>
    </div>

    <div v-if="tab === 'schedule'" class="row justify-content-center mt-5">
      <div class="col-12">
        <SchedulePanel />
      </div>
    </div>

    <div v-if="tab === 'services'" class="row justify-content-center mt-5">
      <div class="col-12">
        <ServicesPanel />
      </div>
    </div>

    <template v-for="p in plugins.list.filter((x) => x.tab && plugins.opened[x.name])" :key="p.name">
      <div v-show="tab === `plugin:${p.name}`" class="row justify-content-center mt-4">
        <div class="col-12">
          <PluginTab :name="p.name" :url="p.tab!.url" @ask="(text) => ((draft = text), (tab = 'live'))" />
        </div>
      </div>
    </template>

    <div v-if="tab === 'phone'" class="row justify-content-center mt-5">
      <div class="col-12">
        <PhonePanel />
      </div>
    </div>

    <div v-if="tab === 'agents'" class="row justify-content-center mt-5">
      <div class="col-12">
        <AgentsPanel />
      </div>
    </div>

    <div v-if="tab === 'monitor'" class="row justify-content-center mt-5">
      <div class="col-12 vstack gap-4">
        <div class="d-flex align-items-center gap-2">
          <div class="switch">
            <input id="monitor-enabled" v-model="monitorEnabled" type="checkbox" />
          </div>
          <label for="monitor-enabled" class="fw-semibold m-0">Enable monitor</label>
        </div>
        <p class="text-sm fg-3 m-0">
          The microphone level, speech detection, what's sent to the server, the phrase in progress, the last voice match,
          and every transcription request. Nothing is collected while it's off.
        </p>
        <MonitorPanel
          v-if="monitorEnabled"
          :listening="status === 'listening' || status === 'finishing'"
          :frame="frame"
          :upload="upload"
          :phrase-state="phraseState"
          :requests="requests"
          :last-speaker="lastSpeaker"
        />
      </div>
    </div>

    <!-- v-show: keeps its open/closed state while you go back to Live and talk. -->
    <div v-show="tab === 'debug'" class="row justify-content-center mt-5">
      <div class="col-12">
        <DebugPanel :connected="status === 'listening'" />
      </div>
    </div>
  </main>
</template>

<style scoped>
/* A plugin tab's icon, before its title; pulsing gently while something is happening (reading aloud). */
.tab-icon {
  display: inline-block;
  margin-right: 0.35rem;
}
.tab-icon-live {
  animation: tab-pulse 1.8s ease-in-out infinite;
}
@keyframes tab-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.55;
    transform: scale(0.92);
  }
}
@media (prefers-reduced-motion: reduce) {
  .tab-icon-live {
    animation: none;
  }
}
/* The timestamp before a group of messages, centred, as in a texting app. */
.chat-stamp {
  display: block;
  text-align: center;
  font-size: 0.75rem;
  color: var(--bs-secondary-color, rgba(127, 127, 127, 0.8));
  margin: 0.5rem 0 0.25rem;
}
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
 * Layout. Other tabs scroll like a normal page. Live fills the window exactly
 * (no page scrollbar): the header, tabs, buttons and message box keep their
 * size, and the transcript takes whatever height is left and scrolls inside
 * itself (see followTranscript), as does the session list.
 */
.app {
  padding-block: 1.25rem;
  padding-inline: clamp(0.75rem, 2.5vw, 2.5rem);
}
.app-fill {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  gap: 1.25rem;
}
.app-top {
  flex: none;
}
.app:not(.app-fill) .app-top {
  margin-bottom: 2.5rem;
}
.live {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 1.5rem;
  position: relative;
}
.live-sidebar {
  flex: none;
  width: clamp(15rem, 22vw, 22rem);
  min-height: 0;
  display: flex;
  transition:
    margin-inline-start 0.2s ease,
    opacity 0.2s ease;
}
.live:not(.sidebar-open) .live-sidebar {
  /* Slides out of the way; the transcript takes its place. */
  margin-inline-start: calc(-1 * clamp(15rem, 22vw, 22rem) - 1.5rem);
  opacity: 0;
  pointer-events: none;
}
.live-backdrop {
  display: none;
}
.live-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.live-fixed {
  flex: none;
}
.transcript-card {
  flex: 1;
  min-height: 6rem;
}
.transcript {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.live-main {
  position: relative;
}
.live-viewer {
  flex: none;
  width: clamp(22rem, 38vw, 52rem);
  min-height: 0;
  display: flex;
}
.live-viewer > * {
  flex: 1;
}
@media (max-width: 991.98px) {
  .live-viewer {
    position: absolute;
    inset: 0;
    z-index: 25;
    width: auto;
  }
}
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--bs-primary, #0d6efd);
  border-radius: var(--bs-border-radius-lg, 0.5rem);
  background: color-mix(in srgb, var(--bs-body-bg, #fff) 85%, transparent);
  font-size: 1.25rem;
  font-weight: 600;
  pointer-events: none;
}
.attach-button {
  padding-inline: 0.625rem;
  align-self: stretch;
}
.sidebar-toggle {
  padding-inline: 0.625rem;
}
/* Narrow windows: the sidebar slides over the transcript instead of squeezing it. */
@media (max-width: 991.98px) {
  .live {
    gap: 0;
  }
  .live-sidebar {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    z-index: 20;
    width: min(20rem, 85vw);
    box-shadow: var(--bs-box-shadow-lg, 0 1rem 3rem rgba(0, 0, 0, 0.3));
    background: var(--bs-body-bg);
    border-radius: var(--bs-border-radius, 0.375rem);
  }
  .live:not(.sidebar-open) .live-sidebar {
    margin-inline-start: 0;
    transform: translateX(-110%);
  }
  .live-sidebar {
    transition:
      transform 0.2s ease,
      opacity 0.2s ease;
  }
  .live.sidebar-open .live-backdrop {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 10;
    background: rgba(0, 0, 0, 0.35);
    border-radius: var(--bs-border-radius, 0.375rem);
  }
}
@media (prefers-reduced-motion: reduce) {
  .live-sidebar {
    transition: none;
  }
}
.latest-button {
  position: absolute;
  inset-block-end: 0.75rem;
  inset-inline-end: 1rem;
  box-shadow: var(--bs-box-shadow);
}
.mode-toggle {
  border: 0;
  cursor: pointer;
}
.settings-button {
  padding-inline: 0.375rem;
}
.saved-text {
  white-space: pre-line;
}
/* A line's text column takes the rest of the row, so wide tables and code scroll inside it. */
.transcript .vstack {
  flex: 1 1 auto;
  min-width: 0;
}
/* A reply from Jarvis: formatted text, with ▶ (play it again) beside it on hover. */
.reply {
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
  min-width: 0;
}
.reply > .md {
  flex: 1 1 auto;
}
.replay-button {
  flex: none;
  min-width: 1.75rem;
  padding: 0.125rem 0.375rem;
  line-height: 1;
  font-size: 0.75rem;
  color: var(--bs-fg-3, currentColor);
}
@media (hover: hover) {
  .replay-button:not(.active) {
    opacity: 0;
    transition: opacity 0.12s;
  }
  .reply:hover .replay-button,
  .replay-button:focus-visible {
    opacity: 1;
  }
}

.phrase-editable {
  cursor: text;
  border-radius: 0.25rem;
}
.phrase-editable:hover {
  text-decoration: underline dotted;
}
</style>

<style>
/* Bootstrap reserves room for a page scrollbar; the Live tab never scrolls, so give that strip back. */
:root:has(.app-fill) {
  scrollbar-gutter: auto;
  overflow: hidden;
}
</style>
