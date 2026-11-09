// Skills: how Jarvis handles a kind of thing (the to-do list, a weight log, …),
// as Markdown files in WORKSPACE_DIR/skills, one each:
//
//   ---
//   name: To-do list
//   description: Adding, completing and organising to-dos
//   files: [todo.md]                         # workspace files it governs (globs: *, **)
//   triggers: [to-do, todo, task, remind me to]   # words in a request that call for it
//   ---
//   ## Adding
//   - One line each: `- [ ] Task · added 2026-11-09 14:30`
//
//   ## Template
//   ```markdown
//   # To-do
//   ## Today
//   …
//   ```
//
// A "## Template" section's code block is what the governed file starts as:
// Jarvis's code creates the file from it the first time it's needed, so the
// layout is always right (a small model builds it unreliably).
// They reach the LLM three ways (guard.ts, assistant.ts): an index in the
// system prompt; the whole skill when a request mentions a trigger; and the
// rules attached when a tool touches a governed file, with a one-time refusal
// if it tries to change one before seeing them. Jarvis can add rules (dated)
// and create skills when the owner asks; removing rules is for the owner.

import fs from 'node:fs'
import path from 'node:path'

export interface Skill {
  /** File name without ".md". */
  id: string
  name: string
  description: string
  /** Workspace paths it governs (globs). */
  files: string[]
  /** Words or phrases in a request that call for it. */
  triggers: string[]
  /** The rules (comments removed). */
  body: string
  /** What a governed file starts as (the "## Template" code block), if given. */
  template?: string
}

export class SkillError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export class SkillLibrary {
  readonly dir?: string
  private cache = new Map<string, { mtimeMs: number; skill: Skill }>()

  constructor(workspaceDir?: string) {
    if (workspaceDir) this.dir = path.join(workspaceDir, 'skills')
  }

  /** Writes the starter skills the first time (when there's no skills folder yet). */
  seed(): void {
    if (!this.dir || fs.existsSync(this.dir)) return
    fs.mkdirSync(this.dir, { recursive: true })
    for (const [id, text] of Object.entries(STARTER_SKILLS)) fs.writeFileSync(path.join(this.dir, `${id}.md`), text)
  }

