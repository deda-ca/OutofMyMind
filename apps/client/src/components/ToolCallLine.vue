<script setup lang="ts">
import { computed, ref } from 'vue'
import { CRUD_PILLS, filesIn, prettyArgs, shortPath, type ToolCallInfo } from '../toolCalls'

// One tool call in the transcript: ⚙️ what it was, a pill per kind of thing it
// does (create / read / update / delete), and on click: the files it touched,
// its arguments and what came back.

const props = defineProps<{ label: string; call: ToolCallInfo }>()

const open = ref(false)
const files = computed(() => filesIn(props.call.args))
const pills = computed(() => props.call.crud.map((k) => ({ kind: k, ...(CRUD_PILLS[k] ?? { label: k, theme: 'theme-secondary' }) })))
const running = computed(() => props.call.status === 'running')
const verb = computed(() => {
  const c = props.call.crud
  if (c.includes('delete')) return 'Deleted'
  if (c.includes('update') && c.includes('create')) return 'Created or changed'
  if (c.includes('update')) return 'Changed'
  if (c.includes('create')) return 'Created'
  return 'Read'
})
</script>

<template>
  <span class="vstack gap-1 tool-call">
    <span class="d-flex align-items-center gap-2 flex-wrap text-sm fg-3">
      <span aria-hidden="true">⚙️</span>
      <span>{{ label }}</span>
      <span v-if="files.length" class="text-truncate files-inline" :title="files.join('\n')">· {{ files.map(shortPath).join(', ') }}</span>
      <button
        v-for="p in pills"
        :key="p.kind"
        type="button"
        class="badge badge-subtle pill"
        :class="p.theme"
        :aria-expanded="open"
        :title="open ? 'Hide details' : 'Show the files, arguments and result'"
        @click="open = !open"
      >
        {{ p.label }}
      </button>
      <button v-if="!pills.length" type="button" class="badge theme-secondary badge-subtle pill" :aria-expanded="open" @click="open = !open">details</button>
      <span v-if="running" class="spinner-border spinner-sm" role="status" aria-label="Running"></span>
      <span v-else-if="call.isError" class="badge theme-danger">failed</span>
    </span>

    <span v-if="open" class="card card-body py-2 px-3 vstack gap-2 text-sm detail">
      <span><span class="fw-semibold">Tool:</span> <code>{{ call.name }}</code></span>
      <span v-if="files.length" class="vstack gap-1">
        <span class="fw-semibold">{{ verb }}:</span>
        <code v-for="f in files" :key="f" class="text-break" :title="f">{{ shortPath(f) }}</code>
      </span>
      <span class="vstack gap-1">
        <span class="fw-semibold">Arguments</span>
        <pre class="dump">{{ prettyArgs(call.args) || '{}' }}</pre>
      </span>
      <span class="vstack gap-1">
        <span class="fw-semibold">
          Result<template v-if="call.isError"> <span class="fg-danger">(error)</span></template>
          <span v-if="call.durationMs !== undefined" class="fw-normal fg-3"> · {{ call.durationMs }} ms</span>
        </span>
        <pre v-if="!running" class="dump" :class="{ 'fg-danger': call.isError }">{{ call.result ?? '(not kept)' }}</pre>
        <span v-else class="fg-3">Running…</span>
      </span>
    </span>
  </span>
</template>

<style scoped>
.pill {
  border: 0;
  cursor: pointer;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.pill:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 1px;
}

.files-inline {
  max-width: 28rem;
}

.detail {
  max-width: 48rem;
}

.dump {
  margin: 0;
  padding: 0.5rem 0.75rem;
  max-height: 16rem;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.8rem;
  border-radius: 0.375rem;
  background: var(--bs-tertiary-bg, rgba(127, 127, 127, 0.1));
}
</style>
