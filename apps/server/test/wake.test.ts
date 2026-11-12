import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasWakeWord, isDismissal, isWakeOnly, withoutWakeWord } from '../src/assistant/wake.ts'

test('wake word in any case and punctuation', () => {
  for (const t of ['Jarvis, what time is it?', 'jarvis what time is it', 'Hey Jarvis.', 'What do you think, Jarvis?', 'JARVIS!']) {
    assert.ok(hasWakeWord(t), t)
  }
  for (const t of ['Jar vis', 'Jarvisson called', 'What time is it?']) assert.ok(!hasWakeWord(t), t)
})

test('request without the wake word', () => {
  assert.equal(withoutWakeWord('Jarvis, what time is it?'), 'what time is it?')
  assert.equal(withoutWakeWord('Hey Jarvis, turn on the lights.'), 'turn on the lights.')
  assert.equal(withoutWakeWord('What do you think, Jarvis?'), 'What do you think')
})

test('wake word alone', () => {
  for (const t of ['Jarvis.', 'Hey Jarvis!', 'jarvis?', 'Okay, Jarvis.']) assert.ok(isWakeOnly(t), t)
  assert.ok(!isWakeOnly('Jarvis, what time is it?'))
})

test('dismissals with the wake word, idle or in conversation', () => {
  for (const t of ['Thanks, Jarvis.', 'Thank you Jarvis!', "That's all, Jarvis.", 'Goodbye, Jarvis.', 'Jarvis, go to sleep.', 'Jarvis, stop listening.', 'Okay, thank you, Jarvis, that is all.']) {
    assert.ok(isDismissal(t, false), t)
    assert.ok(isDismissal(t, true), t)
  }
})

test('dismissals without the wake word only count in a conversation', () => {
  for (const t of ["That's all.", 'Thanks, that is all.', 'Goodbye.', 'Never mind.', "Okay, I'm done.", 'Stop listening.']) {
    assert.ok(isDismissal(t, true), t)
    assert.ok(!isDismissal(t, false), t)
  }
})

test('not dismissals', () => {
  for (const t of [
    'Jarvis, thanks for the reminder earlier, what is next on my list?',
    'Thanks. Can you also check the weather?',
    'Jarvis, what does goodbye mean in French and Spanish and German please?',
    'I said goodbye to her yesterday.',
  ]) {
    assert.ok(!isDismissal(t, true), t)
  }
})

test("agents' names wake Jarvis too, and say which agent was meant", async () => {
  const { addressedAgent, canonical, setAgentNames } = await import('../src/assistant/wake.ts')
  setAgentNames([
    { id: 'jarvis', name: 'Jarvis' },
    { id: 'chef', name: 'Chef' },
    { id: 'email-helper', name: 'Email Helper' },
    { id: 'x', name: 'X' }, // too short to be a wake word
  ])
  assert.equal(canonical('Chef, how long do I boil an egg?'), 'Jarvis, how long do I boil an egg?')
  assert.equal(hasWakeWord(canonical('ok chef what is for dinner')), true)
  assert.equal(addressedAgent('Chef, how long do I boil an egg?'), 'chef')
  assert.equal(addressedAgent('email helper, any news?'), 'email-helper')
  assert.equal(addressedAgent('Jarvis, the weather?'), 'jarvis')
  // The first name said is the one meant; a name inside another word isn't a name.
  assert.equal(addressedAgent('Chef, ask Jarvis later'), 'chef')
  assert.equal(addressedAgent('the chefs were great'), null)
  assert.equal(addressedAgent('x marks the spot'), null)
  assert.equal(isWakeOnly(canonical('Hey Chef')), true)
  assert.equal(isDismissal(canonical('thanks, Chef'), false), true)
  assert.equal(withoutWakeWord(canonical('Chef, what can I make with eggs?')), 'what can I make with eggs?')
  setAgentNames([])
})
