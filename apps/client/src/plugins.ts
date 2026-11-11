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
})

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