  list(): Skill[] {
    if (!this.dir) return []
    let names: string[] = []
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.md'))
    } catch {
      return []
    }
    return names
      .map((n) => this.get(n.slice(0, -3)))
      .filter((s): s is Skill => !!s)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string): Skill | undefined {
    if (!this.dir || !ID.test(id)) return undefined
    const file = path.join(this.dir, `${id}.md`)
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      this.cache.delete(id)
      return undefined
    }
    const cached = this.cache.get(id)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.skill
    const skill = parseSkill(id, fs.readFileSync(file, 'utf8'))
    this.cache.set(id, { mtimeMs: stat.mtimeMs, skill })
    return skill
  }

  /** A skill by id or name ("todo", "To-do list", "to-do"), forgiving about case and punctuation. */
  find(nameOrId: string): Skill | undefined {
    const key = squash(nameOrId)
    const all = this.list()
    return all.find((s) => s.id === nameOrId) ?? all.find((s) => squash(s.id) === key || squash(s.name) === key) ?? all.find((s) => squash(s.name).includes(key) || key.includes(squash(s.id)))
  }

  /** Skills governing a workspace path ("todo.md", "logs/weight.md"). */
  forPath(relative: string): Skill[] {
    return this.list().filter((s) => s.files.some((glob) => globMatch(glob, relative)))
  }

  /** Skills a request calls for (a trigger word or phrase in it). */
  triggered(text: string): Skill[] {
    const t = ` ${text.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `
    return this.list().filter((s) => s.triggers.some((trigger) => t.includes(` ${trigger.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim()} `)))
  }

  /**
   * Creates a skill's missing files from its template (only plain paths, not globs).
   * Returns the ones it made.
   */
  ensureFiles(skill: Skill, workspaceDir: string): string[] {
    if (!skill.template) return []
    const made: string[] = []
    for (const rel of skill.files) {
      if (/[*?]/.test(rel)) continue
      const file = path.join(workspaceDir, rel)
      if (!path.resolve(file).startsWith(path.resolve(workspaceDir) + path.sep) || fs.existsSync(file)) continue
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, skill.template.endsWith('\n') ? skill.template : `${skill.template}\n`, { flag: 'wx' })
      made.push(rel)
    }
    return made
  }

  /** Adds a rule under a section (made if missing), dated, at the end of the section. */
  addRule(id: string, section: string, rule: string, today: string): Skill {
    const skill = this.get(id)
    if (!skill || !this.dir) throw new SkillError(`No skill "${id}"`, 404)
    const clean = rule.replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, '')
    if (!clean || clean.length > 500) throw new SkillError('The rule is needed (at most 500 characters)', 400)
    const heading = section.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim() || 'More rules'
    const file = path.join(this.dir, `${id}.md`)
    const lines = fs.readFileSync(file, 'utf8').replace(/\s+$/, '').split('\n')
    const line = `- ${clean} <!-- added ${today} -->`
    const at = lines.findIndex((l) => /^##\s+/.test(l) && squash(l.replace(/^##\s+/, '')) === squash(heading))
    if (at === -1) {
      lines.push('', `## ${heading}`, line)
    } else {
      let end = at + 1
      while (end < lines.length && !/^##\s+/.test(lines[end]!)) end++
      while (end > at + 1 && lines[end - 1]!.trim() === '') end--
      lines.splice(end, 0, line)
    }
    write(file, `${lines.join('\n')}\n`)
    return this.get(id)!
  }

  /** A new skill; its id comes from the name. */
  create(input: { name: string; description: string; files: string[]; triggers: string[]; body: string; template?: string }): Skill {
    if (!this.dir) throw new SkillError('No workspace for skills', 500)
    const name = input.name.replace(/\s+/g, ' ').trim()
    if (!name || name.length > 60) throw new SkillError('The name is needed (at most 60 characters)', 400)
    const id = slug(name)
    if (this.get(id)) throw new SkillError(`There's already a skill "${id}": add to it instead`, 409)
    const list = (items: string[]) => `[${items.map((i) => i.replace(/[,[\]]/g, ' ').trim()).filter(Boolean).join(', ')}]`
    fs.mkdirSync(this.dir, { recursive: true })
    write(
      path.join(this.dir, `${id}.md`),
      [
        '---',
        `name: ${JSON.stringify(name)}`,
        `description: ${JSON.stringify(input.description.replace(/\s+/g, ' ').trim())}`,
        `files: ${list(input.files)}`,
        `triggers: ${list(input.triggers)}`,
        '---',
        input.body.trim(),
        ...(input.template?.trim() ? ['', '## Template', '```markdown', input.template.trim(), '```'] : []),
        '',
      ].join('\n'),
    )
    return this.get(id)!
  }
}

/** One line per skill, for the system prompt. */
export function skillIndex(skills: Skill[]): string | null {
  if (skills.length === 0) return null
  return [
    'Skills: how to handle certain things. When a request or a file is about one, follow its rules exactly (you are shown them at that point).',
    'Work out dates and times yourself from the current time ("today", "last night" = the night before today, "this morning", "Friday"); only ask for what only the owner can tell you.',
    ...skills.map((s) => `- ${s.name} (${s.id}): ${s.description}${s.files.length ? ` Files: ${s.files.join(', ')}.` : ''}`),
    'When the owner asks to change how something is handled ("from now on…", "always…"), add the rule with jarvis__update_skill; for a new kind of thing, jarvis__create_skill.',
  ].join('\n')
}

/** A skill as handed to the LLM. */
export function skillText(skill: Skill): string {
  return `Skill "${skill.name}"${skill.files.length ? ` (files: ${skill.files.join(', ')})` : ''}. Follow these rules exactly:\n${skill.body}`
}

