// The "Services" skill (WORKSPACE_DIR/skills/services.md): how Jarvis writes
// a service, with a worked example (a small model writes far better code from
// one). Written once when services start (not again if the owner deletes it).

import fs from 'node:fs'
import path from 'node:path'

export const SERVICES_SKILL = `---
name: Services
description: Writing background services that run on a schedule and report events (watching a feed, a price, a page).
files: [services/**]
triggers: [service, services, every minute, every hour, every day, check every, keep an eye on, watch for, let me know when, tell me when, monitor]
---
<!-- How Jarvis writes its background services (design: docs/services.md in the Jarvis repository). Edit freely. -->

## What a service is
- A folder services/<id>/ in the workspace (id: lower case letters, digits and -), with service.md (what it may do) and main.ts (the code). It runs on a schedule in a sandbox, and reports what it finds as events; each event type has a prompt, which an agent of yours handles in a turn of its own, and whatever that turn replies is shown to the owner as a notification (not spoken).
- Use one when something should happen without the owner asking each time: "tell me when the price drops", "check the city's news every hour". For a one-off, just do it now; for a reminder at a time, use a schedule.

## The rules (they're enforced: work with them)
- Email is not a service: the email plugin watches the owner's inbox, keeps every message, and sends (email__* tools). Never write a service that reads or sends email.
- Nothing runs until the owner approves it in the Services tab, and every change you make waits for approval again (the approved version keeps running meanwhile). After writing or changing a service, call jarvis__services_list with its name to check service.md has no problem, then tell the owner it's waiting for them in the Services tab, and what it will do, in a sentence or two.
- A service sees only its own folder. It can't read the workspace or anything else. If it needs a setting, put it in main.ts or service.md (the owner sees it when approving).
- It reaches only the hosts listed in "hosts:", as host:port. List exactly what it needs, nothing more.
- Passwords and keys are secrets: list their names in "secrets:", then call jarvis__service_needs_secret so the owner types the value in the Services tab. Never ask the owner to tell you a password, never write one in a file. For a login, ask for JSON: {"user": "…", "password": "…"}.
- npm packages go in "packages:" with exact versions ({ fast-xml-parser: 4.5.0 }). Prefer Node's built-in modules; use a package only for a real protocol and only a well-known one.
- Every event type it emits must be under "on:", with the agent that handles it and the prompt. Use an agent with only the tools that turn needs; create one in agents/ if needed (e.g. feed-triage with no tools at all). The turn can't change or delete anything anyway.
- What a service emits comes from outside (a web page, someone's post), so the turn treats it as untrusted. Keep payloads small: the parts that matter, text cut to a couple of thousand characters, and an "id" so nothing is handled twice.
- Keep state (the last message seen) with the kit's state.read/write, never in the folder.
- If a run fails, read jarvis__service_log, fix main.ts, and tell the owner the fix is waiting for approval. jarvis__service_run_now tests the approved version.

## Development mode
- The owner can put a service in development mode (in the Services tab, never you): every change you save is then approved automatically, new hosts, secrets and packages included, and jarvis__service_run_now runs the latest version. jarvis__services_list says when a service is in it.
- Then work without asking: save, run it with jarvis__service_run_now, read the result and the log, fix, run again, until it works. Don't ask the owner to approve each step.
- When it works, say so briefly and suggest they lock it in the Services tab. Once locked (or when its time runs out), changes wait for their approval again.

## service.md
\`\`\`markdown
---
name: Blog watch
description: Tells the owner when the city's news feed has something new
runs: every 30 min         # every N min / every N h (at least 1 min)
timeout: 60 s              # one run, at most (default 60 s, at most 10 min)
hosts: [www.example.com:443]
on:
  feed.item:
    agent: feed-triage
    prompt: |
      New posts on the city's news feed. If one affects {{owner}} (roads, garbage
      days, closures near them), say what in one sentence. Otherwise reply with nothing.
    batch: 2 min           # events within 2 minutes go to one turn together
    max_per_hour: 20
---
Checks the feed every half hour and reports each new post once.
\`\`\`

## main.ts
- TypeScript run by Node 24 (type annotations are fine; no enums or namespaces). Top-level await works. Exit when done: the next run starts on schedule.
- The kit: \`import { emit, secret, state, connect, log } from 'jarvis:service'\`. emit(event, payload) reports an event; secret(name) gives a secret's value; state.read/write/readJson/writeJson keep small files between runs; connect(host, port) gives a raw TCP socket. fetch, net, tls, http and https work as usual for the listed hosts.

\`\`\`ts
import { emit, state } from 'jarvis:service'

const xml = await (await fetch('https://www.example.com/news/feed.xml')).text()
const items = [...xml.matchAll(/<item>([\\s\\S]*?)<\\/item>/g)].map((m) => {
  const tag = (name: string) => new RegExp(\`<\${name}>(?:<!\\\\[CDATA\\\\[)?([\\\\s\\\\S]*?)(?:\\\\]\\\\]>)?</\${name}>\`).exec(m[1])?.[1]?.trim() ?? ''
  return { id: tag('guid') || tag('link'), title: tag('title'), link: tag('link'), date: tag('pubDate'), text: tag('description').replace(/<[^>]+>/g, ' ').slice(0, 1000) }
})
const seen: string[] = (await state.readJson('seen')) ?? []
// First run: remember what's there, don't report it all.
if (seen.length === 0) await state.writeJson('seen', items.map((i) => i.id))
else {
  for (const item of items.filter((i) => i.id && !seen.includes(i.id))) await emit('feed.item', item)
  await state.writeJson('seen', [...new Set([...items.map((i) => i.id), ...seen])].slice(0, 500))
}
\`\`\`
`

/** Writes the skill once (a marker in DATA_DIR/services remembers, so a deleted skill stays deleted). */
export function seedServicesSkill(workspaceDir: string, dataDir: string): void {
  const marker = path.join(dataDir, 'services', '.skill-seeded')
  if (fs.existsSync(marker)) return
  const file = path.join(workspaceDir, 'skills', 'services.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) fs.writeFileSync(file, SERVICES_SKILL)
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  fs.writeFileSync(marker, new Date().toISOString())
}
