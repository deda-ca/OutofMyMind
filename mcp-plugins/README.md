# Jarvis MCP plugins

Tools for Jarvis, each one a small [MCP](https://modelcontextprotocol.io) server. The harness in the server (`apps/server/src/harness`) starts the ones listed in `apps/server/mcp.json` and offers their tools to the local LLM. Because they're plain MCP servers they also work with any other MCP client, and any third-party MCP server can be listed in `mcp.json` next to them.

Same rules as the rest of Jarvis: local and private, TypeScript run directly by Node 24 (no build step).

| Plugin | Tools | Configuration |
| --- | --- | --- |
| [weather](weather/server.ts) | `get_weather`: now (temperature, feels-like, conditions, humidity, wind) and 1–7 days (min/max, conditions, chance of precipitation) for a city, with province/state and country to pick the right one ("Kingston, Ontario" vs Jamaica) | `WEATHER_HOME` (e.g. `Ottawa, Ontario, Canada`: used when no place is named) and `WEATHER_UNITS` (`celsius`, default, or `fahrenheit`); set them in `apps/server/.env.local`. Uses [Open-Meteo](https://open-meteo.com), free and keyless. ⚠️ Needs the internet: the place name and coordinates are sent to open-meteo.com. |
| [notes](notes/server.ts) | `list_notes`, `read_note`, `search_notes`, `write_note`, `append_to_note` | `NOTES_DIR`: the folder of markdown notes (default in `mcp.json`: `notes/` inside the workspace folder, `apps/server/data/workspace/notes`). Paths can't leave it (no `..`, absolute paths or symlinks out); `.md` files only, 256 KB each. |
| [scripts](scripts/server.ts) | `run_script` (write and run a JavaScript/TypeScript program, or run a saved one by name), `list_scripts` | `WORKSPACE_DIR` (scripts read it; `scripts/` inside it holds saved scripts, `tmp/` the last 20 one-offs, `out/` the only place they can write), `SCRIPTS_TIMEOUT_SECONDS` (30), `SCRIPTS_MEMORY_MB` (256). Sandboxed by [bubblewrap](https://github.com/containers/bubblewrap) (no network; only `/usr`, Node and the workspace visible) and Node's permission model (no child processes, workers or addons); needs `bwrap` installed. Built-in modules only, no npm packages. |
| [web](web/server.ts) | `search` (titles, links, snippets; optional recency: day/week/month/year), `fetch_page` (a page as readable text via Readability; long pages in 6,000-character parts with `start`; optional link list) | `BRAVE_API_KEY` ([Brave Search API](https://brave.com/search/api/)) or `SEARXNG_URL` (your own [SearXNG](https://docs.searxng.org), e.g. `http://127.0.0.1:8888`, with `search.formats: [html, json]` in its settings.yml); Brave wins if both are set. Without either, only `fetch_page` works. Pages must be public: loopback, LAN, link-local and `.local` addresses are refused, on every redirect and again at connect time. HTML, text, JSON, XML only (no PDFs); 3 MB per page; no JavaScript (pages built in the browser come back empty). ⚠️ Needs the internet: queries go to the search provider, pages are fetched from their sites. |
| [browser](browser/start.ts) | Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp) (`browser_navigate`, `browser_find`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_tabs`, …), attached to **Jarvis's Chrome**: an ordinary Google Chrome with its own profile (`BROWSER_DIR/profile`, i.e. `data/browser/profile`), started the normal way with remote control on 127.0.0.1 (`BROWSER_PORT`, 9333). You use it as a browser; Jarvis helps drive it over the DevTools Protocol. Your everyday Chrome is never touched. | Open it with `npm run browser [url]` (also to sign it in to its accounts), or Jarvis opens it on its first browser action. It's detached, so it stays open when the server restarts. `BROWSER_HEADLESS=1` (no window), `BROWSER_EXECUTABLE` (default `google-chrome`). Playwright MCP runs inside `BROWSER_DIR`, so uploads and saved files can't reach anything else. `browser_run_code_unsafe` (arbitrary code in the server process) is excluded in `mcp.json`; Jarvis is told to ask before sending, buying, posting or deleting, and to hand logins and CAPTCHAs to you. Any program on this machine can use the remote-control port (and so the signed-in accounts). |

```bash
npm install
npm test
npm run typecheck
```

## Writing a plugin

1. Make a folder, e.g. `calendar/`, with a `server.ts`:

   ```ts
   import { z } from 'zod'
   import { createPlugin, failure, serve, text } from '../kit/plugin.ts'

   const plugin = createPlugin('calendar', '0.1.0', 'The owner\'s calendar.')

   plugin.registerTool(
     'today',
     { description: "Today's events.", inputSchema: { day: z.string().optional() }, annotations: { readOnlyHint: true } },
     async ({ day }) => text('09:00 Stand-up'),
   )

   await serve(plugin)
   ```

2. List it in `apps/server/mcp.json` and restart the server:

   ```json
   "calendar": { "command": "node", "args": ["../../mcp-plugins/calendar/server.ts"], "env": { "CALENDAR_TOKEN": "${CALENDAR_TOKEN}" } }
   ```

3. Add its folder to `include` in `tsconfig.json`, and tests in `test/`.

Guidelines:

- **Say what the model should know in `createPlugin`'s instructions** (e.g. "the owner lives in Ottawa"): the harness adds every plugin's instructions to the system prompt.
- **Write descriptions for the model.** It picks tools by name and description; say when to use one, and what the arguments look like.
- **Return failures, don't throw them:** `failure('There is no note "x".')` lets the model explain or retry.
- **Short results.** The harness cuts anything over 8,000 characters; voice answers need little.
- **stdout is the protocol.** Log with `log()` from the kit (stderr, shown in the server log), never `console.log`.
- **Keep the reach small.** A plugin gets only the environment set for it in `mcp.json`. Limit what it can touch (like `NOTES_DIR`), and mark tools with `readOnlyHint` / `destructiveHint`.
- Try a plugin alone with the MCP inspector: `NOTES_DIR=/tmp/notes npx @modelcontextprotocol/inspector node notes/server.ts`.

| Path | |
| --- | --- |
| `browser/` | Jarvis's Chrome (`chrome.ts`: opening it with remote control), `open.ts` (`npm run browser`), `start.ts` (Playwright MCP attached to it; opens it before a tool call if needed) |
| `kit/plugin.ts` | `createPlugin`, `serve` (stdio), `text`, `failure`, `log` |
| `notes/` | The notes plugin (`store.ts`: the sandboxed file logic) |
| `scripts/` | The scripts plugin (`runner.ts`: the sandbox, limits and the report the model reads) |
| `weather/` | The weather plugin (`openMeteo.ts`: place lookup, forecast, the spoken-style report) |
| `web/` | The web plugin (`search.ts`: Brave and SearXNG; `page.ts`: public-address checks, fetching, HTML to text) |
| `test/` | `node:test` tests |
