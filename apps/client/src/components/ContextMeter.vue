<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { context, shortTokens } from '../context'

// How full the local model's context is: a small ring and "31K / 256K" in the
// header; click for the breakdown by section, each with its own bar.

const dialog = ref<HTMLDialogElement | null>(null)
const open = reactive<Record<string, boolean>>({})

const COLORS: Record<string, string> = {
  system: '#6f42c1',
  tools: '#fd7e14',
  history: '#0d6efd',
  toolcalls: '#d63384',
  notes: '#20c997',
  latest: '#198754',
  format: '#adb5bd',
}
const color = (key: string) => COLORS[key] ?? '#6c757d'

const used = computed(() => context.stats?.used ?? 0)
const limit = computed(() => context.limit || context.stats?.limit || 0)
const percent = computed(() => (limit.value ? (used.value / limit.value) * 100 : 0))
const level = computed(() => (percent.value >= 85 ? 'theme-danger' : percent.value >= 60 ? 'theme-warning' : 'theme-secondary'))
const free = computed(() => Math.max(0, limit.value - used.value))
const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(n / of < 0.01 && n > 0 ? 1 : 0)}%` : '–')
const when = computed(() => (context.stats ? new Date(context.stats.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''))

/** The ring: a circle stroked for the used share. */
const R = 7
const CIRC = 2 * Math.PI * R
const dash = computed(() => `${(Math.min(100, percent.value) / 100) * CIRC} ${CIRC}`)

function show(): void {
  dialog.value?.showModal()
}
function close(): void {
  dialog.value?.close()
}
function backdrop(event: MouseEvent): void {
  if (event.target === dialog.value) close()
}
</script>

<template>
  <button
    type="button"
    class="badge badge-subtle meter"
    :class="level"
    :title="context.stats ? `Context: ${used.toLocaleString()} of ${limit.toLocaleString()} tokens (${pct(used, limit)}). Click for the breakdown.` : 'Context: no request to the local model yet'"
    aria-haspopup="dialog"
    @click="show"
  >
    <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true">
      <circle cx="9" cy="9" :r="R" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="3" />
      <circle cx="9" cy="9" :r="R" fill="none" stroke="currentColor" stroke-width="3" :stroke-dasharray="dash" transform="rotate(-90 9 9)" stroke-linecap="round" />
    </svg>
    <template v-if="context.stats">{{ pct(used, limit) }} · {{ shortTokens(used) }} / {{ limit ? shortTokens(limit) : '?' }}</template>
    <template v-else>Context{{ limit ? ` · ${shortTokens(limit)}` : '' }}</template>
  </button>

  <dialog ref="dialog" class="dialog dialog-lg dialog-scrollable" aria-labelledby="context-title" @click="backdrop">
    <div class="dialog-header gap-3">
      <h2 id="context-title" class="dialog-title">Context</h2>
      <button type="button" class="btn-text btn-sm ms-auto" aria-label="Close" @click="close">✕</button>
    </div>
    <div class="dialog-body vstack gap-4">
      <p v-if="!context.stats" class="fg-3 m-0">
        Nothing yet: the breakdown appears after the next request to the local model.
        <template v-if="limit"> Its context window is {{ limit.toLocaleString() }} tokens.</template>
      </p>
      <template v-else>
        <div class="vstack gap-2">
          <div class="d-flex align-items-baseline gap-2 flex-wrap">
            <span class="fs-4 fw-semibold">{{ used.toLocaleString() }}</span>
            <span class="fg-3">of {{ limit ? limit.toLocaleString() : '?' }} tokens · {{ pct(used, limit) }} used · {{ free.toLocaleString() }} free</span>
          </div>
          <!-- The whole window: one segment per section, the rest free. -->
          <div class="stack-bar" role="img" :aria-label="`${pct(used, limit)} of the context used`">
            <span
              v-for="s in context.stats.sections"
              :key="s.key"
              class="seg"
              :style="{ width: limit ? `${(s.tokens / limit) * 100}%` : '0', background: color(s.key) }"
              :title="`${s.label}: ${s.tokens.toLocaleString()} tokens`"
            ></span>
          </div>
          <span class="text-sm fg-3">
            Last request to {{ context.stats.model }} at {{ when }}.
            <template v-if="context.stats.cached !== null"> {{ context.stats.cached.toLocaleString() }} tokens ({{ pct(context.stats.cached, used) }}) were reused from the cache, not processed again.</template>
            <template v-if="context.stats.reply !== null"> The reply was {{ context.stats.reply.toLocaleString() }} tokens.</template>
          </span>
        </div>

        <div class="vstack gap-1">
          <template v-for="s in context.stats.sections" :key="s.key">
            <button type="button" class="row-button" :disabled="!s.items?.length" :aria-expanded="s.items?.length ? !!open[s.key] : undefined" @click="open[s.key] = !open[s.key]">
              <span class="swatch" :style="{ background: color(s.key) }" aria-hidden="true"></span>
              <span class="label">
                <span v-if="s.items?.length" class="fg-3">{{ open[s.key] ? '▾' : '▸' }}</span>
                {{ s.label }}
              </span>
              <span class="mini"><span :style="{ width: used ? `${(s.tokens / used) * 100}%` : '0', background: color(s.key) }"></span></span>
              <span class="num">{{ s.tokens.toLocaleString() }}</span>
              <span class="share fg-3">{{ pct(s.tokens, used) }}</span>
            </button>
            <template v-if="open[s.key]">
              <div v-for="item in s.items" :key="item.label" class="row-button sub">
                <span class="swatch" aria-hidden="true"></span>
                <span class="label fg-3">{{ item.label }}</span>
                <span class="mini"><span :style="{ width: used ? `${(item.tokens / used) * 100}%` : '0', background: color(s.key), opacity: 0.6 }"></span></span>
                <span class="num fg-3">{{ item.tokens.toLocaleString() }}</span>
                <span class="share fg-3">{{ pct(item.tokens, used) }}</span>
              </div>
            </template>
          </template>
          <div class="row-button free">
            <span class="swatch" aria-hidden="true"></span>
            <span class="label fg-3">Free (share of the whole window)</span>
            <span class="mini"></span>
            <span class="num fg-3">{{ free.toLocaleString() }}</span>
            <span class="share fg-3">{{ pct(free, limit) }}</span>
          </div>
        </div>

        <p class="text-sm fg-3 m-0">
          Counted with the model's own tokenizer, for the last request (each step of a tool loop is one request). Shares
          in the list are of what's used; the bar at the top is the whole window. “Chat formatting” is the template's
          markup around messages and tools.
        </p>
      </template>
    </div>
  </dialog>
</template>

<style scoped>
.meter {
  border: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-variant-numeric: tabular-nums;
}
dialog:not([open]) {
  display: none;
}
.stack-bar {
  display: flex;
  height: 0.875rem;
  border-radius: 999px;
  overflow: hidden;
  background: var(--bs-tertiary-bg, rgba(127, 127, 127, 0.15));
}
.seg {
  height: 100%;
  min-width: 2px;
}
.row-button {
  display: grid;
  grid-template-columns: 0.75rem minmax(0, 1fr) minmax(4rem, 10rem) 5.5rem 3.5rem;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.25rem 0;
  border: 0;
  background: none;
  color: inherit;
  text-align: start;
  font-size: 0.9rem;
}
.row-button:not(:disabled) {
  cursor: pointer;
}
.row-button.sub {
  font-size: 0.85rem;
  padding-inline-start: 1.25rem;
}
.swatch {
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 0.2rem;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini {
  height: 0.5rem;
  border-radius: 999px;
  background: var(--bs-tertiary-bg, rgba(127, 127, 127, 0.15));
  overflow: hidden;
}
.mini > span {
  display: block;
  height: 100%;
}
.num,
.share {
  text-align: end;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 575.98px) {
  .row-button {
    grid-template-columns: 0.75rem minmax(0, 1fr) 4.5rem 3rem;
  }
  .mini {
    display: none;
  }
}
</style>
