# Jarvis MCP plugins

Tools for Jarvis, each one a small [MCP](https://modelcontextprotocol.io) server. The harness in the server (`apps/server/src/harness`) starts the ones listed in `apps/server/mcp.json` and offers their tools to the local LLM. Because they're plain MCP servers they also work with any other MCP client, and any third-party MCP server can be listed in `mcp.json` next to them.

Same rules as the rest of Jarvis: local and private, TypeScript run directly by Node 24 (no build step).

| Plugin | Tools | Configuration |
| --- | --- | --- |
| [weather](weather/server.ts) | `get_weather`: now (temperature, feels-like, conditions, humidity, wind) and 1–7 days (min/max, conditions, chance of precipitation) for a city, with province/state and country to pick the right one ("Kingston, Ontario" vs Jamaica) | `WEATHER_HOME` (e.g. `Ottawa, Ontario, Canada`: used when no place is named) and `WEATHER_UNITS` (`celsius`, default, or `fahrenheit`); set them in `apps/server/.env.local`. Uses [Open-Meteo](https://open-meteo.com), free and keyless. ⚠️ Needs the internet: the place name and coordinates are sent to open-meteo.com. |
| [notes](notes/server.ts) | `list_notes`, `read_note`, `search_notes`, `write_note`, `append_to_note` | `NOTES_DIR`: the folder of markdown notes (default in `mcp.json`: `notes/` inside the workspace folder, `apps/server/data/workspace/notes`). Paths can't leave it (no `..`, absolute paths or symlinks out); `.md` files only, 256 KB each. |

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
| `kit/plugin.ts` | `createPlugin`, `serve` (stdio), `text`, `failure`, `log` |
| `notes/` | The notes plugin (`store.ts`: the sandboxed file logic) |
| `weather/` | The weather plugin (`openMeteo.ts`: place lookup, forecast, the spoken-style report) |
| `test/` | `node:test` tests |
