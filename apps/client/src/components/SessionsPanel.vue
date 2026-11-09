<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { agentName, deleteSession, loadAgents, newSession, openSession, pinSession, renameSession, sessionLabel, sessions, setAgent, shownAgent, type SessionSummary } from '../sessions'

// The session list in the Live sidebar: open, rename, pin, delete, new, and
// which agent the session on screen talks with. It fills the sidebar's height;
// the list scrolls inside it.

const emit = defineEmits<{ close: [] }>()

/** '' = the default agent (follows whichever agent is the default). */
const agentId = computed(() => shownAgent())
const agentInfo = computed(() => sessions.agents.find((a) => a.id === (agentId.value || sessions.defaultAgent)))

function chooseAgent(event: Event): void {
  void run(() => setAgent((event.target as HTMLSelectElement).value))
}

const renaming = ref<string | null>(null)
const draft = ref('')
const renameInput = ref<HTMLInputElement[] | null>(null)
const busy = ref(false)

async function run(what: () => Promise<void>): Promise<void> {
  busy.value = true
  try {
    await what()
  } finally {
    busy.value = false
  }
}

async function startRename(s: SessionSummary): Promise<void> {
  renaming.value = s.id
  draft.value = s.title || sessionLabel(s)
  await nextTick()
  renameInput.value?.[0]?.select()
}

function finishRename(s: SessionSummary): void {
  if (renaming.value !== s.id) return
  renaming.value = null
  const title = draft.value.trim()
  if (title && title !== s.title) void run(() => renameSession(s.id, title))
}

function remove(s: SessionSummary): void {
  if (!confirm(`Delete “${sessionLabel(s)}”? Its file is removed from the workspace. This can't be undone.`)) return
  void run(() => deleteSession(s.id))
}

function when(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="card sessions">
    <div class="card-header">
      <div class="d-flex align-items-center gap-2 w-100">
        <span class="fw-semibold">Sessions</span>
        <button type="button" class="btn-outline theme-primary btn-sm ms-auto" :disabled="busy || sessions.shownId === null" title="Start a new session (or say “Jarvis, new session”)" @click="run(newSession)">
          + New
        </button>
        <button type="button" class="btn-text btn-sm" title="Hide sessions" aria-label="Hide sessions" @click="emit('close')">«</button>
      </div>
    </div>

    <div class="card-body py-3 vstack gap-1 border-bottom">
      <label for="session-agent" class="form-label m-0 text-sm fw-semibold">Agent</label>
      <select
        id="session-agent"
        class="form-control form-control-sm"
        :value="agentId"
        :disabled="busy"
        title="Who Jarvis is in this session: its instructions and tools (WORKSPACE_DIR/agents)"
        @focus="loadAgents"
        @change="chooseAgent"
      >
        <option value="">Default ({{ agentName('') }})</option>
        <option v-for="a in sessions.agents" :key="a.id" :value="a.id">{{ a.name }}</option>
        <option v-if="agentId && !sessions.agents.some((a) => a.id === agentId)" :value="agentId">{{ agentId }} (deleted: uses the default)</option>
      </select>
      <span v-if="agentInfo" class="text-sm fg-3">
        {{ agentInfo.description || 'No description.' }}
        <template v-if="agentInfo.tools !== null"> · {{ agentInfo.tools.length ? `tools: ${agentInfo.tools.join(', ')}` : 'no tools' }}</template>
      </span>
    </div>

    <div v-if="sessions.error" class="card-body py-2 text-sm fg-danger">{{ sessions.error }}</div>

    <ul class="list-group list-group-flush session-list">
      <li v-if="sessions.shownId === null" class="list-group-item session active-session">
        <span class="fw-semibold">New session</span>
        <span class="text-sm fg-3 d-block">Saved with its first message.</span>
      </li>

      <li
        v-for="s in sessions.list"
        :key="s.id"
        class="list-group-item session"
        :class="{ 'active-session': s.id === sessions.shownId }"
      >
        <div class="d-flex align-items-start gap-2">
          <input
            v-if="renaming === s.id"
            ref="renameInput"
            v-model="draft"
            class="form-control form-control-sm"
            maxlength="120"
            aria-label="Session name"
            @keydown.enter.prevent="finishRename(s)"
            @keydown.esc.prevent="renaming = null"
            @blur="finishRename(s)"
          />
          <button
            v-else
            type="button"
            class="session-open text-start flex-grow-1"
            :aria-current="s.id === sessions.shownId ? 'true' : undefined"
            :disabled="busy"
            @click="s.id !== sessions.shownId && run(() => openSession(s.id))"
          >
            <span class="d-block text-truncate" :class="{ 'fst-italic': !s.title }">{{ sessionLabel(s) }}</span>
            <span class="d-block text-sm fg-3">
              {{ when(s.updated) }} · {{ s.messages }} message{{ s.messages === 1 ? '' : 's' }}<template v-if="s.agent"> · {{ agentName(s.agent) }}</template>
            </span>
          </button>
          <div v-if="renaming !== s.id" class="d-flex gap-1 session-actions">
            <button
              type="button"
              class="btn-text btn-sm"
              :class="{ pinned: s.pinned }"
              :aria-pressed="s.pinned"
              :title="s.pinned ? 'Unpin' : 'Pin to the top'"
              :aria-label="s.pinned ? 'Unpin' : 'Pin'"
              :disabled="busy"
              @click="run(() => pinSession(s.id, !s.pinned))"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" :fill="s.pinned ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 17v5M9 10.76V6h6v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76zM8 6h8M9 2h6" />
              </svg>
            </button>
            <button type="button" class="btn-text btn-sm" title="Rename" aria-label="Rename" :disabled="busy" @click="startRename(s)">✎</button>
            <button type="button" class="btn-text btn-sm" title="Delete" aria-label="Delete" :disabled="busy" @click="remove(s)">✕</button>
          </div>
        </div>
      </li>
    </ul>

    <p v-if="!sessions.list.length && sessions.shownId !== null" class="card-body text-sm fg-3 m-0">No sessions yet.</p>
  </div>
</template>

<style scoped>
.sessions {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.sessions > :not(.session-list) {
  flex: none;
}

.session-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.session {
  padding-top: 0.5rem;
  padding-bottom: 0.5rem;
}

.active-session {
  background: var(--bs-secondary-bg, rgba(127, 127, 127, 0.12));
  box-shadow: inset 3px 0 0 var(--bs-primary, currentColor);
}

.session-open {
  min-width: 0;
  background: none;
  border: 0;
  padding: 0;
  color: inherit;
  cursor: pointer;
}

.session-open:disabled {
  cursor: default;
}

.session-actions {
  opacity: 0.55;
}

.session:hover .session-actions,
.session:focus-within .session-actions,
.session-actions .pinned {
  opacity: 1;
}
</style>
