<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

// The harness's plugins (MCP servers) and their tools, with on/off switches
// (server: apps/server/src/harness/routes.ts). Each tool is tagged with what it
// does (create / read / update / delete); a tool is offered to the LLM
// only when it, its plugin, and every kind of thing it does are switched on.

type Crud = 'create' | 'read' | 'update' | 'delete'
const KINDS: { kind: Crud; letter: string; label: string; verb: string; theme: string }[] = [
  { kind: 'create', letter: 'C', label: 'Create', verb: 'creates new things', theme: 'theme-success' },
  { kind: 'read', letter: 'R', label: 'Read', verb: 'only looks things up', theme: 'theme-info' },
  { kind: 'update', letter: 'U', label: 'Update', verb: 'changes existing things', theme: 'theme-warning' },
  { kind: 'delete', letter: 'D', label: 'Delete', verb: 'deletes things', theme: 'theme-danger' },
]
const SOURCES: Record<string, string> = {
  config: 'set in mcp.json',
  annotation: "from the tool's read-only annotation",
  name: "guessed from the tool's name",
  unknown: "the name doesn't say, so it's treated as able to change anything (set it in mcp.json)",
}

interface ToolInfo {
  name: string
  title?: string
  description?: string
  parameters: { properties?: Record<string, { type?: string | string[]; description?: string; enum?: unknown[] }>; required?: string[] }
  enabled: boolean
  crud: Crud[]
  crudSource: string
  /** Kinds it does that are switched off: then it isn't offered, whatever its own switch says. */
  blockedBy: Crud[]
}

interface PluginInfo {
  name: string
  transport: 'stdio' | 'http'
  connected: boolean
  connecting: boolean
  error?: string
  enabled: boolean
  tools: ToolInfo[]
}

const plugins = ref<PluginInfo[]>([])
const kinds = ref<Record<Crud, boolean>>({ create: true, read: true, update: true, delete: true })
const loaded = ref(false)
const error = ref('')
const busy = ref(false)
/** Which plugins are expanded (all collapsed at first). */
const pluginOpen = reactive<Record<string, boolean>>({})
/** Which tools are expanded (description and parameters), by "plugin/tool". */
const open = reactive<Record<string, boolean>>({})

const allOpen = () => plugins.value.length > 0 && plugins.value.every((p) => pluginOpen[p.name])
function setAll(expand: boolean): void {
  for (const p of plugins.value) {
    pluginOpen[p.name] = expand
    if (!expand) for (const t of p.tools) open[`${p.name}/${t.name}`] = false
  }
}

async function api(url: string, init?: RequestInit): Promise<PluginInfo[]> {
  const response = await fetch(url, init)
  const body = (await response.json()) as { plugins?: PluginInfo[]; kinds?: Record<Crud, boolean>; error?: string }
  if (!response.ok || !body.plugins) throw new Error(body.error ?? `HTTP ${response.status}`)
  if (body.kinds) kinds.value = body.kinds
  return body.plugins
}

