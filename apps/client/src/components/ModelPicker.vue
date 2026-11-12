<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { loadLlm, sessions, setModel, shownAgent, shownModel } from '../sessions'

// Which LLM this session thinks with, in the chat beside the agent picker:
// the agent's own model unless another is picked here (for this session only).

const model = computed(() => shownModel())
/** The agent's model (or the default), shown as the first choice. */
const agentModel = computed(() => sessions.agents.find((a) => a.id === (shownAgent() || sessions.defaultAgent))?.model || sessions.llm.default)
/** The session's model, if no connection offers it any more (so it's shown). */
const missing = computed(() => (model.value && !sessions.llm.connections.some((c) => c.models.some((m) => `${c.id}/${m}` === model.value)) ? model.value : ''))
const busy = ref(false)
/** Only worth showing when there's a choice. */
const choices = computed(() => sessions.llm.connections.reduce((n, c) => n + c.models.length, 0))

async function choose(event: Event): Promise<void> {
  busy.value = true
  try {
    await setModel((event.target as HTMLSelectElement).value)
  } finally {
    busy.value = false
  }
}

onMounted(loadLlm)
</script>

<template>
  <label v-if="choices > 1 || model" class="model-picker d-flex align-items-center m-0" title="The LLM this session uses: the agent's unless you pick another here (this session only).">
    <select class="form-control model-picker-select" :value="model" :disabled="busy" aria-label="Model" @focus="loadLlm" @change="choose">
      <option value="">🧠 {{ agentModel || 'Agent\'s model' }} (agent's)</option>
      <optgroup v-for="c in sessions.llm.connections" :key="c.id" :label="c.label">
        <option v-for="m in c.models" :key="m" :value="`${c.id}/${m}`">{{ sessions.llm.connections.length > 1 ? `${c.label} · ${m}` : m }}</option>
      </optgroup>
      <option v-if="missing" :value="missing">{{ missing }} (not in config.jsonc)</option>
    </select>
  </label>
</template>

<style scoped>
.model-picker-select {
  width: auto;
  max-width: 14rem;
}
</style>
