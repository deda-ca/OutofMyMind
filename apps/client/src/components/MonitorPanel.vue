<script setup lang="ts">
import { computed } from 'vue'
import type { FrameStats, PhraseState, RequestLog, SpeakerTag, UploadStats } from '../audio/streamTranscriber'
import { settings } from '../settings'

const props = defineProps<{
  listening: boolean
  frame: FrameStats | null
  upload: UploadStats | null
  phraseState: PhraseState | null
  requests: RequestLog[]
  lastSpeaker: SpeakerTag | null
}>()

/** Similarity is roughly 0–1 (cosine); clamp for the bar. */
const voicePercent = computed(() => Math.max(0, Math.min(100, (props.lastSpeaker?.similarity ?? 0) * 100)))
const voiceIsYou = computed(() => (props.lastSpeaker?.similarity ?? -1) >= settings.speakerThreshold)

/** Map -70…0 dBFS onto 0…100 %. */
const levelPercent = computed(() => {
  const db = props.frame?.levelDb ?? -100
  return Math.max(0, Math.min(100, ((db + 70) / 70) * 100))
})
const probabilityPercent = computed(() => (props.frame?.probability ?? 0) * 100)
const isSpeech = computed(() => (props.frame?.probability ?? 0) >= settings.speechThreshold)
const pausePercent = computed(() => Math.min(100, ((props.phraseState?.silenceMs ?? 0) / settings.pauseMs) * 100))

const uploaded = computed(() => {
  const u = props.upload
  if (!u || u.framesTotal === 0) return null
  return {
    kb: (u.bytesSent / 1024).toFixed(0),
    percent: Math.round((u.framesSent / u.framesTotal) * 100),
    heardSeconds: ((u.framesTotal * 32) / 1000).toFixed(0),
  }
})

const state = computed(() => {
  const f = props.phraseState
  if (!props.listening || !props.frame) return { label: 'Not listening', theme: 'theme-secondary' }
  if (!f) return { label: 'Waiting for speech', theme: 'theme-secondary' }
  if (!f.inPhrase) return { label: 'Waiting for speech', theme: 'theme-secondary' }
  if (f.silenceMs > 0) return { label: 'Paused — phrase will end soon', theme: 'theme-warning' }
  return { label: 'Speaking', theme: 'theme-success' }
})

function stats(kind: RequestLog['kind']) {
  const done = props.requests.filter((r) => r.kind === kind && r.status !== 'error')
  if (done.length === 0) return '–'
  const avg = done.reduce((sum, r) => sum + r.latencyMs, 0) / done.length
  return `${Math.round(avg)} ms avg`
}
const counts = computed(() => ({
  partial: props.requests.filter((r) => r.kind === 'partial').length,
  final: props.requests.filter((r) => r.kind === 'final').length,
  errors: props.requests.filter((r) => r.status === 'error').length,
  stale: props.requests.filter((r) => r.status === 'stale').length,
}))

const STATUS_THEMES: Record<RequestLog['status'], string> = {
  ok: 'theme-success',
  stale: 'theme-secondary',
  dropped: 'theme-warning',
  error: 'theme-danger',
}

const recent = computed(() => props.requests.slice(-15).reverse())

// Bars update ~30 times a second; Bootstrap's width animation would lag behind.
const instant = '--bs-progress-bar-transition: none'
</script>