/** Switch every tool that creates / reads / updates / deletes on or off. */
async function setKind(kind: Crud, enabled: boolean): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    plugins.value = await api(`/api/tool-kinds/${kind}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
  } catch (err) {
    error.value = `Could not switch ${kind} ${enabled ? 'on' : 'off'}: ${(err as Error).message}`
    await load()
  } finally {
    busy.value = false
  }
}

/** How many tools do this kind of thing. */
const countOf = (kind: Crud) => plugins.value.reduce((n, p) => n + p.tools.filter((t) => t.crud.includes(kind)).length, 0)
const kindInfo = (kind: Crud) => KINDS.find((k) => k.kind === kind)!
const tagTitle = (tool: ToolInfo) =>
  `${tool.crud.map((k) => kindInfo(k).label).join(' + ')}: ${SOURCES[tool.crudSource] ?? tool.crudSource}${tool.blockedBy.length ? `. Blocked: ${tool.blockedBy.join(', ')} is switched off.` : ''}`

async function load(): Promise<void> {
  error.value = ''
  try {
    plugins.value = await api('/api/tools')
  } catch (err) {
    error.value = `Could not load tools: ${(err as Error).message}`
  } finally {
    loaded.value = true
  }
}

async function setEnabled(plugin: PluginInfo, tool: ToolInfo | null, enabled: boolean): Promise<void> {
  error.value = ''
  busy.value = true
  const url = tool ? `/api/tools/${encodeURIComponent(plugin.name)}/${encodeURIComponent(tool.name)}` : `/api/tools/${encodeURIComponent(plugin.name)}`
  try {
    plugins.value = await api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
  } catch (err) {
    error.value = `Could not switch ${tool ? tool.name : plugin.name} ${enabled ? 'on' : 'off'}: ${(err as Error).message}`
    await load() // put the checkboxes back as they really are
  } finally {
    busy.value = false
  }
}

const checked = (event: Event) => (event.target as HTMLInputElement).checked

function status(plugin: PluginInfo): { label: string; theme: string } {
  if (plugin.connected) return { label: 'running', theme: 'theme-success' }
  if (plugin.connecting) return { label: 'starting', theme: 'theme-secondary' }
  return { label: 'unavailable', theme: 'theme-danger' }
}

function params(tool: ToolInfo) {
  const required = new Set(tool.parameters.required ?? [])
  return Object.entries(tool.parameters.properties ?? {}).map(([name, p]) => ({
    name,
    type: p.enum ? p.enum.map((v) => JSON.stringify(v)).join(' | ') : [p.type ?? 'any'].flat().join(' | '),
    description: p.description,
    required: required.has(name),
  }))
}

const usable = (plugin: PluginInfo) => plugin.tools.filter((t) => t.enabled && plugin.enabled && t.blockedBy.length === 0).length

onMounted(load)
</script>

<template>
  <div class="vstack gap-5">
    <div class="d-flex align-items-center gap-3 flex-wrap">
      <span class="text-sm fg-3">
        Tools Jarvis can use when answering with the local model, grouped by the plugin that provides them. Switch off a
        plugin or a single tool and Jarvis stops being offered it from the next request.
      </span>
      <button type="button" class="btn-outline theme-secondary btn-sm ms-auto" :disabled="!plugins.length" @click="setAll(!allOpen())">
        {{ allOpen() ? 'Collapse all' : 'Expand all' }}
      </button>
      <button type="button" class="btn-outline theme-secondary btn-sm" :disabled="busy" @click="load">Refresh</button>
    </div>

    <div class="card">
      <div class="card-header"><span class="fw-semibold">Allowed actions</span></div>
      <div class="card-body vstack gap-3">
        <span class="text-sm fg-3">
          Every tool is tagged with what it does. Switch a kind off and every tool that does it is blocked, including tools
          that do several things (a tool that creates <em>and</em> updates is blocked if either is off) and tools from
          plugins added later. Jarvis is told what's switched off.
        </span>
        <div class="d-flex gap-4 flex-wrap">
          <div v-for="k in KINDS" :key="k.kind" class="d-flex align-items-center gap-2">
            <div class="switch">
              <input
                :id="`kind-${k.kind}`"
                type="checkbox"
                :checked="kinds[k.kind]"
                :disabled="busy"
                @change="setKind(k.kind, checked($event))"
              />
            </div>
            <label :for="`kind-${k.kind}`" class="m-0 d-flex align-items-center gap-2" :title="`Tools that ${k.verb}`">
              <span class="badge crud-tag" :class="k.theme">{{ k.letter }}</span>
              {{ k.label }}
              <span class="text-sm fg-3">({{ countOf(k.kind) }})</span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <div v-if="error" class="alert theme-danger" role="alert">{{ error }}</div>

    <p v-if="loaded && !plugins.length && !error" class="fg-3 m-0">
      No plugins are running. Add them to <code>apps/server/mcp.json</code> and restart the server.
    </p>

    <div v-for="plugin in plugins" :key="plugin.name" class="card">
      <div class="card-header">
        <div class="d-flex align-items-center gap-3 flex-wrap w-100">
          <button
            type="button"
            class="btn-text btn-sm chevron"
            :aria-expanded="!!pluginOpen[plugin.name]"
            :aria-label="`${pluginOpen[plugin.name] ? 'Collapse' : 'Expand'} ${plugin.name}`"
            @click="pluginOpen[plugin.name] = !pluginOpen[plugin.name]"
          >
            {{ pluginOpen[plugin.name] ? '▾' : '▸' }}
          </button>
          <div class="switch">
            <input
              :id="`plugin-${plugin.name}`"
              type="checkbox"
              :checked="plugin.enabled"
              :disabled="busy"
              @change="setEnabled(plugin, null, checked($event))"
            />
          </div>
          <label :for="`plugin-${plugin.name}`" class="fw-semibold m-0">{{ plugin.name }}</label>
          <span class="badge badge-subtle" :class="status(plugin).theme">{{ status(plugin).label }}</span>
          <span class="text-sm fg-3 ms-auto">
            {{ usable(plugin) }} of {{ plugin.tools.length }} tool{{ plugin.tools.length === 1 ? '' : 's' }} on · {{ plugin.transport }}
          </span>
        </div>
      </div>

      <div v-if="plugin.error && !plugin.connected" class="card-body py-3 text-sm theme-danger fg-1">{{ plugin.error }}</div>

      <template v-if="pluginOpen[plugin.name]">
        <ul v-if="plugin.tools.length" class="list-group list-group-flush" :class="{ 'plugin-off': !plugin.enabled }">
          <li v-for="tool in plugin.tools" :key="tool.name" class="list-group-item vstack gap-2 py-2">
            <div class="d-flex align-items-center gap-2">
              <button
                type="button"
                class="btn-text btn-sm chevron"
                :aria-expanded="!!open[`${plugin.name}/${tool.name}`]"
                :aria-label="`${open[`${plugin.name}/${tool.name}`] ? 'Collapse' : 'Expand'} ${tool.name}`"
                @click="open[`${plugin.name}/${tool.name}`] = !open[`${plugin.name}/${tool.name}`]"
              >
                {{ open[`${plugin.name}/${tool.name}`] ? '▾' : '▸' }}
              </button>
              <input
                :id="`tool-${plugin.name}-${tool.name}`"
                type="checkbox"
                :checked="tool.enabled"
                :disabled="busy || !plugin.enabled"
                :title="plugin.enabled ? '' : `Switch on ${plugin.name} first`"
                @change="setEnabled(plugin, tool, checked($event))"
              />
              <label :for="`tool-${plugin.name}-${tool.name}`" class="m-0 text-nowrap" :class="{ blocked: tool.blockedBy.length }">
                <code>{{ tool.name }}</code>
              </label>
              <span v-if="tool.blockedBy.length" class="badge theme-secondary badge-subtle text-nowrap">blocked</span>
              <!-- Collapsed: the description on one line, cut off. -->
              <span v-if="!open[`${plugin.name}/${tool.name}`] && tool.description" class="text-sm fg-3 text-truncate min-w-0 flex-grow-1">
                {{ tool.description }}
              </span>
              <!-- What it does, at the end of the row. -->
              <span class="d-flex gap-1 ms-auto flex-shrink-0" :title="tagTitle(tool)">
                <span
                  v-for="k in tool.crud"
                  :key="k"
                  class="badge crud-tag"
                  :class="[kindInfo(k).theme, { 'badge-subtle': tool.crudSource === 'unknown', 'crud-off': tool.blockedBy.includes(k) }]"
                >{{ kindInfo(k).letter }}</span>
              </span>
            </div>

            <div v-if="open[`${plugin.name}/${tool.name}`]" class="tool-detail vstack gap-2">
              <span v-if="tool.title && tool.title !== tool.name" class="fw-semibold text-sm">{{ tool.title }}</span>
              <span class="text-sm fg-3 description">{{ tool.description || 'No description.' }}</span>
              <span class="text-sm">
                <span class="fw-semibold">Does:</span> {{ tool.crud.map((k) => kindInfo(k).label.toLowerCase()).join(' + ') }}
                <span class="fg-3">({{ SOURCES[tool.crudSource] ?? tool.crudSource }})</span>
                <span v-if="tool.blockedBy.length" class="fg-danger"> · blocked: {{ tool.blockedBy.join(', ') }} is switched off</span>
              </span>
              <ul v-if="params(tool).length" class="param-list text-sm vstack gap-1 m-0">
                <li v-for="p in params(tool)" :key="p.name">
                  <code>{{ p.name }}</code>
                  <span class="fg-3"> {{ p.type }}{{ p.required ? '' : ', optional' }}</span>
                  <span v-if="p.description"> — {{ p.description }}</span>
                </li>
              </ul>
              <span v-else class="text-sm fg-3">No parameters.</span>
            </div>
          </li>
        </ul>
        <div v-else-if="plugin.connected" class="card-body text-sm fg-3">This plugin offers no tools.</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.plugin-off {
  opacity: 0.55;
}

.param-list {
  padding-left: 1.25rem;
}

/* Lines the detail up under the tool name (past the chevron and checkbox). */
.tool-detail {
  padding-left: 3.25rem;
}

.description {
  white-space: pre-line;
}

.crud-tag {
  font-family: var(--bs-font-monospace, monospace);
  min-width: 1.4rem;
  justify-content: center;
}

.crud-off {
  text-decoration: line-through;
  opacity: 0.5;
}

.blocked {
  opacity: 0.55;
  text-decoration: line-through;
}

.chevron {
  width: 1.75rem;
  padding-left: 0;
  padding-right: 0;
  flex-shrink: 0;
}

.min-w-0 {
  min-width: 0;
}
</style>
