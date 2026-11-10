import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '../src/assistant/llm.ts'
import { GENERIC, ProgressSpeaker, STILL, describeActivity } from '../src/assistant/progress.ts'

/** A speaker on a fake clock: advance(ms) moves time on and checks, like the real timer. */
function setup(firstAfterMs = 4000, random = () => 0) {
  let now = 0
  const said: string[] = []
  const speaker = new ProgressSpeaker({ say: (l) => said.push(l), firstAfterMs, random, now: () => now, tickMs: 0 })
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += 250) {
      now += 250
      speaker.tick()
    }
  }
  return { speaker, said, advance }
}

const call = (name: string, args: object, crud = ['read'], status: 'running' | 'done' = 'running'): AgentEvent => ({
  kind: 'tool',
  label: name,
  call: { id: name, name, args: JSON.stringify(args), crud, status },
})

test('it says what it is doing once the first wait is over, not before', () => {
  const { speaker, said, advance } = setup()
  speaker.event(call('web__search', { query: 'bus fares Ottawa to Montreal' }))
  advance(3750)
  assert.deepEqual(said, [])
  advance(250)
  assert.deepEqual(said, ['Searching the web for bus fares Ottawa to Montreal.'])
})

test('no tool yet: a generic line; then what it starts doing; then "still" lines, never twice in a row, at most four', () => {
  const { speaker, said, advance } = setup(4000, () => 0)
  advance(4000)
  assert.deepEqual(said, [GENERIC[0]])
  speaker.event(call('browser__browser_navigate', { url: 'https://www.nhl.com/senators' }))
  advance(8000)
  assert.equal(said[1], 'Opening nhl.com.')
  speaker.event(call('browser__browser_navigate', { url: 'https://www.nhl.com/senators' }, ['read'], 'done'))
  advance(8000)
  advance(8000)
  advance(8000)
  assert.equal(said.length, 4)
  assert.deepEqual(said.slice(2), [STILL[0], STILL[1]]) // the same pick (random 0) is skipped the second time
})

test('nothing while the answer is being said; a tool after it is announced after a pause', () => {
  const { speaker, said, advance } = setup()
  advance(2000)
  speaker.text()
  advance(20_000)
  assert.deepEqual(said, [])
  speaker.event(call('weather__get_weather', { location: 'Gatineau' }))
  advance(4000)
  assert.deepEqual(said, ['Checking the weather in Gatineau.'])
})

test('Hermes approval requests are said straight away', () => {
  const { speaker, said } = setup()
  speaker.event({ kind: 'approval', label: 'rm -rf build' })
  assert.deepEqual(said, ['Hermes needs your approval for that.'])
})

test('what each tool is doing, in words', () => {
  const W = '/home/me/jarvis/data/workspace'
  assert.equal(describeActivity(call('files__read_text_file', { path: `${W}/todo.md` })), 'Reading your to-do list.')
  assert.equal(describeActivity(call('files__edit_file', { path: `${W}/lists/shopping.md` }, ['update'])), 'Updating your shopping list.')
  assert.equal(describeActivity(call('files__list_directory', { path: W })), 'Looking through your files.')
  assert.equal(describeActivity(call('notes__append_to_note', { path: 'x' }, ['create', 'update'])), 'Updating your notes.')
  assert.equal(describeActivity(call('web__fetch_page', { url: 'https://www.cbc.ca/news' })), 'Reading a page on cbc.ca.')
  assert.equal(describeActivity(call('web__search', { query: 'a'.repeat(80) })), 'Searching the web.')
  assert.equal(describeActivity(call('browser__browser_type', { text: 'x' }, ['create'])), 'Filling in the page.')
  assert.equal(describeActivity(call('browser__browser_find', { text: 'login' })), 'Looking at the page.')
  assert.equal(describeActivity(call('scripts__run_script', { code: '1+1' }, ['create'])), 'Working that out.')
  assert.equal(describeActivity(call('jarvis__set_schedule', {}, ['create'])), 'Setting that up.')
  assert.equal(describeActivity(call('github__get_issue', {})), 'Looking that up.')
  // Hermes: a label only.
  assert.equal(describeActivity({ kind: 'tool', label: 'web_search' }), 'Searching the web.')
  assert.equal(describeActivity({ kind: 'tool', label: 'terminal: ls -la' }), 'Running a command.')
  assert.equal(describeActivity({ kind: 'tool', label: 'something new' }), 'Working on it.')
})
