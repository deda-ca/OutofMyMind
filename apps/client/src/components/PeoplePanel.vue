<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

interface Person {
  id: number
  name: string
  named: boolean
  isOwner: boolean
  clips: number
  phrases: number
  lastHeardAt: string | null
  maybeSameAs: { id: number; name: string; similarity: number }[]
}

interface Clip {
  phraseId: number
  device: string | null
  addedAt: string
  text: string
}

interface RecentSpeaker {
  id: number
  name: string
  isOwner: boolean
  lastHeardAt: string
  phrases: { text: string }[]
}

const people = ref<Person[]>([])
const recent = ref<RecentSpeaker[]>([])
const clips = reactive<Record<number, Clip[]>>({})
const open = reactive<Record<number, boolean>>({})
const nameDraft = reactive<Record<number, string>>({})
const mergeTarget = reactive<Record<number, string>>({})
const error = ref('')
const notice = ref('')
const busy = ref(false)

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

async function load(): Promise<void> {
  try {
    const [p, r] = await Promise.all([
      api<{ people: Person[] }>('/api/people'),
      api<{ speakers: RecentSpeaker[] }>('/api/speakers/recent?minutes=10'),
    ])
    people.value = p.people
    recent.value = r.speakers.filter((s) => !s.isOwner)
    for (const person of p.people) if (open[person.id]) void loadClips(person.id)
  } catch (err) {
    error.value = `Could not load people: ${(err as Error).message}`
  }
}

async function loadClips(id: number): Promise<void> {
  clips[id] = (await api<{ clips: Clip[] }>(`/api/people/${id}/clips`)).clips
}

function toggle(person: Person): void {
  open[person.id] = !open[person.id]
  if (open[person.id]) void loadClips(person.id)
}

