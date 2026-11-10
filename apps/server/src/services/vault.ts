// Secrets for services (docs/services.md): DATA_DIR/secrets.json, mode 600,
// outside the workspace and not in the data history. The owner types values in
// the Services tab; nothing ever returns a value to the LLM or the client. A
// service gets one only through its gate, and only if its approved manifest
// lists it. Values are blanked out of logs and events (redact).

import fs from 'node:fs'
import path from 'node:path'
import { SECRET_NAME } from './manifest.ts'

export interface SecretInfo {
  name: string
  description: string
  /** Whether a value has been typed. */
  set: boolean
  setAt?: string
  /** Asked for by Jarvis (service_needs_secret), not set yet. */
  requested?: boolean
}

interface Entry {
  description: string
  value?: string
  setAt?: string
  requested?: boolean
}

export class VaultError extends Error {}

export class Vault {
  private readonly file: string
  private entries: Record<string, Entry> = {}

  constructor(file: string) {
    this.file = file
    try {
      this.entries = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Entry>
    } catch {
      // none yet
    }
  }

  list(): SecretInfo[] {
    return Object.entries(this.entries)
      .map(([name, e]) => ({ name, description: e.description, set: e.value !== undefined, ...(e.setAt ? { setAt: e.setAt } : {}), ...(e.requested && e.value === undefined ? { requested: true } : {}) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  has(name: string): boolean {
    return this.entries[name]?.value !== undefined
  }

  /** The value, for the gate only. */
  get(name: string): string | undefined {
    return this.entries[name]?.value
  }

  set(name: string, value: string, description?: string): void {
    check(name)
    if (!value) throw new VaultError('The value is empty')
    if (value.length > 8192) throw new VaultError('At most 8,192 characters')
    const old = this.entries[name]
    this.entries[name] = { description: (description ?? old?.description ?? '').trim().slice(0, 200), value, setAt: new Date().toISOString() }
    this.save()
  }

  /** Jarvis asks the owner for one: shown in the Services tab with its description. */
  request(name: string, description: string): void {
    check(name)
    const old = this.entries[name]
    this.entries[name] = { ...old, description: description.trim().slice(0, 200) || old?.description || '', ...(old?.value === undefined ? { requested: true } : {}) }
    this.save()
  }

  remove(name: string): void {
    delete this.entries[name]
    this.save()
  }

  /** Text with the given secrets' values replaced by "[secret name]". */
  redact(text: string, names: string[]): string {
    let out = text
    for (const name of names) {
      const value = this.entries[name]?.value
      if (!value || value.length < 4) continue
      // The whole value, and each line of a multi-line one (a JSON secret's password field).
      for (const piece of [value, ...value.split(/\r?\n/), ...fields(value)]) {
        if (piece.length >= 4) out = out.split(piece).join(`[secret ${name}]`)
      }
    }
    return out
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(this.entries, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    fs.chmodSync(this.file, 0o600)
  }
}

function check(name: string): void {
  if (!SECRET_NAME.test(name)) throw new VaultError('A secret name has letters, digits, - and _ only (at most 40)')
}

/** The string values inside a JSON secret ({"user": …, "password": …}), so each is redacted on its own. */
function fields(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object') return Object.values(parsed).filter((v): v is string => typeof v === 'string')
  } catch {
    // not JSON
  }
  return []
}
