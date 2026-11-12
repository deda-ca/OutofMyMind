<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { shortTokens } from '../context'
import { dollars, loadUsage, usage, type Totals } from '../usage'

// What the LLMs have cost today: a badge beside the context meter ("$0.42
// today", or tokens when nothing has a price); click for today by model and
// by source, this session, this month, and the daily budgets.

const dialog = ref<HTMLDialogElement | null>(null)
const s = computed(() => usage.summary)
const today = computed(() => s.value?.today?.total ?? null)
const priced = (t: Totals | null | undefined) => !!t && t.requests > t.unpriced
const tokens = (t: Totals) => t.input + t.output
/** The badge: dollars if anything today had a price, else tokens. */
const label = computed(() => {
  const t = today.value
  if (!t) return 'Usage'
  return priced(t) ? `${dollars(t.cost)} today` : `${shortTokens(tokens(t))} tokens today`
})
/** A budget nearly or fully spent colors the badge. */
const level = computed(() => {
  const worst = Math.max(0, ...(s.value?.budgets ?? []).map((b) => (b.budget ? b.spent / b.budget : 0)))
  return worst >= 1 ? 'theme-danger' : worst >= 0.8 ? 'theme-warning' : 'theme-secondary'
})
const rows = (by: Record<string, Totals> | undefined) => Object.entries(by ?? {}).sort((a, b) => b[1].cost - a[1].cost || tokens(b[1]) - tokens(a[1]))
const SOURCES: Record<string, string> = { chat: 'Talking and typing', telegram: 'Telegram', schedule: 'Schedules', other: 'Other' }
const sourceName = (k: string) => SOURCES[k] ?? (k.startsWith('plugin:') ? `Plugin: ${k.slice(7)}` : k.startsWith('service:') ? `Service: ${k.slice(8)}` : k)
const costCell = (t: Totals) => (t.requests === t.unpriced ? '—' : `${dollars(t.cost)}${t.unpriced ? ' +' : ''}`)

async function show(): Promise<void> {
  await loadUsage()
  dialog.value?.showModal()
}
const close = () => dialog.value?.close()
const backdrop = (event: MouseEvent) => event.target === dialog.value && close()

onMounted(loadUsage)
</script>

<template>
  <button type="button" class="badge badge-subtle" :class="level" title="What the LLMs have cost today. Click for the breakdown." aria-haspopup="dialog" @click="show">
    {{ label }}
  </button>

  <dialog ref="dialog" class="dialog dialog-lg dialog-scrollable" aria-labelledby="usage-title" @click="backdrop">
    <div class="dialog-header gap-3">
      <h2 id="usage-title" class="dialog-title">Usage</h2>
      <button type="button" class="btn-text btn-sm ms-auto" aria-label="Close" @click="close">✕</button>
    </div>
    <div class="dialog-body vstack gap-4">
      <div class="d-flex gap-4 flex-wrap">
        <div class="vstack">
          <span class="fg-3 text-sm">Today</span>
          <span class="fs-4 fw-semibold">{{ today ? (priced(today) ? dollars(today.cost) : '—') : '$0' }}</span>
          <span class="fg-3 text-sm">{{ today ? `${today.requests} requests · ${shortTokens(tokens(today))} tokens` : 'nothing yet' }}</span>
        </div>
        <div class="vstack">
          <span class="fg-3 text-sm">This session</span>
          <span class="fs-4 fw-semibold">{{ s?.session ? (priced(s.session) ? dollars(s.session.cost) : '—') : '$0' }}</span>
          <span class="fg-3 text-sm">{{ s?.session ? `${s.session.requests} requests · ${shortTokens(tokens(s.session))} tokens` : 'nothing yet' }}</span>
        </div>
        <div class="vstack">
          <span class="fg-3 text-sm">This month</span>
          <span class="fs-4 fw-semibold">{{ priced(s?.month) ? dollars(s!.month.cost) : '—' }}</span>
          <span class="fg-3 text-sm">{{ s ? `${s.month.requests} requests · ${shortTokens(tokens(s.month))} tokens` : '' }}</span>
        </div>
      </div>

      <section v-if="s?.budgets.length" class="vstack gap-2">
        <span class="fw-semibold">Daily budgets</span>
        <div v-for="b in s.budgets" :key="b.connection" class="vstack gap-1">
          <div class="d-flex text-sm"><span>{{ b.label }}</span><span class="ms-auto fg-3">{{ dollars(b.spent) }} of {{ dollars(b.budget) }}{{ b.spent >= b.budget ? ' · spent: using the default model' : '' }}</span></div>
          <div class="budget-bar"><span :class="b.spent >= b.budget ? 'over' : b.spent >= 0.8 * b.budget ? 'near' : ''" :style="{ width: `${Math.min(100, b.budget ? (b.spent / b.budget) * 100 : 100)}%` }"></span></div>
        </div>
      </section>

      <section v-if="today" class="vstack gap-2">
        <span class="fw-semibold">Today by model</span>
        <table class="table table-sm m-0">
          <thead><tr><th>Model</th><th class="text-end">Requests</th><th class="text-end">In</th><th class="text-end">Cached</th><th class="text-end">Out</th><th class="text-end">Cost</th></tr></thead>
          <tbody>
            <tr v-for="[ref, t] in rows(s?.today?.models)" :key="ref">
              <td><code>{{ ref }}</code></td>
              <td class="text-end">{{ t.requests }}</td>
              <td class="text-end">{{ shortTokens(t.input) }}</td>
              <td class="text-end">{{ shortTokens(t.cached) }}</td>
              <td class="text-end">{{ shortTokens(t.output) }}</td>
              <td class="text-end">{{ costCell(t) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="today" class="vstack gap-2">
        <span class="fw-semibold">Today by source</span>
        <table class="table table-sm m-0">
          <tbody>
            <tr v-for="[k, t] in rows(s?.today?.sources)" :key="k">
              <td>{{ sourceName(k) }}</td>
              <td class="text-end">{{ t.requests }} requests</td>
              <td class="text-end">{{ shortTokens(tokens(t)) }} tokens</td>
              <td class="text-end">{{ costCell(t) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <p class="fg-3 text-sm m-0">
        Approximate: Claude's list prices are built in and the local model is free; other models count in tokens until you give their
        <code>prices</code> in <code>llm.connections</code>. "+" means some requests had no price.
      </p>
    </div>
  </dialog>
</template>

<style scoped>
.budget-bar {
  height: 6px;
  border-radius: 3px;
  background: color-mix(in srgb, currentColor 15%, transparent);
  overflow: hidden;
}
.budget-bar span {
  display: block;
  height: 100%;
  background: var(--bs-success, #198754);
}
.budget-bar span.near {
  background: var(--bs-warning, #ffc107);
}
.budget-bar span.over {
  background: var(--bs-danger, #dc3545);
}
</style>
