<script setup lang="ts">
import { computed, ref } from 'vue'
import { agentIcon, agentName, loadAgents, sessions, setAgent, shownAgent } from '../sessions'

// Who you're talking to, in the chat itself: the agent of the session on
// screen (or of the new one about to start). Picking another switches the
// session to it from the next message; saying its name does the same.

/** '' = the default agent (follows whichever agent is the default). */
const agentId = computed(() => shownAgent())
const info = computed(() => sessions.agents.find((a) => a.id === (agentId.value || sessions.defaultAgent)))
const busy = ref(false)

const hint = computed(() => {
  const a = info.value
  if (!a) return 'Who Jarvis is in this session'
  const tools = a.tools === null ? 'every tool' : a.tools.length ? `tools: ${a.tools.join(', ')}` : 'no tools'
  return `${a.description || a.name} · ${tools}. Pick another, or say its name ("${a.name}, …"), to switch.`
})

async function choose(event: Event): Promise<void> {
  busy.value = true
  try {
    await setAgent((event.target as HTMLSelectElement).value)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <label class="agent-picker d-flex align-items-center gap-2 m-0" :title="hint">
    <select class="form-control agent-picker-select" :value="agentId" :disabled="busy" aria-label="Agent" @focus="loadAgents" @change="choose">
      <option value="">{{ agentIcon('') }} {{ agentName('') }} (default)</option>
      <option v-for="a in sessions.agents" :key="a.id" :value="a.id">{{ a.icon || '🤖' }} {{ a.name }}</option>
      <option v-if="agentId && !sessions.agents.some((a) => a.id === agentId)" :value="agentId">{{ agentId }} (deleted: uses the default)</option>
    </select>
  </label>
</template>

<style scoped>
.agent-picker-select {
  width: auto;
  max-width: 14rem;
}
</style>
