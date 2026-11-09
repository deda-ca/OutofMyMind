import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { SkillGuard } from '../src/skills/guard.ts'
import { SkillLibrary, globMatch, skillIndex } from '../src/skills/library.ts'

function library() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skills-'))
  const skills = new SkillLibrary(ws)
  skills.seed()
  return { ws, skills }
}

test('starter skills: seeded once, listed, matched by file and by request', () => {
  const { ws, skills } = library()
  assert.deepEqual(skills.list().map((s) => s.id), ['todo', 'weight-log'])
  const todo = skills.get('todo')!
  assert.equal(todo.name, 'To-do list')
  assert.deepEqual(todo.files, ['todo.md'])
  assert.doesNotMatch(todo.body, /<!--/)
  assert.deepEqual(skills.forPath('todo.md').map((s) => s.id), ['todo'])
  assert.deepEqual(skills.forPath('logs/weight.md').map((s) => s.id), ['weight-log'])
  assert.deepEqual(skills.forPath('notes/todo.md'), [])
  assert.deepEqual(skills.triggered('Add buy milk to my to-do list').map((s) => s.id), ['todo'])
  assert.deepEqual(skills.triggered('I weighed 82 kilos').map((s) => s.id), ['weight-log'])
  assert.deepEqual(skills.triggered("What's the weather?"), [])
  assert.equal(skills.find('To-do list')?.id, 'todo')
  assert.equal(skills.find('weight')?.id, 'weight-log')
  fs.rmSync(path.join(ws, 'skills', 'weight-log.md'))
  skills.seed() // the folder exists: nothing re-created
  assert.deepEqual(skills.list().map((s) => s.id), ['todo'])
  assert.match(skillIndex(skills.list())!, /- To-do list \(todo\): .* Files: todo\.md\./)
})

test('globs: * within a folder, ** across folders', () => {
  assert.equal(globMatch('logs/*.md', 'logs/weight.md'), true)
  assert.equal(globMatch('logs/*.md', 'logs/2026/weight.md'), false)
  assert.equal(globMatch('logs/**', 'logs/2026/weight.md'), true)
  assert.equal(globMatch('TODO.md', 'todo.md'), true)
})