<template>
  <div class="card">
    <div class="card-header">
      <div class="d-flex align-items-center gap-3 w-100">
        <span class="fw-semibold">Monitor</span>
        <span class="badge" :class="state.theme">{{ state.label }}</span>
      </div>
    </div>
    <div id="monitor-details" class="card-body vstack gap-4">
      <div>
        <div class="d-flex justify-content-between text-sm mb-1">
          <span>Microphone level</span>
          <span class="font-monospace">{{ frame ? `${frame.levelDb.toFixed(0)} dB` : '–' }}</span>
        </div>
        <div class="progress" role="progressbar" aria-label="Microphone level" :style="instant">
          <div class="progress-bar theme-info" :style="{ width: `${levelPercent}%` }"></div>
        </div>
      </div>

      <div>
        <div class="d-flex justify-content-between text-sm mb-1">
          <span>Speech probability <span class="fg-3">(threshold {{ settings.speechThreshold.toFixed(2) }})</span></span>
          <span class="font-monospace">{{ frame ? frame.probability.toFixed(2) : '–' }}</span>
        </div>
        <div class="progress" role="progressbar" aria-label="Speech probability" :style="instant">
          <div
            class="progress-bar"
            :class="isSpeech ? 'theme-success' : 'theme-secondary'"
            :style="{ width: `${probabilityPercent}%` }"
          ></div>
        </div>
      </div>

      <div>
        <div class="d-flex justify-content-between text-sm mb-1">
          <span>Pause timer <span class="fg-3">(server ends the phrase when full)</span></span>
          <span class="font-monospace">
            {{ ((phraseState?.silenceMs ?? 0) / 1000).toFixed(1) }} / {{ (settings.pauseMs / 1000).toFixed(1) }} s
          </span>
        </div>
        <div class="progress" role="progressbar" aria-label="Pause timer" :style="instant">
          <div class="progress-bar theme-warning" :style="{ width: `${pausePercent}%` }"></div>
        </div>
      </div>

      <div>
        <div class="d-flex justify-content-between text-sm mb-1">
          <span>
            Voice match, last phrase <span class="fg-3">(you at ≥ {{ settings.speakerThreshold.toFixed(2) }})</span>
          </span>
          <span class="font-monospace">
            {{ lastSpeaker?.similarity != null ? lastSpeaker.similarity.toFixed(2) : lastSpeaker ? 'voice not trained' : '–' }}
          </span>
        </div>
        <div class="progress" role="progressbar" aria-label="Voice match" :style="instant">
          <div
            class="progress-bar"
            :class="voiceIsYou ? 'theme-primary' : 'theme-secondary'"
            :style="{ width: `${voicePercent}%` }"
          ></div>
        </div>
      </div>

      <div class="row text-sm gy-2">
        <div class="col-6">
          Current phrase:
          <span class="font-monospace">{{ phraseState?.inPhrase ? `${(phraseState.phraseMs / 1000).toFixed(1)} s` : '–' }}</span>
        </div>
        <div class="col-6">
          Speech in it:
          <span class="font-monospace">{{ phraseState?.inPhrase ? `${(phraseState.speechMs / 1000).toFixed(1)} s` : '–' }}</span>
        </div>
        <div class="col-6">
          Live updates: <span class="font-monospace">{{ counts.partial }}</span>{{ ' ' }}
          <span class="fg-3">({{ stats('partial') }})</span>
        </div>
        <div class="col-6">
          Finals: <span class="font-monospace">{{ counts.final }}</span>{{ ' ' }}
          <span class="fg-3">({{ stats('final') }})</span>
        </div>
        <div class="col-12">
          Uploaded:
          <span class="font-monospace">{{ uploaded ? `${uploaded.kb} KB` : '–' }}</span>{{ ' ' }}
          <span v-if="uploaded" class="fg-3">
            ({{ uploaded.percent }}% of the {{ uploaded.heardSeconds }} s the mic heard; silence isn’t sent)
          </span>
          {{ ' ' }}<span v-if="frame?.sent" class="badge theme-info">sending</span>
        </div>
        <div class="col-6">
          Superseded: <span class="font-monospace">{{ counts.stale }}</span>
        </div>
        <div class="col-6">
          Errors: <span class="font-monospace" :class="{ 'fg-danger': counts.errors }">{{ counts.errors }}</span>
        </div>
      </div>

      <div>
        <div class="text-sm fw-semibold mb-2">Recent transcriptions (server → audio.cpp)</div>
        <p v-if="recent.length === 0" class="text-sm fg-3 m-0">None yet.</p>
        <div v-else class="table-responsive">
          <table class="table table-sm text-sm m-0">
            <thead>
              <tr>
                <th>#</th>
                <th>Phrase</th>
                <th>Type</th>
                <th class="text-end">Audio</th>
                <th class="text-end">Took</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in recent" :key="r.seq">
                <td class="font-monospace">{{ r.seq }}</td>
                <td class="font-monospace">{{ r.phraseId }}</td>
                <td>{{ r.kind === 'final' ? 'Final' : 'Live' }}</td>
                <td class="text-end font-monospace text-nowrap">{{ (r.audioMs / 1000).toFixed(1) }} s</td>
                <td class="text-end font-monospace text-nowrap">{{ Math.round(r.latencyMs) }} ms</td>
                <td>
                  <span class="badge" :class="STATUS_THEMES[r.status]">{{ r.status }}</span>
                  {{ ' ' }}<span :class="{ 'fg-3': r.status !== 'ok' }">{{ r.text }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
