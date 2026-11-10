<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { clearExchanges, debugEnabled, exchanges, parseSse, type Exchange } from '../debug'

// Every LLM request and response, exactly as sent and received by the server.
// Nothing is saved: it lives in this page until cleared or reloaded.

defineProps<{ connected: boolean }>()

interface Message {
  role: string
  content?: string | null
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
  tool_call_id?: string
}

/** Which exchanges are open, and which of their sections. */
const open = reactive<Record<string, boolean>>({})
const newestFirst = ref(true)
const copied = ref('')

const shown = computed(() => (newestFirst.value ? [...exchanges.value].reverse() : exchanges.value))

const messages = (e: Exchange) => ((e.request.body.messages as Message[] | undefined) ?? [])
const tools = (e: Exchange) => ((e.request.body.tools as { function?: { name?: string } }[] | undefined) ?? [])
const system = (e: Exchange) => messages(e).find((m) => m.role === 'system')?.content ?? ''
const parsed = (e: Exchange) => (e.response ? parseSse(e.response.raw) : null)

/** The request without its long parts, for the summary line. */
function lastUser(e: Exchange): string {
  const m = [...messages(e)].reverse().find((x) => x.role === 'user')
  return (m?.content ?? '').replace(/\s+/g, ' ').slice(0, 140)
}

function status(e: Exchange): { label: string; theme: string } {
  const r = e.response
  if (!r) return { label: 'waiting…', theme: 'theme-secondary' }
  if (r.status === 0) return { label: r.ended ?? 'failed', theme: 'theme-danger' }
  if (r.status >= 400) return { label: `HTTP ${r.status}`, theme: 'theme-danger' }
  if (r.ended) return { label: `${r.status} · ${r.ended}`, theme: 'theme-warning' }
  return { label: String(r.status), theme: 'theme-success' }
}

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const pretty = (value: unknown) => JSON.stringify(value, null, 2)

function toggle(key: string): void {
  open[key] = !open[key]
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = what
    setTimeout(() => copied.value === what && (copied.value = ''), 1500)
  } catch {
    copied.value = 'Copy failed'
  }
}

function sectionsFor(e: Exchange) {
  const p = parsed(e)
  return [
    { key: 'system', label: 'System prompt', count: system(e) ? `${system(e).length.toLocaleString()} chars` : 'none' },
    { key: 'messages', label: 'Messages', count: String(messages(e).length) },
    { key: 'tools', label: 'Tools offered', count: String(tools(e).length) },
    { key: 'reply', label: 'Reply', count: p ? `${p.text.length.toLocaleString()} chars${p.toolCalls.length ? `, ${p.toolCalls.length} tool call${p.toolCalls.length === 1 ? '' : 's'}` : ''}` : '…' },
    { key: 'request', label: 'Request (HTTP + JSON)', count: `${JSON.stringify(e.request.body).length.toLocaleString()} bytes` },
    { key: 'response', label: 'Response (HTTP + raw stream)', count: e.response ? `${e.response.raw.length.toLocaleString()} bytes` : '…' },
  ]
}
</script>