test('Jarvis adds dated rules under a section (made if missing), and creates skills', () => {
  const { ws, skills } = library()
  const before = fs.readFileSync(path.join(ws, 'skills/todo.md'), 'utf8')
  skills.addRule('todo', 'Adding', 'Add a priority: (high), (normal) or (low).', '2026-11-09')
  skills.addRule('todo', '## Reviews', '- Every Sunday, list what is overdue.', '2026-11-09')
  const after = fs.readFileSync(path.join(ws, 'skills/todo.md'), 'utf8')
  const adding = after.slice(after.indexOf('## Adding'), after.indexOf('## Completing'))
  assert.match(adding, /- Add a priority: \(high\), \(normal\) or \(low\)\. <!-- added 2026-11-09 -->\n\n$/)
  assert.match(after, /\n## Reviews\n- Every Sunday, list what is overdue\. <!-- added 2026-11-09 -->\n$/)
  // Nothing else changed.
  assert.equal(after.replace(/- Add a priority.*\n/, '').replace(/\n\n## Reviews\n.*\n$/, '\n'), before)
  assert.throws(() => skills.addRule('nope', 'x', 'y', '2026-11-09'), /No skill/)

  const sleep = skills.create({ name: 'Sleep log', description: 'Bedtime, wake time, how I slept', files: ['logs/sleep.md'], triggers: ['slept', 'woke up'], body: '## Recording\n- One row per night.' })
  assert.equal(sleep.id, 'sleep-log')
  assert.deepEqual(skills.forPath('logs/sleep.md').map((s) => s.id), ['sleep-log'])
  assert.throws(() => skills.create({ name: 'Sleep log', description: '', files: [], triggers: [], body: '' }), /already a skill/)
})

test('the guard: rules after a read; a change before the rules is refused once, then allowed', () => {
  const { ws, skills } = library()
  const abs = path.join(ws, 'todo.md')
  // Reading the file: the result comes with the rules.
  const read = new SkillGuard(skills, ws)
  const withRules = read.after('files__read_text_file', { path: abs }, ['read'], { text: '# To-do', isError: false })
  assert.match(withRules.text, /^# To-do\n\n\(todo\.md follows a skill\. Skill "To-do list"/)
  assert.equal(read.after('files__read_text_file', { path: abs }, ['read'], { text: 'again', isError: false }).text, 'again') // once per reply
  assert.equal(read.before('files__append_file', { path: abs, content: '- [ ] x' }, ['create', 'update']), null) // rules already seen

  // Writing straight away: refused once with the rules, then allowed.
  const write = new SkillGuard(skills, ws)
  const refused = write.before('files__append_file', { path: abs, content: '- [ ] milk' }, ['create', 'update'])
  assert.ok(refused?.isError)
  assert.match(refused!.text, /^Not done yet: todo\.md follows a skill\..*Skill "To-do list"/s)
  assert.equal(write.before('files__append_file', { path: abs, content: '- [ ] milk' }, ['create', 'update']), null)

  // Already called for by the request: no refusal. Other files, reads, and Jarvis's own tools: untouched.
  const asked = new SkillGuard(skills, ws)
  asked.markShown(skills.triggered('add milk to my to-do list'))
  assert.equal(asked.before('files__write_file', { path: abs }, ['create', 'update']), null)
  const other = new SkillGuard(skills, ws)
  assert.equal(other.before('files__write_file', { path: path.join(ws, 'notes/x.md') }, ['create', 'update']), null)
  assert.equal(other.before('files__read_text_file', { path: abs }, ['read']), null)
  assert.equal(other.before('jarvis__show_file', { path: 'todo.md' }, ['read']), null)
  // move_file names both ends.
  assert.ok(new SkillGuard(skills, ws).before('files__move_file', { source: path.join(ws, 'x.md'), destination: path.join(ws, 'logs/weight.md') }, ['update'])?.isError)
})

test('templates: a governed file is created from its skill template when the skill comes into play, never overwritten', () => {
  const { ws, skills } = library()
  const todo = skills.get('todo')!
  assert.equal(todo.template, '# To-do\n\n## Today\n\n## This week\n\n## Later\n\n## Done')
  assert.match(skills.get('weight-log')!.template!, /^# Weight log\n\n\| Date \| Time \| Weight \| Unit \| Notes \|/)

  const guard = new SkillGuard(skills, ws)
  guard.markShown(skills.triggered('add milk to my to-do list'))
  assert.equal(fs.readFileSync(path.join(ws, 'todo.md'), 'utf8'), `${todo.template}\n`)
  fs.writeFileSync(path.join(ws, 'todo.md'), '# Mine\n')
  new SkillGuard(skills, ws).markShown([todo])
  assert.equal(fs.readFileSync(path.join(ws, 'todo.md'), 'utf8'), '# Mine\n')

  // Made through the guard too (the request didn't mention it), with folders.
  new SkillGuard(skills, ws).before('files__append_file', { path: path.join(ws, 'logs/weight.md'), content: '|x|' }, ['create', 'update'])
  assert.match(fs.readFileSync(path.join(ws, 'logs/weight.md'), 'utf8'), /^# Weight log\n/)

  // A skill Jarvis creates can carry one.
  const sleep = skills.create({ name: 'Sleep log', description: 'x', files: ['logs/sleep.md'], triggers: ['slept'], body: '## Recording\n- A row.', template: '# Sleep log\n\n| Date | Bed |\n|---|---|' })
  assert.equal(sleep.template, '# Sleep log\n\n| Date | Bed |\n|---|---|')
})

test('an append to a governed file starts on a new line', () => {
  const { ws, skills } = library()
  const guard = new SkillGuard(skills, ws)
  guard.markShown([skills.get('weight-log')!])
  const file = path.join(ws, 'logs/weight.md')
  fs.appendFileSync(file, '| 2026-11-09 | 15:36 | 82.4 | kg |  |') // no line ending
  const args = { path: file, content: '| 2026-11-09 | 08:00 | 81.9 | kg | gym |\n' }
  assert.equal(guard.before('files__append_file', args, ['create', 'update']), null)
  assert.equal(args.content, '\n| 2026-11-09 | 08:00 | 81.9 | kg | gym |\n')
  const fine = { path: file, content: 'x' }
  fs.appendFileSync(file, '\n')
  guard.before('files__append_file', fine, ['create', 'update'])
  assert.equal(fine.content, 'x')
})
