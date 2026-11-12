// Self-contained plugins with their own tab (server: src/plugins, design:
// docs/plugins.md). Each tab is the plugin's own page in a sandboxed frame
// (PluginTab.vue); this keeps the list, and a counter per plugin that goes up
// when the server says the plugin's data changed (the tab then reloads).

import { reactive } from 'vue'

/** What a plugin's tab button shows besides its title (set by the plugin, or by its tab page). */
export interface TabStatus {
  icon?: string
  animate?: boolean
  badge?: string
  title?: string
}

export interface PluginTabInfo {
  name: string
  description: string
  connected: boolean
  tab: { title: string; url: string; icon?: string } | null
  status?: TabStatus | null
}

export const plugins = reactive({
  list: [] as PluginTabInfo[],
  /** Bumped when a plugin's tab should refresh. */
  changed: {} as Record<string, number>,
  /** Something every open tab is told (Jarvis started or stopped talking), with a counter so the same news twice still arrives. */
  host: { event: '', n: 0 },
  /** Tabs opened at least once: kept alive (hidden) when another tab is shown, so a tab that's playing carries on. */
  opened: {} as Record<string, boolean>,
  /** Each tab button's status: from the plugin (the server), or from its page (which wins while it's set). */
  status: {} as Record<string, TabStatus | null>,
  pageStatus: {} as Record<string, TabStatus | null>,
})

/** The status a tab button shows now. */
export function statusOf(name: string): TabStatus | null {
  return plugins.pageStatus[name] ?? plugins.status[name] ?? null
}

/** A status from a tab page (a sandboxed frame): only the expected fields, kept short. */
export function cleanStatus(s: unknown): TabStatus | null {
  if (!s || typeof s !== 'object') return null
  const v = s as Record<string, unknown>
  const short = (x: unknown, n: number) => (typeof x === 'number' && Number.isFinite(x) ? String(x) : typeof x === 'string' ? [...x.trim()].slice(0, n).join('') : '')
  const out: TabStatus = {}
  if (short(v.icon, 4)) out.icon = short(v.icon, 4)
  if (v.animate === true) out.animate = true
  if (short(v.badge, 12) && short(v.badge, 12) !== '0') out.badge = short(v.badge, 12)
  if (short(v.title, 120)) out.title = short(v.title, 120)
  return out.icon || out.badge || out.animate ? out : null
}

/** A tab another part of the page wants shown (App.vue switches to it). */
export const tabRequest = reactive({ tab: '', n: 0 })

/** Hands a document to the Read aloud tab (the reader plugin) and shows it. */
export async function readAloud(text: string, title: string): Promise<string | null> {
  const r = await callPluginTool('reader', 'read_aloud', { text, title })
  if (r.isError) return r.text
  Object.assign(tabRequest, { tab: 'plugin:reader', n: tabRequest.n + 1 })
  return null
}

/** Tells every open plugin tab something about the Jarvis page. */
export function tellTabs(event: string): void {
  plugins.host = { event, n: plugins.host.n + 1 }
}

export async function loadPlugins(): Promise<void> {
  try {
    const response = await fetch('/api/plugins')
    if (!response.ok) return
    const body = (await response.json()) as { plugins?: PluginTabInfo[] }
    plugins.list = body.plugins ?? []
    for (const p of plugins.list) plugins.status[p.name] = p.status ?? null
  } catch {
    // offline: keep what we had
  }
}

export function pluginChanged(name: string): void {
  plugins.changed[name] = (plugins.changed[name] ?? 0) + 1
}

/** A plugin's tool, called as the owner from its tab. */
export async function callPluginTool(name: string, tool: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  try {
    const response = await fetch(`/api/plugins/${encodeURIComponent(name)}/call/${encodeURIComponent(tool)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: args && typeof args === 'object' ? args : {} }),
    })
    const body = (await response.json().catch(() => ({}))) as { text?: string; isError?: boolean; error?: string }
    if (!response.ok) return { text: body.error ?? `HTTP ${response.status}`, isError: true }
    return { text: body.text ?? '', isError: body.isError === true }
  } catch (err) {
    return { text: (err as Error).message, isError: true }
  }
}