export function parseSkill(id: string, text: string): Skill {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const meta: Record<string, string | string[]> = {}
  let body = text
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end !== -1) {
      let listKey: string | undefined
      for (const line of lines.slice(1, end)) {
        const item = /^\s+-\s*(.+?)\s*$/.exec(line)
        if (item && listKey) {
          ;(meta[listKey] as string[]).push(unquote(item[1]!))
          continue
        }
        const m = /^(\w+):\s*(.*)$/.exec(line)
        if (!m) continue
        listKey = undefined
        const raw = m[2]!.trim()
        if (raw === '') {
          meta[m[1]!] = []
          listKey = m[1]!
        } else if (/^\[.*\]$/.test(raw)) {
          meta[m[1]!] = raw.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter(Boolean)
        } else {
          meta[m[1]!] = unquote(raw.replace(/\s+#.*$/, ''))
        }
      }
      body = lines.slice(end + 1).join('\n')
    }
  }
  const str = (k: string) => (typeof meta[k] === 'string' ? (meta[k] as string) : '')
  const arr = (k: string) => (Array.isArray(meta[k]) ? (meta[k] as string[]) : str(k) ? [str(k)] : [])
  const clean = body.replace(/<!--[\s\S]*?-->/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  const template = /^## Template\s*\n+(`{3,})[^\n]*\n([\s\S]*?)\n\1/m.exec(clean)?.[2]
  return {
    id,
    name: str('name') || id,
    description: str('description'),
    files: arr('files'),
    triggers: arr('triggers'),
    body: clean,
    ...(template ? { template } : {}),
  }
}

/** "*" within a folder, "**" across folders; case-insensitive. */
export function globMatch(glob: string, relative: string): boolean {
  const re = glob
    .replace(/^\/+/, '')
    .split('**')
    .map((part) => part.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*')
  return new RegExp(`^${re}$`, 'i').test(relative.replace(/^\/+/, ''))
}

function unquote(v: string): string {
  if (/^".*"$/.test(v)) {
    try {
      return String(JSON.parse(v))
    } catch {
      return v.slice(1, -1)
    }
  }
  return /^'.*'$/.test(v) ? v.slice(1, -1) : v
}

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function slug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill'
}

function write(file: string, text: string): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/** Written on first start; the owner (or Jarvis, when asked) grows them from there. */
const STARTER_SKILLS: Record<string, string> = {
  todo: `---
name: To-do list
description: Adding, completing and organising the owner's to-dos.
files: [todo.md]
triggers: [to-do, to-dos, todo, todos, to do list, task, tasks, remind me to, i need to, done with, finished, completed]
---
<!-- How Jarvis keeps the to-do list (todo.md in the workspace). Edit freely; Jarvis can add rules when you ask it to. -->

## Layout
- The file is todo.md: "# To-do", then the sections "## Today", "## This week", "## Later", "## Done", in that order (see the template). Keep them all, even when empty.
- Insert or move a task under its section with edit_file (put it after that section's heading). Never use append_file on this file: it would land under "## Done".

## Adding
- One task per line: \`- [ ] Task · added YYYY-MM-DD HH:MM\` using the current date and time.
- Put it in the section that fits: today → "## Today", in the next days → "## This week", otherwise "## Later".
- If it has a deadline, add it: \`· due YYYY-MM-DD\` (work out the date from "Friday", "tomorrow", …).
- Add a tag when the area is clear: \`#home\`, \`#work\`, \`#errands\`, \`#health\`, \`#money\`.
- Write the task short and clear, starting with a verb ("Call the bank", not "bank thing").

## Completing
- Never delete a task. Mark it done: change \`- [ ]\` to \`- [x]\`, keep the rest, and add \`· done YYYY-MM-DD HH:MM\`.
- Add any notes the owner gave after a dash: \`— paid by card\`.
- Move it to the top of "## Done" (newest first).

## Changing
- Moving a task to another section, or changing its wording or due date: edit it in place and keep its "added" stamp.

## Ask if missing
- If a task mentions a deadline ("by Friday", "before the trip") but no date can be worked out, ask for the date before adding.
- If it's unclear which existing task was completed, ask which one.

## Template
\`\`\`markdown
# To-do

## Today

## This week

## Later

## Done
\`\`\`
`,
  'weight-log': `---
name: Weight log
description: Recording the owner's weight measurements.
files: [logs/weight.md]
triggers: [weigh, weighed, weight, kilos, kg, pounds, lbs, scale]
---
<!-- How Jarvis keeps the weight log (logs/weight.md in the workspace). -->

## Layout
- The file is logs/weight.md: a "# Weight log" heading, then one Markdown table (see the template).
- Add each measurement as a new row at the bottom (append_file is fine here). Time as HH:MM (estimate "this morning" as 08:00 if no time is given).

## Recording
- One row per measurement, with the current date and time unless the owner gives another.
- Weight as a number with one decimal (82.4). Unit: kg or lb, as given.
- Notes: anything the owner adds (after the gym, morning, before breakfast…). Leave empty otherwise.

## Ask if missing
- Never assume the unit. If the owner gave a number without "kg", "kilos", "lb" or "pounds", record nothing yet: ask "Kilos or pounds?" and record it once they answer.
- If the number is far from the last entry (more than 5 kg or 10 lb), ask to confirm it before recording.

## After recording
- Say the change since the last entry (e.g. "down 0.6 kg since Monday").

## Template
\`\`\`markdown
# Weight log

| Date | Time | Weight | Unit | Notes |
|------|------|--------|------|-------|
\`\`\`
`,
}
