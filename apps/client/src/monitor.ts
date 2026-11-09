// The Monitor tab's switch: whether the client keeps the microphone, phrase and
// request details it shows. Remembered in this browser; off by default.

import { ref, watch } from 'vue'

const STORAGE_KEY = 'jarvis.monitor'

function saved(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

export const monitorEnabled = ref(saved())
watch(monitorEnabled, (on) => {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // private window: fine, it just isn't remembered
  }
})