<template>
  <div class="vstack gap-4">
    <div class="d-flex align-items-center gap-3 flex-wrap">
      <div class="d-flex align-items-center gap-2">
        <div class="switch">
          <input id="debug-enabled" v-model="debugEnabled" type="checkbox" />
        </div>
        <label for="debug-enabled" class="fw-semibold m-0">Capture LLM traffic</label>
      </div>
      <span class="text-sm fg-3">{{ exchanges.length }} request{{ exchanges.length === 1 ? '' : 's' }}</span>
      <label class="d-flex align-items-center gap-2 text-sm m-0 ms-auto">
        <input v-model="newestFirst" type="checkbox" /> Newest first
      </label>
      <button type="button" class="btn-outline theme-secondary btn-sm" :disabled="!exchanges.length" @click="clearExchanges">Clear</button>
    </div>

    <p class="text-sm fg-3 m-0">
      Every request to the model and its response, exactly as the server sends and receives them:
      headers, the full JSON body (system prompt, history, tools), and the raw streamed reply. API keys are masked.
      Nothing is saved; it stays in this page until you clear or reload it.
    </p>
    <div v-if="debugEnabled && !connected" class="alert theme-warning" role="status">
      Traffic comes over the live connection: press “Start listening” on the Live tab, then talk or type to Jarvis.
    </div>

    <p v-if="!exchanges.length" class="fg-3 m-0">{{ debugEnabled ? 'Nothing yet.' : 'Switch on capture to see requests.' }}</p>

    <div v-for="e in shown" :key="e.id" class="card">
      <button type="button" class="card-header exchange-head text-start" :aria-expanded="!!open[e.id]" @click="toggle(String(e.id))">
        <span class="d-flex align-items-center gap-2 flex-wrap w-100">
          <span class="fg-3">{{ open[e.id] ? '▾' : '▸' }}</span>
          <span class="fw-semibold">#{{ e.id }}</span>
          <span class="text-sm fg-3">{{ time(e.request.at) }}</span>
          <span class="badge theme-secondary badge-subtle">{{ e.request.model }}</span>
          <span class="badge" :class="status(e).theme">{{ status(e).label }}</span>
          <span v-if="e.response" class="text-sm fg-3">
            {{ e.response.firstByteMs ?? '–' }} ms to first byte · {{ e.response.durationMs }} ms total
          </span>
          <span class="text-sm fg-3 ms-auto">{{ messages(e).length }} messages · {{ tools(e).length }} tools</span>
        </span>
        <span class="d-block text-sm text-truncate mt-1">{{ lastUser(e) || '(no user message)' }}</span>
      </button>

      <div v-if="open[e.id]" class="card-body vstack gap-2">
        <div v-for="section in sectionsFor(e)" :key="section.key" class="section">
          <button type="button" class="btn-text btn-sm section-head" :aria-expanded="!!open[`${e.id}:${section.key}`]" @click="toggle(`${e.id}:${section.key}`)">
            {{ open[`${e.id}:${section.key}`] ? '▾' : '▸' }} {{ section.label }} <span class="fg-3">({{ section.count }})</span>
          </button>

          <template v-if="open[`${e.id}:${section.key}`]">
            <pre v-if="section.key === 'system'" class="dump">{{ system(e) || '(none)' }}</pre>

            <div v-else-if="section.key === 'messages'" class="vstack gap-2">
              <div v-for="(m, i) in messages(e)" :key="i" class="message">
                <span class="badge" :class="m.role === 'user' ? 'theme-primary' : m.role === 'assistant' ? 'theme-info' : m.role === 'tool' ? 'theme-warning' : 'theme-secondary'">
                  {{ i }} · {{ m.role }}{{ m.tool_call_id ? ` · ${m.tool_call_id}` : '' }}
                </span>
                <pre v-if="m.content" class="dump">{{ m.content }}</pre>
                <pre v-for="(c, k) in m.tool_calls ?? []" :key="k" class="dump">→ {{ c.function?.name }}({{ c.function?.arguments }})  {{ c.id }}</pre>
              </div>
            </div>

            <pre v-else-if="section.key === 'tools'" class="dump">{{ tools(e).length ? pretty(e.request.body.tools) : '(no tools offered)' }}</pre>

            <div v-else-if="section.key === 'reply'" class="vstack gap-2">
              <template v-if="parsed(e)">
                <pre class="dump">{{ parsed(e)!.text || '(no text)' }}</pre>
                <pre v-for="(c, k) in parsed(e)!.toolCalls" :key="k" class="dump">→ {{ c.name }}({{ c.arguments }})</pre>
                <span class="text-sm fg-3">
                  {{ parsed(e)!.chunks }} chunks<template v-if="parsed(e)!.finishReason"> · finish: {{ parsed(e)!.finishReason }}</template>
                  <template v-if="parsed(e)!.usage"> · usage: {{ JSON.stringify(parsed(e)!.usage) }}</template>
                </span>
                <pre v-if="parsed(e)!.events.length" class="dump">{{ parsed(e)!.events.join('\n') }}</pre>
              </template>
              <span v-else class="text-sm fg-3">Waiting for the response…</span>
            </div>

            <div v-else-if="section.key === 'request'" class="vstack gap-2">
              <div class="d-flex gap-2">
                <code class="text-sm flex-grow-1 text-break">{{ e.request.method }} {{ e.request.url }}</code>
                <button type="button" class="btn-outline theme-secondary btn-sm" @click="copy(pretty(e.request.body), `req${e.id}`)">
                  {{ copied === `req${e.id}` ? 'Copied' : 'Copy JSON' }}
                </button>
              </div>
              <pre class="dump">{{ pretty(e.request.headers) }}</pre>
              <pre class="dump tall">{{ pretty(e.request.body) }}</pre>
            </div>

            <div v-else-if="section.key === 'response'" class="vstack gap-2">
              <template v-if="e.response">
                <div class="d-flex gap-2">
                  <code class="text-sm flex-grow-1">HTTP {{ e.response.status || '—' }}{{ e.response.ended ? ` (${e.response.ended})` : '' }}</code>
                  <button type="button" class="btn-outline theme-secondary btn-sm" @click="copy(e.response.raw, `res${e.id}`)">
                    {{ copied === `res${e.id}` ? 'Copied' : 'Copy raw' }}
                  </button>
                </div>
                <pre class="dump">{{ pretty(e.response.headers) }}</pre>
                <pre class="dump tall">{{ e.response.raw || '(empty)' }}</pre>
              </template>
              <span v-else class="text-sm fg-3">Waiting for the response…</span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.exchange-head {
  width: 100%;
  border: 0;
  color: inherit;
  cursor: pointer;
}

.section-head {
  padding-left: 0;
}

.dump {
  margin: 0.25rem 0 0;
  padding: 0.5rem 0.75rem;
  max-height: 24rem;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.8rem;
  border-radius: 0.375rem;
  background: var(--bs-tertiary-bg, rgba(127, 127, 127, 0.1));
}

.dump.tall {
  max-height: 40rem;
}

.message .dump {
  margin-top: 0.25rem;
}
</style>
