import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { automatedReason, ContactStore, normalisePhone } from '../contacts/store.ts'
import { parseVcards, toVcards } from '../contacts/vcard.ts'

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-contacts-'))
  return { s: new ContactStore(path.join(dir, 'c.db')), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('contacts: phone numbers and emails are kept one way, and found by name, email or part of a number', () => {
  const { s, cleanup } = store()
  assert.equal(normalisePhone('613-555-0123'), '16135550123')
  assert.equal(normalisePhone('+1 (613) 555 0123'), '16135550123')
  assert.equal(normalisePhone('+44 20 7946 0958'), '+442079460958')
  const maria = s.save({ name: 'Maria Lopez', org: 'Dentist', emails: [{ value: 'Maria@Example.com', label: 'work' }], phones: [{ value: '613 555 0123', label: 'cell' }] })
  assert.deepEqual(maria.emails, [{ value: 'maria@example.com', label: 'work' }])
  assert.deepEqual(maria.phones, [{ value: '16135550123', label: 'cell' }])
  assert.equal(s.search('maria').total, 1)
  assert.equal(s.search('dentist').total, 1)
  assert.equal(s.search('5550123').total, 1)
  assert.equal(s.search('example.com').total, 1)
  assert.equal(s.byEmail('MARIA@example.com')?.name, 'Maria Lopez')
  assert.equal(s.byPhone('(613) 555-0123')[0]?.name, 'Maria Lopez')
  // An email belongs to one person: given to someone else, it moves.
  const bob = s.save({ name: 'Bob', emails: [{ value: 'maria@example.com', label: '' }] })
  assert.equal(s.byEmail('maria@example.com')?.id, bob.id)
  assert.deepEqual(s.get(maria.id)!.emails, [])
  assert.throws(() => s.save({ name: '  ' }), /needs a name/)
  assert.equal(s.delete(bob.id), true)
  assert.equal(s.byEmail('maria@example.com'), null)
  cleanup()
})

test('contacts: addresses from email become suggestions (machines set aside), until accepted, added to someone, or ignored', () => {
  const { s, cleanup } = store()
  assert.equal(automatedReason('no-reply@accounts.example.com'), 'an automated sender')
  assert.equal(automatedReason('notifications+abc@github.com'), 'an automated sender')
  assert.equal(automatedReason('maria@example.com'), '')
  assert.equal(s.suggest('maria@example.com', 'Maria Lopez', 'email'), true)
  assert.equal(s.suggest('maria@example.com', 'Maria Lopez', 'email'), false) // once
  assert.equal(s.suggest('noreply@shop.example.com', 'Shop', 'email'), false)
  assert.equal(s.suggest('bob@example.net', 'Bob', 'email'), true)
  assert.equal(s.suggest('bob2@example.net', '', 'email'), true)
  assert.deepEqual(s.suggestions('new').map((x) => x.address).sort(), ['bob2@example.net', 'bob@example.net', 'maria@example.com'])
  assert.deepEqual(s.suggestions('ignored').map((x) => [x.address, x.reason]), [['noreply@shop.example.com', 'an automated sender']])
  // Accepted: a contact. Added to someone: their second address. Ignored: gone from the list.
  const maria = s.accept('maria@example.com')
  assert.equal(maria.name, 'Maria Lopez')
  const bob = s.accept('bob@example.net')
  s.accept('bob2@example.net', { contactId: bob.id })
  assert.deepEqual(s.get(bob.id)!.emails.map((e) => e.value), ['bob@example.net', 'bob2@example.net'])
  assert.deepEqual(s.suggestions('new'), [])
  // A known address is never suggested again.
  assert.equal(s.suggest('bob2@example.net', 'Bob', 'email'), false)
  assert.deepEqual(s.stats(), { contacts: 2, suggestions: 0, ignored: 1 })
  cleanup()
})

test('contacts: vCards from a phone are read (2.1, 3.0, 4.0, folded lines) and written back', () => {
  const vcf = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Maria Lopez',
    'N:Lopez;Maria;;;',
    'ORG:Smile Dental;Front desk',
    'EMAIL;TYPE=INTERNET;TYPE=WORK:maria@example.com',
    'TEL;TYPE=CELL:+1 613-555-0123',
    'item1.TEL:(613) 555-0199',
    'NOTE:Prefers texts\\, not calls.\\nMornings only.',
    'BDAY:1985-04-12',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N:Smith;Bob',
    'TEL;HOME:6135550111',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:4.0',
    'FN:Long',
    ' Name',
    'TEL;VALUE=uri;TYPE=work:tel:+1-613-555-0144',
    'END:VCARD',
  ].join('\r\n')
  const cards = parseVcards(vcf)
  assert.deepEqual(
    cards.map((c) => [c.name, c.org, c.emails?.map((e) => `${e.label}:${e.value}`), c.phones?.map((p) => `${p.label}:${p.value}`)]),
    [
      ['Maria Lopez', 'Smile Dental, Front desk', ['work:maria@example.com'], ['cell:+1 613-555-0123', ':(613) 555-0199']],
      ['Bob Smith', '', [], ['home:6135550111']],
      ['LongName', '', [], ['work:+1-613-555-0144']],
    ],
  )
  assert.equal(cards[0]!.notes, 'Prefers texts, not calls.\nMornings only.')
  const { s, cleanup } = store()
  const saved = s.save(cards[0]!)
  const again = parseVcards(toVcards([saved]))[0]!
  assert.equal(again.name, 'Maria Lopez')
  assert.deepEqual(again.emails, [{ value: 'maria@example.com', label: 'work' }])
  assert.equal(again.notes, 'Prefers texts, not calls.\nMornings only.')
  cleanup()
})
