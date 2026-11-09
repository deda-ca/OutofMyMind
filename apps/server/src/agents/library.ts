// The system prompt and the agents, as files the owner edits in the workspace:
//
//   WORKSPACE_DIR/SYSTEM.md        in every system prompt, for every agent and session
//   WORKSPACE_DIR/agents/<id>.md   one agent each: frontmatter + its instructions
//
//   ---
//   name: Email
//   description: Drafts replies to email
//   tools: [files__read_text_file, files__list_directory, email__*]   # or "all" (default) or "none"
//   brain: local            # optional: local | hermes (otherwise the brain setting decides)
//   temperature: 0.4        # optional
//   ---
//   You handle the owner's email. …
//
// Files are read when they change, so edits apply from the next request.
// `{{owner}}` is replaced with OWNER_NAME. <!-- HTML comments --> are notes
// for the owner and never sent. A missing SYSTEM.md means the default text;
// an empty one means none. Defaults are written on first start.

import fs from 'node:fs'
import path from 'node:path'
import type { Brain } from '../assistant/llm.ts'

export interface Agent {
  /** The file name without ".md". */
  id: string
  name: string
  description: string
  /** Allowed tool function names; "*" matches anything ("files__*"). null: every tool. */
  tools: string[] | null
  brain?: Brain
  temperature?: number
  /** The agent's part of the system prompt (comments removed; fill `{{owner}}` with fillOwner()). */
  instructions: string
  /** The file's text after the frontmatter, as written (comments kept): what the editor shows. */
  body: string
}

/** What the client's agent editor sends. */
export interface AgentInput {
  name: string
  description: string
  tools: string[] | null
  brain?: Brain
  temperature?: number
  /** The instructions, as written (comments allowed). */
  body: string
}

export class AgentError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export const DEFAULT_AGENT_ID = 'jarvis'

export const DEFAULT_SYSTEM = `<!--
  SYSTEM.md: sent at the start of every request to the model, whatever the
  agent or session. Keep it short and concrete. Edits apply from the next
  request. {{owner}} becomes your name (OWNER_NAME); comments like this one
  are never sent. Delete this file to get the default back.
-->
You are Jarvis, {{owner}}'s private assistant. You run entirely on {{owner}}'s own computer.
You are spoken to through a microphone and your replies are shown on screen and spoken aloud, so answer like a person talking: short, direct, plain sentences. No markdown, lists or headings unless asked. Usually one to three sentences.
Speech is transcribed automatically, so requests may contain recognition mistakes; interpret them sensibly and ask briefly if something is unclear.
Don't narrate your tool use ("let me check", "first I'll look"); just do it and say what you found or did.
`

const DEFAULT_AGENT_FILE = `---
name: Jarvis
description: General assistant, with every tool
tools: all
---
<!-- The fallback agent (used when no other is the default). Its instructions go below; SYSTEM.md already says who Jarvis is. -->
`

const BUILT_IN_DEFAULT: Agent = { id: DEFAULT_AGENT_ID, name: 'Jarvis', description: 'General assistant, with every tool', tools: null, instructions: '', body: '' }

const ID = /^[A-Za-z0-9_-]{1,64}$/

export class AgentLibrary {
  private readonly systemFile?: string
  private readonly agentsDir?: string
  /** Which agent is the default (DATA_DIR/agents.json): sessions without their own agent use it. */
  private readonly stateFile?: string
  private cache = new Map<string, { mtimeMs: number; text: string }>()

  /** No workspace (tests): the defaults, in memory. */
  constructor(workspaceDir?: string, stateFile?: string) {
    this.stateFile = stateFile
    if (!workspaceDir) return
    this.systemFile = path.join(workspaceDir, 'SYSTEM.md')
    this.agentsDir = path.join(workspaceDir, 'agents')
  }

  /** The default agent's id (jarvis unless chosen; back to jarvis if the chosen one is deleted). */
  defaultId(): string {
    if (!this.stateFile) return DEFAULT_AGENT_ID
    try {
      const saved = (JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { defaultAgent?: unknown }).defaultAgent
      if (typeof saved === 'string' && saved !== DEFAULT_AGENT_ID && this.fileExists(saved)) return saved
    } catch {
      // not chosen yet
    }
    return DEFAULT_AGENT_ID
  }

  setDefault(id: string): void {
    if (!this.has(id)) throw new AgentError(`No agent "${id}"`, 404)
    if (!this.stateFile) throw new AgentError('No place to save the default agent', 500)
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    fs.writeFileSync(this.stateFile, `${JSON.stringify({ defaultAgent: id })}\n`)
  }

