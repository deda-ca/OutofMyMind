// Makes sure the LLM has a skill's rules before it handles a file the skill
// governs, within one reply:
//   - after a tool reads or touches the file, the rules are added to the result;
//   - before a tool changes it, if the rules haven't been shown yet, the call is
//     refused once with the rules ("follow these, then try again").
// Skills already shown (e.g. because the request mentioned "to-do") count.
// A small local model otherwise appends "- [ ] milk" straight away and skips
// the format, the stamps and the follow-up questions.

import fs from 'node:fs'
import path from 'node:path'
import type { ToolOutcome } from '../harness/mcp.ts'
import { skillText, type Skill, type SkillLibrary } from './library.ts'

/** Argument names that hold paths (the files plugin and most others). */
const PATH_KEYS = /^(path|paths|source|destination|dest|from|to|file|files|filename|filepath|file_path|target)$/i

export class SkillGuard {
  private readonly shown = new Set<string>()
  private readonly roots: string[]
  private readonly skills: SkillLibrary

  constructor(skills: SkillLibrary, workspaceDir: string) {
    this.skills = skills
    const roots = [path.resolve(workspaceDir)]
    try {
      roots.push(fs.realpathSync(workspaceDir))
    } catch {
      // not created yet
    }
    this.roots = [...new Set(roots)]
  }

  /** Skills the LLM already has in this reply (e.g. in the request's note). Their missing files are made from their templates. */
  markShown(skills: Skill[]): void {
    for (const s of skills) {
      this.shown.add(s.id)
      try {
        this.skills.ensureFiles(s, this.roots[0]!)
      } catch {
        // can't create it: the LLM will
      }
    }
  }

  /** Before a call: refuses a change to a governed file whose skill hasn't been shown yet (once). */
  before(name: string, args: Record<string, unknown>, crud: string[]): ToolOutcome | null {
    if (name.startsWith('jarvis__') || !crud.some((k) => k !== 'read')) return null
    this.startOnNewLine(name, args)
    const missing = this.unshown(args)
    if (missing.length === 0) return null
    this.markShown(missing.map((m) => m.skill))
    const files = [...new Set(missing.map((m) => m.file))].join(', ')
    return {
      isError: true,
      text: `Not done yet: ${files} follows ${missing.length === 1 ? 'a skill' : 'skills'}. Read the rules below, then make the change again following them exactly (format, stamps, sections). If the file is new, it has just been created from the skill's template: read it first. If the rules say to ask the owner something first, ask instead.\n\n${missing.map((m) => skillText(m.skill)).join('\n\n')}`,
    }
  }

  /** After a call: adds the rules of any governed file it touched that weren't shown yet. */
  after(name: string, args: Record<string, unknown>, _crud: string[], outcome: ToolOutcome): ToolOutcome {
    if (name.startsWith('jarvis__')) return outcome
    const missing = this.unshown(args)
    if (missing.length === 0) return outcome
    this.markShown(missing.map((m) => m.skill))
    return { ...outcome, text: `${outcome.text}\n\n(${missing.map((m) => `${m.file} follows a skill. ${skillText(m.skill)}`).join('\n\n')})` }
  }

  /**
   * An append to a governed file always starts on a new line: the model often writes the
   * last row without one, and the next row ends up glued to it ("|  || 2026-…").
   */
  private startOnNewLine(name: string, args: Record<string, unknown>): void {
    if (!/append/i.test(name) || typeof args.content !== 'string' || typeof args.path !== 'string') return
    const rel = this.relative(args.path)
    if (!rel || this.skills.forPath(rel).length === 0) return
    try {
      const file = path.isAbsolute(args.path) ? args.path : path.join(this.roots[0]!, rel)
      const size = fs.statSync(file).size
      if (size === 0 || args.content.startsWith('\n')) return
      const fd = fs.openSync(file, 'r')
      const last = Buffer.alloc(1)
      fs.readSync(fd, last, 0, 1, size - 1)
      fs.closeSync(fd)
      if (last.toString() !== '\n') args.content = `\n${args.content}`
    } catch {
      // no file yet: nothing to glue onto
    }
  }

  private unshown(args: Record<string, unknown>): { file: string; skill: Skill }[] {
    const out: { file: string; skill: Skill }[] = []
    for (const file of this.workspacePaths(args)) {
      for (const skill of this.skills.forPath(file)) {
        if (!this.shown.has(skill.id) && !out.some((o) => o.skill.id === skill.id)) out.push({ file, skill })
      }
    }
    return out
  }

  /** The workspace paths named in a call's arguments (absolute ones inside the workspace, or relative). */
  private workspacePaths(args: Record<string, unknown>): string[] {
    const found: string[] = []
    const visit = (value: unknown, key: string, depth: number) => {
      if (depth > 4) return
      if (typeof value === 'string' && PATH_KEYS.test(key)) {
        const rel = this.relative(value)
        if (rel) found.push(rel)
      } else if (Array.isArray(value)) for (const v of value) visit(v, key, depth + 1)
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k, depth + 1)
    }
    visit(args, '', 0)
    return found
  }

  private relative(p: string): string | null {
    if (!path.isAbsolute(p)) return p.replace(/^\.\/+/, '')
    for (const root of this.roots) {
      const rel = path.relative(root, p)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/')
    }
    return null
  }
}
