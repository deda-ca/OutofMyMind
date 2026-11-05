<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw } from 'vue'
import { StreamTranscriber, type EnrollClipResult } from '../audio/streamTranscriber'
import { settings } from '../settings'

const props = defineProps<{
  /** The Live tab is using the microphone. */
  liveBusy: boolean
}>()

interface OwnerClip {
  phraseId: number
  device: string | null
  addedAt: string
  text: string
  durationMs: number
}

/** Short, varied sentences: different sounds, natural to say aloud. */
const PROMPTS = [
  'The quick brown fox jumps over the lazy dog near the riverbank.',
  'Could you remind me to call the dentist tomorrow morning at nine?',
  'I think we should leave early, before the traffic gets really bad.',
  'She sells seashells by the seashore every summer afternoon.',
  'What is the weather going to be like this weekend in Ottawa?',
  'Please add milk, eggs, bread and a bag of coffee to the shopping list.',
  'My favourite way to relax is a long walk followed by a good book.',
  'Turn the music down a little and dim the lights in the living room.',
]
const RECOMMENDED_CLIPS = PROMPTS.length

const enabled = ref<boolean | null>(null)
const clips = ref<OwnerClip[]>([])
const error = ref('')

const training = ref<'idle' | 'starting' | 'listening' | 'finishing'>('idle')
const promptIndex = ref(0)
const heard = ref('')
const lastResult = ref<EnrollClipResult | null>(null)
let session: StreamTranscriber | undefined

const devices = computed(() => {
  const counts = new Map<string, number>()
  for (const c of clips.value) counts.set(c.device ?? 'unknown', (counts.get(c.device ?? 'unknown') ?? 0) + 1)
  return [...counts].map(([device, count]) => ({ device, count }))
})

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

async function load(): Promise<void> {
  try {
    const owner = await api<{ enabled: boolean; clips: OwnerClip[] }>('/api/owner')
    enabled.value = owner.enabled
    clips.value = owner.clips
  } catch (err) {
    error.value = `Could not load your voice profile: ${(err as Error).message}`
  }
}

async function startTraining(): Promise<void> {
  error.value = ''
  lastResult.value = null
  heard.value = ''
  promptIndex.value = 0
  training.value = 'starting'
  session = new StreamTranscriber(
    { language: 'English', settings: { ...toRaw(settings) }, mode: 'enroll' },
    {
      onPhrase: (_id, text) => (heard.value = text),
      onPhraseDropped: () => {},
      onError: (message) => (error.value = message),
      onEnrollClip: (result) => {
        lastResult.value = result
        heard.value = ''
        if (result.accepted) {
          promptIndex.value++
          void load()
          if (promptIndex.value >= PROMPTS.length) void stopTraining()
        }
      },
    },
  )
  try {
    await session.start()
    training.value = 'listening'
  } catch (err) {
    session.cancel()
    session = undefined
    training.value = 'idle'
    error.value =
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it in the browser and try again.'
        : (err as Error).message
  }
}

async function stopTraining(): Promise<void> {
  if (!session || training.value !== 'listening') return
  training.value = 'finishing'
  await session.stop()
  session = undefined
  training.value = 'idle'
  await load()
}

async function removeClip(clip: OwnerClip): Promise<void> {
  try {
    await api(`/api/owner/clips/${clip.phraseId}`, { method: 'DELETE' })
    await load()
  } catch (err) {
    error.value = `Could not remove the clip: ${(err as Error).message}`
  }
}

async function resetProfile(): Promise<void> {
  if (!confirm('Remove all clips from your voice profile? The recordings stay in History.')) return
  try {
    await api('/api/owner/clips', { method: 'DELETE' })
    await load()
  } catch (err) {
    error.value = `Could not reset: ${(err as Error).message}`
  }
}

const dateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

onMounted(load)
onBeforeUnmount(() => session?.cancel())
</script>

