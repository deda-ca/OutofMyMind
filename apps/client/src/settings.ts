// Transcriber settings, saved in this browser's localStorage.

import { reactive, watch } from 'vue'
import { DEFAULT_SETTINGS, type StreamSettings as TranscriberSettings } from './audio/streamTranscriber'

const STORAGE_KEY = 'jarvis.transcriber-settings'

function load(): TranscriberSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<TranscriberSettings>
    // Only keep known numeric keys, so an old or edited value can't break anything.
    const merged = { ...DEFAULT_SETTINGS }
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof TranscriberSettings)[]) {
      if (typeof saved[key] === 'number' && Number.isFinite(saved[key])) merged[key] = saved[key]
    }
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export const settings = reactive<TranscriberSettings>(load())

watch(settings, (value) => localStorage.setItem(STORAGE_KEY, JSON.stringify(value)), { deep: true })

export function resetSettings(): void {
  Object.assign(settings, DEFAULT_SETTINGS)
}
