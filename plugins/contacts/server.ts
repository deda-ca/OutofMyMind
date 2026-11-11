// The contacts plugin (docs/contacts.md): the owner's people, with their emails
// and phone numbers, for "email Maria", "call the dentist", "who is this?".
//
// It learns from other plugins through the server (no direct calls): it
// subscribes to email.address-seen, and every address seen for the first time
// becomes a suggestion in the Contacts tab (machines like no-reply@ are set
// aside), until the owner accepts it, adds it to someone, or ignores it.
// Nothing becomes a contact without the owner, except what they or Jarvis add.

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { createPlugin, emit, failure, log, onServerEvent, pluginDataDir, pluginWorkspaceDir, refreshTab, serve, text } from '../kit/plugin.ts'
import { type Contact, ContactStore, displayPhone, normaliseEmail } from './store.ts'
import { parseVcards, toVcards } from './vcard.ts'

const dataDir = pluginDataDir || path.resolve('data')
fs.mkdirSync(dataDir, { recursive: true })
const store = new ContactStore(path.join(dataDir, 'contacts.db'))

const plugin = createPlugin(
  'contacts',
  '0.1.0',
  "The owner's contacts: people with their emails and phone numbers. Look someone up before emailing, texting or calling them (\"Maria\" → her address or number), and to say who an address or number belongs to.",
)

const describe = (c: Contact) =>
  [
    `- ${c.name}${c.org ? ` (${c.org})` : ''} [${c.id}]`,
    ...c.emails.map((e) => `  email${e.label ? ` (${e.label})` : ''}: ${e.value}`),
    ...c.phones.map((p) => `  phone${p.label ? ` (${p.label})` : ''}: ${displayPhone(p.value)}`),
    ...(c.birthday ? [`  birthday: ${c.birthday}`] : []),
    ...(c.tags.length ? [`  tags: ${c.tags.join(', ')}`] : []),
    ...(c.notes ? [`  notes: ${c.notes.replace(/\s+/g, ' ').slice(0, 300)}`] : []),
  ].join('\n')

const changed = async (c: Contact, kind: 'contact.added' | 'contact.updated') => {
  emit(plugin, kind, { id: c.id, name: c.name, emails: c.emails.map((e) => e.value), phones: c.phones.map((p) => p.value) })
  await refreshTab(plugin)
}

// ------------------------------------------------------------------ learning from other plugins

onServerEvent(plugin, (type, payload) => {
  if (type !== 'email.address-seen') return
  const address = String(payload.address ?? '')
  // Only people who wrote to the owner, or the owner wrote to; a cc'd stranger is a suggestion too, the owner decides.
  if (store.suggest(address, String(payload.name ?? ''), String(payload.from ?? 'email'), typeof payload.at === 'string' ? payload.at : undefined)) void refreshTab(plugin)
})

// ------------------------------------------------------------------ tools for Jarvis

const list = (s: string | undefined) =>
  (s ?? '')
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)

plugin.registerTool(
  'find_contact',
  {
    description: "Find people in the owner's contacts by name, organisation, email or part of a phone number. Returns their emails and phone numbers. Use it before emailing, texting or calling someone by name.",
    inputSchema: { query: z.string().min(1).describe('A name ("Maria"), an organisation ("dentist"), an email or digits of a number.'), limit: z.number().int().min(1).max(20).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ query, limit }) => {
    const r = store.search(query, { limit: limit ?? 5 })
    if (!r.contacts.length) return text(`No contact matches "${query}". (The email plugin's email_addresses may know the address.)`)
    return text(`${r.total} match${r.total === 1 ? '' : 'es'}:\n${r.contacts.map(describe).join('\n')}`)
  },
)

plugin.registerTool(
  'who_is',
  {
    description: 'Who an email address or a phone number belongs to, in the owner\'s contacts.',
    inputSchema: { value: z.string().min(3).describe('An email address or a phone number.') },
    annotations: { readOnlyHint: true },
  },
  async ({ value }) => {
    const found = value.includes('@') ? [store.byEmail(value)].filter((c): c is Contact => c !== null) : store.byPhone(value)
    return text(found.length ? found.map(describe).join('\n') : `${value} isn't in the contacts.`)
  },
)

