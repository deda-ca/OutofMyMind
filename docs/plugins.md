# Plugins: self-contained, talking to the server through events (design)

Status: **built 2026-11-11** (the core: manifests, events, plugin requests, triggers, the confirmation gate, tabs), with the email plugin ([email.md](email.md)) as the first plugin on it. Tested with a stand-in plugin over a real MCP connection (events, requests, the gate, tab-only tools, settings), and with email for real: its events through the trigger engine to an LLM turn, its tab in Chrome under the tab's CSP, and the release binary. Not built yet: the server's own events to plugins (owner presence), a Plugins tab for the owner to change triggers, and moving Telegram and the phone out of the server.

## The idea

Today a plugin is an MCP server that only **answers tool calls**. Anything that has to watch for something (Telegram's messages, the phone line, an inbox) is code inside the server, wired into `app.ts`, and can't be added or removed without changing the server.

Instead, **a plugin is a self-contained folder** that the server starts, and the two talk over the plugin's MCP connection, both ways:

- **Tools** (today): the LLM calls the plugin.
- **Events from the plugin** (new): "a new email arrived", "a message came in". The server turns them into **triggers**: a notification, an LLM turn with a chosen agent and prompt, a message to other plugins.
- **Events from the server** (new): what a plugin may need to know: the owner spoke, the owner is away, another plugin's event it subscribed to.
- **Server APIs for plugins** (new): notify the owner, add a note to the conversation, ask the owner something.
- **Its own tab** (new, optional): a plugin can ship a web page that the client shows as a tab, talking to the plugin through the server.

The server knows nothing about email, Telegram or phones: only about plugins, events, triggers and tabs. Adding a plugin is dropping in a folder (and approving it); removing one is deleting it.

## Decisions

| Topic | Decision |
| --- | --- |
| What a plugin is | A folder with `plugin.json` (its manifest) and an MCP server (stdio), started and stopped by the server. Self-contained: its own code, its own data folder, its own tab. |
| Where plugins live | `plugins/<name>/` in the repo for the built-in ones, and `DATA_DIR/plugins/<name>/` for added ones later. `mcp.json` becomes just "which plugins are on, and their settings". |
| How they talk | The plugin's MCP connection, both ways: tools as today, plus **custom MCP notifications** for events (`notifications/jarvis/event` from the plugin; `notifications/jarvis/server-event` to it) and **custom MCP requests** for server APIs (`jarvis/notify`, `jarvis/note`, …). Nothing else: no extra ports, no shared files. |
| Events | Declared in `plugin.json` (type, what it means, whether it carries content from outside). Undeclared events are dropped and logged. Each event has an `id`, so nothing is handled twice. |
| Content from outside | Events that carry outside content (an email's body, a text message) are **untrusted**: marked as such for the LLM, handled by an agent with limited tools; never instructions. The same rules as services' events today. |
| Triggers | What to do with an event: in `plugin.json` as defaults (the plugin author's), overridable by the owner in the Plugins tab. A trigger is a notification, an LLM turn (agent, prompt, batch window, rate limits), or nothing. |
| Owner-facing data | A plugin keeps its own data in `DATA_DIR/plugins/<name>/` (its database, files). Data the owner and Jarvis work with as files (a saved email as Markdown) goes in the workspace under the plugin's folder (`email/`), so the file tools and the data history see it. |
| Tabs | Optional: `plugin.json` names a web page in the plugin's folder. The client shows it as a tab in a sandboxed iframe; it calls the plugin's tools through `/api/plugins/<name>/…` (signed-in owner only) and gets its events pushed. A plugin's page can't reach other plugins or the rest of the server. |
| Secrets | Settings in `.env.local` (as today), handed to the plugin as environment variables named in `plugin.json`. The vault UI later. The LLM never sees them. |
| Sending things in the owner's name | **A gate in the server, for every plugin**: a tool the manifest marks `confirm: owner` (send an email, a message, a text) only runs if the owner has spoken or typed to Jarvis since the draft was shown to them. Today only the phone has this, in its own code. |
| Plugins talking to plugins | Only through events, via the server: a plugin subscribes to event types in its manifest (the contacts plugin, later, to `email.received` to learn addresses). No direct calls between plugins. |
| What stays in the server | The core: plugin lifecycle, the event bus, triggers, the confirmation gate, tab hosting, sessions, the LLM loop. Telegram, the phone and services' email are moved out over time. |

## plugin.json

```jsonc
{
  "name": "email",
  "description": "Your email: reads the inbox (IMAP), sends (SMTP), keeps a local copy.",
  "command": "node", "args": ["server.ts"],          // started in the plugin's folder
  "env": ["EMAIL_IMAP_HOST", "EMAIL_USER", "EMAIL_PASSWORD", "EMAIL_SMTP_HOST"],   // settings it's given
  "data": true,                                     // gets DATA_DIR/plugins/email/ (JARVIS_DATA)
  "workspace": "email",                             // may write WORKSPACE_DIR/email/ (JARVIS_WORKSPACE)
  "tools": {
    "send_email":  { "crud": ["create"], "confirm": "owner" },
    "reply":       { "crud": ["create"], "confirm": "owner" },
    "search_email": { "crud": ["read"] }
  },
  "events": {
    "email.received": {
      "description": "A new email arrived in the inbox.",
      "untrusted": true,
      "trigger": { "agent": "email-triage", "prompt": "…", "batch": "2 min", "maxPerHour": 30 }
    }
  },
  "subscribes": [],                                 // other plugins' events it wants
  "tab": { "title": "Email", "page": "ui/index.html" }
}
```

## The protocol

All over the plugin's existing MCP stdio connection, with JSON-RPC as MCP defines it.

| Direction | Message | What |
| --- | --- | --- |
| plugin → server | notification `notifications/jarvis/event` `{ type, id, at, payload, summary? }` | An event. The server checks it's declared, de-duplicates by `id`, and runs its trigger. |
| server → plugin | notification `notifications/jarvis/server-event` `{ type, payload }` | `owner.presence` (at a screen, away, last spoke), events it subscribed to, `settings.changed`. |
| plugin → server | request `jarvis/notify` `{ title, text, urgency }` | A notification on the owner's screens (and Telegram when they're away, once Telegram is a plugin that subscribes). |
| plugin → server | request `jarvis/note` `{ text }` | A note in the active conversation ("3 new emails, saved in email/"). Marked as from the plugin. |
| plugin → server | request `jarvis/tab-push` `{ payload }` | Tells its tab something changed (the page reloads its data). |
| tab → plugin | `POST /api/plugins/<name>/call/<tool>` | The tab calls the plugin's tools as the owner (the same tools the LLM has, plus tab-only ones the manifest marks `"tab": true`). |

A small kit (`plugins/kit/plugin.ts`) wraps it: `plugin.emit(type, payload)`, `plugin.notify(…)`, `plugin.onServerEvent(…)`, `plugin.dataDir`, so a plugin is ordinary MCP code plus a few calls.

## Triggers (from today's services)

Services already have this (`apps/server/src/services/triggers.ts`, `turn.ts`): events batched over a window, rate limits per hour and per day, an agent with only reading and messaging tools, the payload between `<untrusted>` tags, the reply as a notification. That moves to the core as **the** trigger engine, used by plugins and services alike.

## Migration

1. The core: plugin manifests, the event and request handlers in the harness, the trigger engine (moved from services), the confirmation gate, tab hosting and the Plugins tab. Today's plugins keep working (no manifest: tools only).
2. **Email** as the first plugin on it ([email.md](email.md)), replacing the email service Jarvis wrote.
3. Later, one at a time: **Telegram** (the channel becomes the plugin's own long polling plus events; replies through a server API for running a turn), the **phone**, then contacts and the calendar as new plugins. Each move takes code out of the server.

## What's built, and where

| Piece | Where |
| --- | --- |
| `plugin.json`: read and checked | `apps/server/src/harness/manifest.ts`; `mcp.json` `{ "plugin": "<folder>" }` in `harness/config.ts` (started in its folder with only the settings it names, `JARVIS_DATA`, `JARVIS_WORKSPACE`) |
| Events and requests from plugins; events to plugins; the confirmation gate; tab-only tools; tab calls | `apps/server/src/harness/mcp.ts` (the hub) |
| What the server does with them: triggers (services' engine, `services/triggers.ts`), subscribers, tab refresh, notify, note | `apps/server/src/plugins/index.ts` |
| The event log: events other plugins subscribe to are kept (the newest 20,000, `DATA_DIR/plugin-events/log/`) with each subscriber's place, so a plugin that wasn't running (started later, restarted, crashed) is sent what it missed when it connects, in order and once | `apps/server/src/plugins/eventlog.ts` |
| `/api/plugins`, tab calls, `/plugin-ui/…` (the tab's files, with a CSP: no other sites, no direct API calls), the shared bridge and stylesheet | `apps/server/src/plugins/routes.ts`, `plugins/kit/` |
| The plugin side: `emit`, `notify`, `note`, `refreshTab`, `onServerEvent`, `pluginDataDir` | `plugins/kit/plugin.ts` |
| Tabs in the client: a sandboxed iframe per plugin, relaying only that plugin's tools; once opened, kept alive (hidden) while another tab is shown, so a tab can keep playing; told what the Jarvis page is doing (`jarvis.onHost`: `assistant-speaking`, `assistant-quiet`); may play audio it made (CSP `media-src 'self' data: blob:`) | `apps/client/src/plugins.ts`, `components/PluginTab.vue` |
| The release binary: manifests, tab files and the kit unpacked (`JARVIS_PLUGINS_DIR`, `JARVIS_PLATFORM_KIT`); `jarvis plugin <name>` runs each | `release/build.ts`, `release/main.ts` |

The gate: a tool marked `"confirm": "owner"` gets a `confirm` parameter. Called without it, nothing happens and the model is given a code and told to read back exactly what will happen; called again with the same arguments and the code (5 minutes), it runs only if the owner has spoken or typed to Jarvis since the code was given. From the plugin's tab, pressing the button is the yes (no gate). Unattended turns (triggers, schedules) can never pass it.

## Open questions

- Should plugins be able to run an LLM turn of their own (MCP "sampling"), for example to summarise a thread, or only through triggers the owner can see and limit? Proposed: only through triggers, for now.
- Plugin tabs in an iframe: one look across plugins means a shared stylesheet the server serves to every tab. Proposed: yes (`/api/plugins/style.css`).
- Approving added plugins (not the built-in ones): like services (code and permissions shown), once there are any.