<template>
  <div class="vstack gap-5">
    <div v-if="enabled === false" class="alert theme-warning" role="alert">
      Speaker recognition is off on the server: the voiceprint model is missing. Run
      <code>npm run fetch-models</code> in <code>apps/server</code> and restart it.
    </div>
    <div v-if="error" class="alert theme-danger" role="alert">{{ error }}</div>

    <div class="card">
      <div class="card-header">
        <div class="d-flex align-items-center justify-content-between gap-3 w-100">
          <span class="fw-semibold">Train your voice</span>
          <span class="text-sm fg-3">
            {{ clips.length }} clip{{ clips.length === 1 ? '' : 's' }}
            <template v-if="devices.length">
              ({{ devices.map((d) => `${d.count} on ${d.device}`).join(', ') }})
            </template>
          </span>
        </div>
      </div>
      <div class="card-body vstack gap-4">
        <p class="m-0">
          Read a few sentences aloud in your normal voice, so Jarvis can tell your phrases apart from everyone
          else's. Do this once on each device you use (computer, phone, headset): each microphone sounds different.
          Somewhere quiet is best.
        </p>

        <div v-if="training === 'idle' || training === 'starting'" class="d-flex gap-3 align-items-center">
          <button
            type="button"
            class="btn-solid theme-primary btn-lg"
            :disabled="!enabled || props.liveBusy || training === 'starting'"
            @click="startTraining"
          >
            <span v-if="training === 'starting'" class="spinner-border spinner-sm" aria-hidden="true"></span>
            {{ clips.length ? 'Record more clips' : 'Start training' }}
          </button>
          <span v-if="props.liveBusy" class="text-sm fg-3">Stop listening on the Live tab first.</span>
          <span v-else-if="clips.length >= RECOMMENDED_CLIPS" class="text-sm fg-3">
            You have enough clips on these devices. Add more on a new device, or if recognition misses you.
          </span>
        </div>

        <template v-else>
          <div class="card">
            <div class="card-body vstack gap-3">
              <span class="text-sm fg-3">Sentence {{ Math.min(promptIndex + 1, PROMPTS.length) }} of {{ PROMPTS.length }}. Read it aloud, then pause.</span>
              <p class="text-2xl fw-semibold m-0">{{ PROMPTS[Math.min(promptIndex, PROMPTS.length - 1)] }}</p>
              <p class="m-0 fg-3">{{ heard ? `Heard: ${heard}` : 'Listening…' }}</p>
            </div>
          </div>
          <div v-if="lastResult" class="alert" :class="lastResult.accepted ? 'theme-success' : 'theme-warning'" role="status">
            <template v-if="lastResult.accepted">Got it. “{{ lastResult.text }}”</template>
            <template v-else>Not saved: {{ lastResult.reason }} Please read it again.</template>
          </div>
          <div>
            <button type="button" class="btn-outline theme-secondary" :disabled="training === 'finishing'" @click="stopTraining">
              {{ training === 'finishing' ? 'Finishing…' : 'Done' }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="d-flex align-items-center justify-content-between gap-3 w-100">
          <span class="fw-semibold">Your voice clips</span>
          <button type="button" class="btn-outline theme-danger btn-sm" :disabled="!clips.length" @click="resetProfile">
            Reset voice profile
          </button>
        </div>
      </div>
      <p v-if="!clips.length" class="card-body m-0 fg-3">No clips yet.</p>
      <ul v-else class="list-group list-group-flush">
        <li v-for="clip in clips" :key="clip.phraseId" class="list-group-item">
          <div class="d-flex align-items-start gap-3">
            <div class="flex-grow-1 vstack gap-2">
              <span>{{ clip.text }}</span>
              <audio class="w-100" controls preload="none" :src="`/api/phrases/${clip.phraseId}/audio`"></audio>
            </div>
            <span class="badge theme-secondary">{{ clip.device ?? 'unknown' }}</span>
            <span class="text-sm fg-3 text-nowrap">{{ dateTime(clip.addedAt) }}</span>
            <button type="button" class="btn-text btn-sm" title="Remove from your voice profile" @click="removeClip(clip)">
              Remove
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
