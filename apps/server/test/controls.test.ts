import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectControl } from '../src/assistant/controls.ts'

test('stop', () => {
  for (const t of ['Stop.', 'Stop!', 'Jarvis, stop.', 'Stop talking.', 'Okay, that’s enough.', 'Quiet please.', 'Wait.', 'Hold on.', 'Hang on, Jarvis.', 'Shut up.', 'Pause.']) {
    assert.equal(detectControl(t), 'stop', t)
  }
})

test('continue', () => {
  for (const t of ['Continue.', 'Go on.', 'Jarvis, keep going.', 'Carry on.', 'Okay, go ahead.', 'Resume.', 'Please continue.']) {
    assert.equal(detectControl(t), 'continue', t)
  }
})

test('repeat', () => {
  for (const t of ['Repeat that.', 'Say that again.', 'Jarvis, say that again.', 'What was that?', 'Pardon?', 'Come again?', 'Can you repeat that?', 'What did you say?']) {
    assert.equal(detectControl(t), 'repeat', t)
  }
})

test('sentences that merely contain the words are not commands', () => {
  for (const t of [
    'Stop by the store on the way home.',
    'Can you continue the story from where the dragon appeared?',
    'Repeat after me: the rain in Spain stays mainly in the plain.',
    'What is the weather tomorrow?',
    'I need to wait for the bus.',
    'Jarvis, what time is it?',
  ]) {
    assert.equal(detectControl(t), null, t)
  }
})