async function act(what: () => Promise<unknown>, done: string): Promise<void> {
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    await what()
    notice.value = done
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

function rename(person: Person): void {
  const name = (nameDraft[person.id] ?? '').trim()
  if (!name) return
  void act(async () => {
    await api(`/api/people/${person.id}/name`, json('PUT', { name }))
    nameDraft[person.id] = ''
  }, `${person.name} is now “${name}”. If someone already had that name, they were combined.`)
}

function merge(person: Person, intoId: number): void {
  const into = people.value.find((p) => p.id === intoId)
  if (!into || !confirm(`Combine ${person.name} into ${into.name}? All of ${person.name}'s phrases and clips move to ${into.name}.`)) return
  void act(() => api(`/api/people/${person.id}/merge`, json('POST', { into: intoId })), `${person.name} combined into ${into.name}.`)
}

function forget(person: Person): void {
  if (!confirm(`Forget ${person.name}? Their voice clips are removed and their phrases become unknown.`)) return
  const deleteAudio = confirm(`Also delete the audio of ${person.name}'s ${person.phrases} phrase(s)? Transcripts stay. This can't be undone.`)
  void act(() => api(`/api/people/${person.id}?deleteAudio=${deleteAudio}`, { method: 'DELETE' }), `${person.name} forgotten.`)
}

function backfill(): void {
  void act(async () => {
    const r = await api<{ processed: number; owner: number; others: number; unknown: number; failed: number }>('/api/speakers/backfill', {
      method: 'POST',
    })
    notice.value = `Tagged ${r.processed} older phrase(s): ${r.owner} yours, ${r.others} other people, ${r.unknown} unclear${r.failed ? `, ${r.failed} failed` : ''}.`
  }, '')
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never'

onMounted(load)
</script>

<template>
  <div class="vstack gap-5">
    <div class="d-flex align-items-center gap-3 flex-wrap">
      <span class="text-sm fg-3">
        Voices Jarvis has heard. New voices get a label like “Speaker A”; give them a name and Jarvis recognises them
        from then on.
      </span>
      <button type="button" class="btn-outline theme-secondary btn-sm ms-auto" :disabled="busy" @click="load">Refresh</button>
      <button type="button" class="btn-outline theme-secondary btn-sm" :disabled="busy" title="Give recordings made before speaker recognition a voiceprint and a speaker" @click="backfill">
        Tag older recordings
      </button>
    </div>

    <div v-if="error" class="alert theme-danger" role="alert">{{ error }}</div>
    <div v-if="notice" class="alert theme-success" role="status">{{ notice }}</div>

    <div v-if="recent.length" class="card">
      <div class="card-header"><span class="fw-semibold">Heard in the last 10 minutes</span></div>
      <ul class="list-group list-group-flush">
        <li v-for="s in recent" :key="s.id" class="list-group-item d-flex gap-3 align-items-baseline">
          <span class="badge" :class="people.find((p) => p.id === s.id)?.named ? 'theme-success' : 'theme-secondary'">{{ s.name }}</span>
          <span class="flex-grow-1 text-truncate fg-3">“{{ s.phrases[0]?.text }}”</span>
          <span class="text-sm fg-3 text-nowrap">{{ when(s.lastHeardAt) }}</span>
        </li>
      </ul>
    </div>

    <p v-if="!people.length" class="fg-3 m-0">Nobody yet. Train your voice on the “Your voice” tab, then talk with someone.</p>

    <div v-for="person in people" :key="person.id" class="card">
      <div class="card-header">
        <div class="d-flex align-items-center gap-3 flex-wrap w-100">
          <button type="button" class="btn-text" :aria-expanded="!!open[person.id]" @click="toggle(person)">
            {{ open[person.id] ? '▾' : '▸' }}
            <span class="badge" :class="person.isOwner ? 'theme-primary' : person.named ? 'theme-success' : 'theme-secondary'">{{ person.name }}</span>
          </button>
          <span class="text-sm fg-3">
            {{ person.phrases }} phrase{{ person.phrases === 1 ? '' : 's' }} · {{ person.clips }} voice clip{{ person.clips === 1 ? '' : 's' }} · last heard
            {{ when(person.lastHeardAt) }}
          </span>
          <span v-if="!person.named" class="badge theme-warning badge-subtle">not named yet</span>
        </div>
      </div>

      <div v-if="person.maybeSameAs.length && !person.isOwner" class="card-body py-3 vstack gap-2">
        <div v-for="m in person.maybeSameAs.slice(0, 3)" :key="m.id" class="d-flex align-items-center gap-3 text-sm">
          <span>Might be the same person as <strong>{{ m.name }}</strong> <span class="fg-3">(similarity {{ m.similarity.toFixed(2) }})</span></span>
          <button type="button" class="btn-outline theme-secondary btn-sm" :disabled="busy" @click="merge(person, m.id)">Combine</button>
        </div>
      </div>

      <div v-if="open[person.id]" class="card-body vstack gap-4">
        <div v-if="!person.isOwner" class="d-flex gap-3 flex-wrap align-items-end">
          <div class="vstack gap-1">
            <label :for="`name-${person.id}`" class="form-label m-0 text-sm">Name</label>
            <input
              :id="`name-${person.id}`"
              v-model="nameDraft[person.id]"
              class="form-control form-control-sm"
              :placeholder="person.named ? person.name : 'e.g. Maria'"
              @keydown.enter="rename(person)"
            />
          </div>
          <button type="button" class="btn-solid theme-primary btn-sm" :disabled="busy || !nameDraft[person.id]?.trim()" @click="rename(person)">
            {{ person.named ? 'Rename' : 'Name' }}
          </button>

          <div class="vstack gap-1 ms-auto">
            <label :for="`merge-${person.id}`" class="form-label m-0 text-sm">Same person as…</label>
            <select :id="`merge-${person.id}`" v-model="mergeTarget[person.id]" class="form-control form-control-sm">
              <option value="">Choose</option>
              <option v-for="other in people.filter((p) => p.id !== person.id)" :key="other.id" :value="other.id">{{ other.name }}</option>
            </select>
          </div>
          <button type="button" class="btn-outline theme-secondary btn-sm" :disabled="busy || !mergeTarget[person.id]" @click="merge(person, Number(mergeTarget[person.id]))">
            Combine
          </button>
          <button type="button" class="btn-outline theme-danger btn-sm" :disabled="busy" @click="forget(person)">Forget</button>
        </div>
        <p v-else class="m-0 text-sm fg-3">This is you. Manage your clips on the “Your voice” tab.</p>

        <div>
          <div class="text-sm fw-semibold mb-2">Voice clips Jarvis matches against</div>
          <p v-if="!clips[person.id]?.length" class="text-sm fg-3 m-0">None.</p>
          <ul v-else class="list-group">
            <li v-for="clip in clips[person.id]!.slice(-5).reverse()" :key="clip.phraseId" class="list-group-item vstack gap-2">
              <div class="d-flex gap-3 align-items-baseline">
                <span class="flex-grow-1">{{ clip.text }}</span>
                <span class="badge theme-secondary">{{ clip.device ?? 'unknown' }}</span>
                <span class="text-sm fg-3 text-nowrap">{{ when(clip.addedAt) }}</span>
              </div>
              <audio class="w-100" controls preload="none" :src="`/api/phrases/${clip.phraseId}/audio`"></audio>
            </li>
          </ul>
          <p v-if="(clips[person.id]?.length ?? 0) > 5" class="text-sm fg-3 mt-2 mb-0">Showing the latest 5 of {{ clips[person.id]!.length }}.</p>
        </div>
      </div>
    </div>
  </div>
</template>
