// What a tool does to the owner's data, as CRUD: create, read, update, delete.
// A tool can do several (write_file creates or overwrites). The owner can
// switch whole kinds off (e.g. "nothing that deletes"); a tool is offered
// only if every kind it does is allowed.
//
// Decided, first match wins:
//   1. mcp.json: "crud": { "<tool>": ["create", "update"] } on the plugin (for unclear third-party tools)
//   2. the tool's MCP annotation readOnlyHint: true → read
//   3. the verbs in its name (read_text_file → read, create_directory → create, …)
//   4. otherwise create + update + delete: unknown tools are treated as able to change anything.

import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export type Crud = 'create' | 'read' | 'update' | 'delete'
export const CRUD: readonly Crud[] = ['create', 'read', 'update', 'delete']

export type CrudSource = 'config' | 'annotation' | 'name' | 'unknown'

export interface CrudTags {
  kinds: Crud[]
  /** Where the tags came from (shown in the Tools tab). */
  source: CrudSource
}

const VERBS: [Crud[], RegExp][] = [
  [['delete'], /^(delete|remove|rm|unlink|destroy|drop|erase|purge|trash|clear|wipe|del)$/],
  [['create', 'update'], /^(write|append|save|put|upsert|store)$/],
  [['create'], /^(create|add|new|make|insert|copy|duplicate|upload|post|mkdir|touch|clone)$/],
  // Sending a message makes a new one (and changes nothing that's there): Telegram, email, SMS, …
  [['create'], /^(send|notify|email|sms|publish|alert|ping|broadcast|dm|reply|forward|tweet)$/],
  [['update'], /^(update|edit|set|modify|change|move|rename|patch|replace|mark|toggle|mv|archive|restore)$/],
  [['read'], /^(get|read|list|ls|search|find|query|fetch|show|view|info|tree|stat|stats|lookup|describe|count|check|open|cat|grep|load|download|preview|inspect)$/],
]

export function classify(tool: Pick<Tool, 'name' | 'annotations'>, configured?: Crud[]): CrudTags {
  if (configured && configured.length > 0) return { kinds: sorted(configured), source: 'config' }
  if (tool.annotations?.readOnlyHint === true) return { kinds: ['read'], source: 'annotation' }
  const kinds = new Set<Crud>()
  for (const word of words(tool.name)) {
    for (const [tags, pattern] of VERBS) if (pattern.test(word)) tags.forEach((t) => kinds.add(t))
  }
  // Annotated as able to change things: a "read" verb in the name (e.g. "get_or_create") doesn't make it safe.
  if (tool.annotations?.readOnlyHint === false && kinds.size > 0 && [...kinds].every((k) => k === 'read')) kinds.delete('read')
  if (kinds.size > 0) return { kinds: sorted([...kinds]), source: 'name' }
  return { kinds: ['create', 'update', 'delete'], source: 'unknown' }
}

/** "list_directory_with_sizes" / "getFileInfo" → ["list", "directory", …] / ["get", "file", "info"]. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function sorted(kinds: Crud[]): Crud[] {
  return CRUD.filter((k) => kinds.includes(k))
}

export function isCrud(value: unknown): value is Crud {
  return typeof value === 'string' && (CRUD as readonly string[]).includes(value)
}