  /** Creates an agent (id from its name unless given). Returns its id. */
  create(input: AgentInput, id?: string): string {
    const agentsDir = this.writableDir()
    const chosen = id ?? slug(input.name)
    if (!ID.test(chosen)) throw new AgentError('The id may only have letters, digits, - and _ (at most 64)', 400)
    if (this.fileExists(chosen) || chosen === DEFAULT_AGENT_ID) throw new AgentError(`There's already an agent "${chosen}"`, 409)
    this.write(path.join(agentsDir, `${chosen}.md`), input)
    return chosen
  }

  /** Saves an agent's settings and instructions (its id, the file name, stays). */
  update(id: string, input: AgentInput): void {
    const agentsDir = this.writableDir()
    if (!this.has(id)) throw new AgentError(`No agent "${id}"`, 404)
    this.write(path.join(agentsDir, `${id}.md`), input)
  }

  /** Deletes an agent's file. Sessions that used it fall back to the default agent. */
  remove(id: string): void {
    if (id === DEFAULT_AGENT_ID) throw new AgentError("Jarvis is the fallback agent: it can be edited but not deleted", 400)
    if (!this.fileExists(id)) throw new AgentError(`No agent "${id}"`, 404)
    fs.rmSync(path.join(this.agentsDir!, `${id}.md`))
    this.cache.delete(path.join(this.agentsDir!, `${id}.md`))
  }

  private writableDir(): string {
    if (!this.agentsDir) throw new AgentError('No workspace to save agents in', 500)
    fs.mkdirSync(this.agentsDir, { recursive: true })
    return this.agentsDir
  }

  private write(file: string, input: AgentInput): void {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, toAgentFile(validate(input)))
    fs.renameSync(tmp, file)
  }

  private fileExists(id: string): boolean {
    return ID.test(id) && !!this.agentsDir && fs.existsSync(path.join(this.agentsDir, `${id}.md`))
  }

  /** Writes SYSTEM.md and the default agent if they don't exist yet. */
  seed(): void {
    if (!this.systemFile || !this.agentsDir) return
    fs.mkdirSync(this.agentsDir, { recursive: true })
    if (!fs.existsSync(this.systemFile)) fs.writeFileSync(this.systemFile, DEFAULT_SYSTEM)
    const defaultFile = path.join(this.agentsDir, `${DEFAULT_AGENT_ID}.md`)
    if (!fs.existsSync(defaultFile)) fs.writeFileSync(defaultFile, DEFAULT_AGENT_FILE)
  }

  /** The SYSTEM.md text, ready to send. */
  system(owner: string): string {
    const text = this.systemFile ? (this.read(this.systemFile) ?? DEFAULT_SYSTEM) : DEFAULT_SYSTEM
    return prepare(text, owner)
  }

  list(): Agent[] {
    let names: string[] = []
    if (this.agentsDir) {
      try {
        names = fs.readdirSync(this.agentsDir).filter((n) => n.endsWith('.md') && ID.test(n.slice(0, -3)))
      } catch {
        // no folder yet
      }
    }
    const agents = names.flatMap((n) => {
      const agent = this.get(n.slice(0, -3))
      return agent.id === n.slice(0, -3) ? [agent] : []
    })
    if (!agents.some((a) => a.id === DEFAULT_AGENT_ID)) agents.unshift(BUILT_IN_DEFAULT)
    // The default first, then by name.
    const first = this.defaultId()
    return agents.sort((a, b) => Number(b.id === first) - Number(a.id === first) || a.name.localeCompare(b.name))
  }

  has(id: string): boolean {
    return id === DEFAULT_AGENT_ID || this.fileExists(id)
  }

  /** The agent; '' (or one that doesn't exist, e.g. deleted) means the default agent. */
  get(id: string | undefined): Agent {
    return this.load(id) ?? this.load(this.defaultId()) ?? BUILT_IN_DEFAULT
  }

  private load(id: string | undefined): Agent | undefined {
    if (!id || !ID.test(id) || !this.agentsDir) return undefined
    const text = this.read(path.join(this.agentsDir, `${id}.md`))
    return text === undefined ? undefined : parseAgent(id, text)
  }

  private read(file: string): string | undefined {
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      this.cache.delete(file)
      return undefined
    }
    const cached = this.cache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text
    const text = fs.readFileSync(file, 'utf8')
    this.cache.set(file, { mtimeMs: stat.mtimeMs, text })
    return text
  }
}

/** Whether an agent may use a tool, by function name ("files__read_text_file"). */
export function toolAllowed(agent: Agent, functionName: string): boolean {
  if (agent.tools === null) return true
  return agent.tools.some((pattern) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(functionName))
}