plugin.registerTool(
  'add_contact',
  {
    description: "Add someone to the owner's contacts (when the owner asks, or says who someone is). Find first: if they're already there, use update_contact.",
    inputSchema: {
      name: z.string().min(1),
      emails: z.string().optional().describe('Comma-separated.'),
      phones: z.string().optional().describe('Comma-separated.'),
      org: z.string().optional().describe('Company or what they are ("dentist").'),
      notes: z.string().optional(),
      birthday: z.string().optional().describe('YYYY-MM-DD.'),
      tags: z.string().optional().describe('Comma-separated, e.g. "family, school".'),
    },
  },
  async (a) => {
    const c = store.save({ name: a.name, emails: list(a.emails).map((value) => ({ value, label: '' })), phones: list(a.phones).map((value) => ({ value, label: '' })), org: a.org, notes: a.notes, birthday: a.birthday, tags: list(a.tags) })
    await changed(c, 'contact.added')
    return text(`Added:\n${describe(c)}`)
  },
)

plugin.registerTool(
  'update_contact',
  {
    description: 'Change a contact: add or remove emails and phone numbers, rename, organisation, notes, birthday, tags. Give its id (from find_contact).',
    inputSchema: {
      id: z.string().min(1),
      name: z.string().optional(),
      add_emails: z.string().optional(),
      remove_emails: z.string().optional(),
      add_phones: z.string().optional(),
      remove_phones: z.string().optional(),
      org: z.string().optional(),
      notes: z.string().optional().describe('Replaces the notes.'),
      birthday: z.string().optional(),
      tags: z.string().optional().describe('Replaces the tags (comma-separated).'),
    },
  },
  async (a) => {
    const c = store.get(a.id)
    if (!c) return failure(`No contact "${a.id}": use find_contact for the id.`)
    const dropEmails = new Set(list(a.remove_emails).map(normaliseEmail))
    const dropPhones = new Set(list(a.remove_phones).map((p) => p.replace(/\D/g, '').slice(-10)))
    const next = store.save({
      ...c,
      ...(a.name ? { name: a.name } : {}),
      ...(a.org !== undefined ? { org: a.org } : {}),
      ...(a.notes !== undefined ? { notes: a.notes } : {}),
      ...(a.birthday !== undefined ? { birthday: a.birthday } : {}),
      ...(a.tags !== undefined ? { tags: list(a.tags) } : {}),
      emails: [...c.emails.filter((e) => !dropEmails.has(e.value)), ...list(a.add_emails).map((value) => ({ value, label: '' }))],
      phones: [...c.phones.filter((p) => !dropPhones.has(p.value.slice(-10))), ...list(a.add_phones).map((value) => ({ value, label: '' }))],
    })
    await changed(next, 'contact.updated')
    return text(`Updated:\n${describe(next)}`)
  },
)

// ------------------------------------------------------------------ tools for the Contacts tab (JSON)

const json = (v: unknown) => text(JSON.stringify(v))

plugin.registerTool('tab_status', { description: 'Contacts tab: counts and tags.', inputSchema: {} }, async () => json({ ...store.stats(), tags: store.tags() }))

plugin.registerTool(
  'tab_list',
  { description: 'Contacts tab: a page of contacts.', inputSchema: { query: z.string().optional(), tag: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() } },
  async (a) => json(store.search(a.query ?? '', { tag: a.tag, offset: a.offset, limit: a.limit ?? 200 })),
)

plugin.registerTool('tab_get', { description: 'Contacts tab: one contact.', inputSchema: { id: z.string() } }, async ({ id }) => {
  const c = store.get(id)
  return c ? json(c) : failure('No such contact.')
})

