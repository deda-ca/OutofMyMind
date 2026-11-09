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
<!-- The default agent. Its instructions go below; SYSTEM.md already says who Jarvis is. -->
`

const BUILT_IN_DEFAULT: Agent = { id: DEFAULT_AGENT_ID, name: 'Jarvis', description: 'General assistant, with every tool', tools: null, instructions: '' }

const ID = /^[A-Za-z0-9_-]{1,64}$/

export class AgentLibrary {
  private readonly systemFile?: string
  private readonly agentsDir?: string
  private cache = new Map<string, { mtimeMs: number; text: string }>()

  /** No workspace (tests): the defaults, in memory. */
  constructor(workspaceDir?: string) {
    if (!workspaceDir) return
    this.systemFile = path.join(workspaceDir, 'SYSTEM.md')
    this.agentsDir = path.join(workspaceDir, 'agents')
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
    return agents.sort((a, b) => Number(b.id === DEFAULT_AGENT_ID) - Number(a.id === DEFAULT_AGENT_ID) || a.name.localeCompare(b.name))
  }

  has(id: string): boolean {
    return id === DEFAULT_AGENT_ID || (ID.test(id) && !!this.agentsDir && fs.existsSync(path.join(this.agentsDir, `${id}.md`)))
  }

  /** The agent, or the default one if it doesn't exist (e.g. its file was deleted). */
  get(id: string | undefined): Agent {
    if (!id || !ID.test(id) || !this.agentsDir) return BUILT_IN_DEFAULT
    const text = this.read(path.join(this.agentsDir, `${id}.md`))
    if (text === undefined) return BUILT_IN_DEFAULT
    return parseAgent(id, text)
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
        const match = /^(\w+):\s*(.*?)\s*(#.*)?$/.exec(line)
        if (!match) continue
        const [, key, raw] = match as unknown as [string, string, string]
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
  }
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
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}
