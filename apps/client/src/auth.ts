// Signing in with the pass-key (server: apps/server/src/auth.ts).
// The server sets an HttpOnly cookie, so the key itself is never stored here.

import { ref } from 'vue'

/** null = still checking. */
export const signedIn = ref<boolean | null>(null)

export async function checkSignedIn(): Promise<void> {
  try {
    const response = await fetch('/api/auth')
    signedIn.value = response.ok && ((await response.json()) as { signedIn: boolean }).signedIn
  } catch {
    signedIn.value = false
  }
}

/** Returns an error message, or null when signed in. */
export async function signIn(key: string): Promise<string | null> {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  if (response.ok) {
    signedIn.value = true
    return null
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  return body.error ?? `Sign-in failed (HTTP ${response.status})`
}

export async function signOut(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {})
  signedIn.value = false
}

/**
 * Any API call answered "not signed in" (e.g. the key was changed) brings the
 * sign-in screen back, wherever it came from.
 */
export function watchForSignOut(): void {
  const original = window.fetch.bind(window)
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args)
    const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url
    if (response.status === 401 && url.includes('/api/') && !url.includes('/api/login')) signedIn.value = false
    return response
  }
}