export function parseAgent(id: string, text: string): Agent {
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
        const match = /^(\w+):\s*(.*)$/.exec(line)
        if (!match) continue
        const key = match[1]!
        const raw = value(match[2]!)
        listKey = undefined
        if (raw === '') {
          meta[key] = []
          listKey = key
        } else if (raw.startsWith('[') && raw.endsWith(']')) {
          meta[key] = raw.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter(Boolean)
        } else {
          meta[key] = unquote(raw)
        }
      }
      body = lines.slice(end + 1).join('\n')
    }
  }
  const str = (key: string) => (typeof meta[key] === 'string' ? (meta[key] as string) : undefined)
  const toolsRaw = meta.tools
  const tools = toolsRaw === undefined || toolsRaw === 'all' ? null : toolsRaw === 'none' ? [] : Array.isArray(toolsRaw) ? toolsRaw : [toolsRaw]
  const brain = str('brain')
  const temperature = Number(str('temperature'))
  return {
    id,
    name: str('name') || id,
    description: str('description') ?? '',
    tools,
    ...(brain === 'local' || brain === 'hermes' ? { brain } : {}),
    ...(str('temperature') !== undefined && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? { temperature } : {}),
    instructions: stripComments(body),
    body: body.replace(/^\n+/, '').replace(/\s+$/, ''),
  }
}

/** A frontmatter value without its trailing "# comment" (a "quoted" value may contain #). */
function value(raw: string): string {
  const text = raw.trim()
  const quoted = /^"(?:[^"\\]|\\.)*"/.exec(text)
  if (quoted) return quoted[0]
  const list = /^\[[^\]]*\]/.exec(text)
  if (list) return list[0]
  return text.replace(/\s+#.*$/, '').trim()
}

/** The agent file for what the editor sent. */
export function toAgentFile(agent: AgentInput): string {
  const tools = agent.tools === null ? 'all' : agent.tools.length === 0 ? 'none' : `[${agent.tools.join(', ')}]`
  const lines = [
    '---',
    `name: ${JSON.stringify(agent.name)}`,
    `description: ${JSON.stringify(agent.description)}`,
    `tools: ${tools}`,
    ...(agent.brain ? [`brain: ${agent.brain}`] : []),
    ...(agent.temperature !== undefined ? [`temperature: ${agent.temperature}`] : []),
    '---',
    agent.body.trim(),
  ]
  return `${lines.join('\n')}\n`
}

const TOOL_PATTERN = /^[A-Za-z0-9_*-]{1,128}$/

/** Checks and tidies what the editor sent; throws an AgentError (400) saying what's wrong. */
export function validate(input: AgentInput): AgentInput {
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim()
  if (!name || name.length > 60) throw new AgentError('The name is needed (at most 60 characters)', 400)
  const description = String(input.description ?? '').replace(/\s+/g, ' ').trim()
  if (description.length > 200) throw new AgentError('The description is at most 200 characters', 400)
  let tools: string[] | null = null
  if (input.tools !== null) {
    if (!Array.isArray(input.tools) || !input.tools.every((t) => typeof t === 'string' && TOOL_PATTERN.test(t))) {
      throw new AgentError('Tools are function names like files__read_text_file, optionally with * (files__read_*)', 400)
    }
    tools = [...new Set(input.tools)]
  }
  if (input.brain !== undefined && input.brain !== 'local' && input.brain !== 'hermes') throw new AgentError('The brain is local or hermes (or not set)', 400)
  if (input.temperature !== undefined && !(typeof input.temperature === 'number' && input.temperature >= 0 && input.temperature <= 2)) {
    throw new AgentError('The temperature is a number from 0 to 2 (or not set)', 400)
  }
  const body = String(input.body ?? '')
  if (body.length > 20000) throw new AgentError('The instructions are at most 20,000 characters', 400)
  return { name, description, tools, ...(input.brain ? { brain: input.brain } : {}), ...(input.temperature !== undefined ? { temperature: input.temperature } : {}), body }
}

/** "Email helper!" → "email-helper". */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'agent'
  )
}

/** Comments out, `{{owner}}` filled in, blank edges trimmed. */
function prepare(text: string, owner: string): string {
  return fillOwner(stripComments(text), owner)
}

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

export function fillOwner(text: string, owner: string): string {
  return text.replace(/\{\{\s*owner\s*\}\}/g, owner || 'the owner')
}

function unquote(value: string): string {
  if (/^".*"$/.test(value)) {
    try {
      return String(JSON.parse(value))
    } catch {
      return value.slice(1, -1)
    }
  }
  return /^'.*'$/.test(value) ? value.slice(1, -1) : value
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}
