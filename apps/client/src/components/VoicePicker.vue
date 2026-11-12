<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { sessions, setVoice, shownAgent, shownVoice } from '../sessions'

// Which voice Jarvis speaks in, in this session: the agent's unless another is
// picked here. The choices are the voices of the agent's speech model.

const voice = computed(() => shownVoice())
const agent = computed(() => sessions.agents.find((a) => a.id === (shownAgent() || sessions.defaultAgent)))
const voices = ref<string[]>([])
/** Jarvis's own voice (audio.ttsVoice): what an agent without a voice speaks in. */
const jarvis = ref('')
const busy = ref(false)

/** The voices of the agent's speech model (re-read when the agent changes). */
async function load(): Promise<void> {
  const model = agent.value?.speech
  try {
    const r = await fetch(`/api/tts/voices${model ? `?model=${encodeURIComponent(model)}` : ''}`)
    if (!r.ok) return
    const body = (await r.json()) as { voices: string[]; jarvis: string }
    voices.value = body.voices
    jarvis.value = body.jarvis
  } catch {
    // the picker just keeps what it had
  }
}
watch(() => agent.value?.speech, () => void load(), { immediate: true })

const agentVoice = computed(() => agent.value?.voice || jarvis.value)

async function choose(event: Event): Promise<void> {
  busy.value = true
  try {
    await setVoice((event.target as HTMLSelectElement).value)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <label v-if="voices.length > 1 || voice" class="voice-picker d-flex align-items-center m-0" title="The voice Jarvis speaks in, in this session: the agent's unless you pick another here (this session only).">
    <select class="form-control voice-picker-select" :value="voice" :disabled="busy" aria-label="Voice" @focus="load" @change="choose">
      <option value="">🔊 {{ agentVoice || 'Agent\'s voice' }} (agent's)</option>
      <option v-for="v in voices" :key="v" :value="v">{{ v }}</option>
      <option v-if="voice && !voices.includes(voice)" :value="voice">{{ voice }} (this speech model doesn't have it)</option>
    </select>
  </label>
</template>

<style scoped>
.voice-picker-select {
  width: auto;
  max-width: 12rem;
}
</style>
