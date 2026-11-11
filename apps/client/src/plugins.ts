// Self-contained plugins with their own tab (server: src/plugins, design:
// docs/plugins.md). Each tab is the plugin's own page in a sandboxed frame
// (PluginTab.vue); this keeps the list, and a counter per plugin that goes up
// when the server says the plugin's data changed (the tab then reloads).

import { reactive } from 'vue'

export interface PluginTabInfo {
  name: string
  description: string
  connected: boolean
  tab: { title: string; url: string } | null
}

export const plugins = reactive({
  list: [] as PluginTabInfo[],
  /** Bumped when a plugin's tab should refresh. */
  changed: {} as Record<string, number>,
  /** Something every open tab is told (Jarvis started or stopped talking), with a counter so the same news twice still arrives. */
  host: { event: '', n: 0 },
  /** Tabs opened at least once: kept alive (hidden) when another tab is shown, so a tab that's playing carries on. */
  opened: {} as Record<string, boolean>,
})

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
