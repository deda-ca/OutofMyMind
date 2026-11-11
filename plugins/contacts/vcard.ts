// vCard (.vcf), versions 2.1, 3.0 and 4.0, the parts that matter here: name,
// emails, phones, organisation, note, birthday. For importing the owner's
// contacts from a phone or another app, and exporting them back.

import { type ContactInput, type Contact, displayPhone } from './store.ts'

/** Unfolds lines (a line starting with a space continues the one before) and splits cards. */
export function parseVcards(text: string): ContactInput[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  const out: ContactInput[] = []
  let card: { fn: string; n: string; emails: { value: string; label: string }[]; phones: { value: string; label: string }[]; org: string; note: string; bday: string } | null = null
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const head = line.slice(0, colon)
    const value = unescape(line.slice(colon + 1))
    const [nameRaw = '', ...params] = head.split(';')
    const name = nameRaw.replace(/^item\d+\./i, '').toUpperCase()
    if (name === 'BEGIN' && value.toUpperCase() === 'VCARD') card = { fn: '', n: '', emails: [], phones: [], org: '', note: '', bday: '' }
    else if (!card) continue
    else if (name === 'END') {
      const display = card.fn || card.n.split(';').filter(Boolean).reverse().join(' ').trim() || card.org || card.emails[0]?.value || card.phones[0]?.value || ''
      if (display) out.push({ name: display, emails: card.emails, phones: card.phones, org: card.org, notes: card.note, birthday: card.bday })
      card = null
    } else if (name === 'FN') card.fn = value.trim()
    else if (name === 'N') card.n = value
    else if (name === 'EMAIL') card.emails.push({ value: value.trim(), label: label(params) })
    else if (name === 'TEL') card.phones.push({ value: value.replace(/^tel:/i, '').trim(), label: label(params) })
    else if (name === 'ORG') card.org = value.split(';').filter(Boolean).join(', ').trim()
    else if (name === 'NOTE') card.note = value.trim()
    else if (name === 'BDAY') card.bday = value.trim().slice(0, 10)
  }
  return out
}

/** "TYPE=CELL", "TYPE=work,voice", "HOME" (2.1) → "cell", "work", "home". */
function label(params: string[]): string {
  const types = params.flatMap((p) => (p.toUpperCase().startsWith('TYPE=') ? p.slice(5).split(',') : p.includes('=') ? [] : [p])).map((t) => t.toLowerCase().replace(/"/g, ''))
  return types.find((t) => ['cell', 'mobile', 'home', 'work', 'main', 'iphone', 'other'].includes(t))?.replace('mobile', 'cell') ?? ''
}

function unescape(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
}

function escape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1')
}

export function toVcards(contacts: Contact[]): string {
  return contacts
    .map((c) =>
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${escape(c.name)}`,
        `N:${escape(c.name.split(' ').slice(1).join(' '))};${escape(c.name.split(' ')[0] ?? '')};;;`,
        ...(c.org ? [`ORG:${escape(c.org)}`] : []),
        ...c.emails.map((e) => `EMAIL${e.label ? `;TYPE=${e.label.toUpperCase()}` : ''}:${e.value}`),
        ...c.phones.map((p) => `TEL${p.label ? `;TYPE=${p.label.toUpperCase()}` : ''}:${displayPhone(p.value).replace(/^\+1 /, '+1-')}`),
        ...(c.birthday ? [`BDAY:${c.birthday}`] : []),
        ...(c.notes ? [`NOTE:${escape(c.notes)}`] : []),
        'END:VCARD',
      ].join('\r\n'),
    )
    .join('\r\n')
}
