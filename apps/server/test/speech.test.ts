import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SentenceSplitter, forSpeech, spokenSentences } from '../src/assistant/speech.ts'

function split(chunks: string[]): string[] {
  const s = new SentenceSplitter()
  return [...chunks.flatMap((c) => s.push(c)), ...s.flush()]
}

test('sentences come out as soon as they end, from streamed pieces', () => {
  const s = new SentenceSplitter()
  assert.deepEqual(s.push('The capital of Canada'), [])
  assert.deepEqual(s.push(' is Ottawa. It sits on'), ['The capital of Canada is Ottawa.'])
  assert.deepEqual(s.push(' the Ottawa River.'), [])
  assert.deepEqual(s.flush(), ['It sits on the Ottawa River.'])
})

test('decimals and abbreviations-like dots without a space do not split', () => {
  assert.deepEqual(split(['Over 4.5 billion years old. ', 'Version 2.0.1 is out!']), ['Over 4.5 billion years old.', 'Version 2.0.1 is out!'])
})

test('very short sentences are joined with the next one', () => {
  assert.deepEqual(split(['Sure. ', 'I added milk to the list. ', 'Done.']), ['Sure. I added milk to the list.', 'Done.'])
})

test('questions, exclamations, quotes and line breaks end sentences', () => {
  assert.deepEqual(split(['Did you mean Paris? ', 'She said "Hello there." ', 'Okay then\nNext line here']), [
    'Did you mean Paris?',
    'She said "Hello there."',
    'Okay then',
    'Next line here',
  ])
})

test('markdown is cleaned for speaking', () => {
  assert.equal(forSpeech('**Ottawa** is the `capital`. See [the map](https://example.com) or https://x.y/z'), 'Ottawa is the capital. See the map or a link')
  assert.equal(forSpeech('- one\n- two'), 'one two')
})

test('a whole reply as spoken: sentences, markdown cleaned, long ones cut for text-to-speech', () => {
  assert.deepEqual(spokenSentences('**Hi** there, friend. 4.5 km away!\n\n```\ncode\n```\n---'), ['Hi there, friend.', '4.5 km away!'])
  const long = Array.from({ length: 120 }, (_, i) => `part ${i}`).join(', ') + '.'
  const pieces = spokenSentences(long)
  assert.ok(pieces.length >= 2)
  assert.ok(pieces.every((p) => p.length <= 900))
  assert.equal(pieces.join(' '), long)
  assert.match(pieces[0]!, /,$/)
})

test('quick start: a reply first says its first clause, if it has one long enough', () => {
  const s = new SentenceSplitter({ quickStart: true })
  assert.deepEqual(s.push('Sure, the weather today'), [])
  assert.deepEqual(s.push(' is sunny, with a high of 20. It may'), ['Sure, the weather today is sunny,', 'with a high of 20.'])
  assert.deepEqual(s.push(' rain later, so take a coat. '), ['It may rain later, so take a coat.'])
})

test('quick start: short clauses, numbers and times are not split off', () => {
  const s = new SentenceSplitter({ quickStart: true })
  assert.deepEqual(s.push('Yes, sir, I can hear you. '), ['Yes, sir, I can hear you.'])
  const n = new SentenceSplitter({ quickStart: true })
  assert.deepEqual([...n.push('It costs 1,000 dollars at 10:30 today. '), ...n.flush()], ['It costs 1,000 dollars at 10:30 today.'])
})

test('an empty thinking block is not said aloud', () => {
  assert.equal(forSpeech('<think>'), '')
  assert.equal(forSpeech('</think>'), '')
})
