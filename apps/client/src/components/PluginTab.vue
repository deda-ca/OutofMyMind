<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { callPluginTool, cleanStatus, plugins } from '../plugins'

// A plugin's own tab (docs/plugins.md): its page, in a sandboxed frame that
// can't reach the owner's session or the API. It asks this component over
// postMessage, which calls only this plugin's tools.

const props = defineProps<{ name: string; url: string }>()
const emit = defineEmits<{ ask: [text: string] }>()
const frame = ref<HTMLIFrameElement | null>(null)

function post(message: Record<string, unknown>): void {
  frame.value?.contentWindow?.postMessage(message, '*')
}

async function onMessage(e: MessageEvent): Promise<void> {
  if (!frame.value || e.source !== frame.value.contentWindow || !e.data || typeof e.data !== 'object') return
  const m = e.data as { jarvis?: string; id?: number; tool?: unknown; args?: unknown; text?: unknown; url?: unknown }
  if (m.jarvis === 'call' && typeof m.tool === 'string') {
    post({ jarvis: 'result', id: m.id, result: await callPluginTool(props.name, m.tool, m.args) })
  } else if (m.jarvis === 'status') {
    // What its tab button shows (reading aloud: a pulsing speaker).
    plugins.pageStatus[props.name] = cleanStatus((m as { status?: unknown }).status)
  } else if (m.jarvis === 'ask' && typeof m.text === 'string') {
    emit('ask', m.text)
  } else if (m.jarvis === 'open' && typeof m.url === 'string' && m.url.startsWith('/api/workspace-file?')) {
    // Only files from the workspace, in a new tab.
    window.open(m.url, '_blank', 'noopener')
  }
}

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
watch(
  () => plugins.changed[props.name],
  () => post({ jarvis: 'refresh' }),
)
watch(
  () => plugins.host.n,
  () => post({ jarvis: 'host', event: plugins.host.event }),
)
</script>

<template>
  <iframe ref="frame" class="plugin-frame" :src="url" :title="name" sandbox="allow-scripts allow-forms"></iframe>
</template>

<style scoped>
.plugin-frame {
  width: 100%;
  height: calc(100vh - 11rem);
  min-height: 28rem;
  border: 1px solid var(--bs-border-color, rgba(127, 127, 127, 0.3));
  border-radius: 0.5rem;
  background: transparent;
}
</style>