const labeled = z.array(z.object({ value: z.string(), label: z.string() }))

plugin.registerTool(
  'tab_save',
  {
    description: 'Contacts tab: save a contact (new without an id).',
    inputSchema: { id: z.string().optional(), name: z.string(), org: z.string().optional(), notes: z.string().optional(), birthday: z.string().optional(), tags: z.array(z.string()).optional(), emails: labeled.optional(), phones: labeled.optional() },
  },
  async (a) => {
    const isNew = !a.id || !store.get(a.id)
    try {
      const c = store.save(a)
      await changed(c, isNew ? 'contact.added' : 'contact.updated')
      return json(c)
    } catch (err) {
      return failure((err as Error).message)
    }
  },
)

plugin.registerTool('tab_delete', { description: 'Contacts tab: delete a contact.', inputSchema: { id: z.string() } }, async ({ id }) => {
  const ok = store.delete(id)
  if (ok) {
    emit(plugin, 'contact.deleted', { id })
    await refreshTab(plugin)
  }
  return json({ deleted: ok })
})

plugin.registerTool(
  'tab_suggestions',
  { description: 'Contacts tab: suggested (or ignored) addresses.', inputSchema: { status: z.enum(['new', 'ignored']).optional() } },
  async ({ status }) => json(store.suggestions(status ?? 'new')),
)

plugin.registerTool(
  'tab_accept',
  { description: 'Contacts tab: accept a suggestion (a new contact, or added to one).', inputSchema: { address: z.string(), contact_id: z.string().optional(), name: z.string().optional() } },
  async ({ address, contact_id, name }) => {
    try {
      const c = store.accept(address, { contactId: contact_id, name })
      await changed(c, contact_id ? 'contact.updated' : 'contact.added')
      return json(c)
    } catch (err) {
      return failure((err as Error).message)
    }
  },
)

plugin.registerTool(
  'tab_ignore',
  { description: 'Contacts tab: ignore a suggestion (or bring an ignored one back).', inputSchema: { address: z.string(), ignore: z.boolean().optional() } },
  async ({ address, ignore }) => json({ ok: store.setSuggestion(address, ignore === false ? 'new' : 'ignored') }),
)

plugin.registerTool(
  'tab_import',
  { description: 'Contacts tab: import a vCard file (.vcf). People already there (same email or phone) are merged.', inputSchema: { vcf: z.string().max(5_000_000) } },
  async ({ vcf }) => {
    let added = 0
    let merged = 0
    for (const card of parseVcards(vcf)) {
      // The same person (an email or a phone already known): merged into them.
      const known = card.emails?.map((e) => store.byEmail(e.value)).find(Boolean) ?? card.phones?.flatMap((p) => store.byPhone(p.value))[0] ?? null
      if (known) {
        const emails = [...known.emails, ...(card.emails ?? []).filter((e) => !known.emails.some((k) => k.value === normaliseEmail(e.value)))]
        const phones = [...known.phones, ...(card.phones ?? [])]
        store.save({ ...known, emails, phones, org: known.org || card.org || '', notes: known.notes || card.notes || '', birthday: known.birthday || card.birthday || '' })
        merged++
      } else {
        store.save(card)
        added++
      }
    }
    await refreshTab(plugin)
    return json({ added, merged })
  },
)

plugin.registerTool('tab_export', { description: 'Contacts tab: export everyone as a vCard file into the workspace (contacts/contacts.vcf).', inputSchema: {} }, async () => {
  if (!pluginWorkspaceDir) return failure('No workspace folder for contacts.')
  const all = store.search('', { limit: 500 }).contacts
  fs.mkdirSync(pluginWorkspaceDir, { recursive: true })
  fs.writeFileSync(path.join(pluginWorkspaceDir, 'contacts.vcf'), toVcards(all))
  return json({ file: 'contacts/contacts.vcf', count: all.length })
})

log(`contacts: ${store.stats().contacts} contacts, ${store.stats().suggestions} suggestions`)
await serve(plugin)
