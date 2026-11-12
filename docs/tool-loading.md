# Loading tools on demand (design, for version 2)

Status: **both first steps are built** (2026-11-12): the browser is on demand, and the files plugin's write tools are on demand. Plugins can be marked `"load": "on demand"` (the whole plugin) or `"deferTools": [...]` (some of its tools), both with a `summary`; see "Built" below. Written 2026-11-11 so the design was settled before building.

## The problem

Every request to the LLM carries the full JSON schema of every tool, whether or not the turn needs them. Measured on 2026-11-11:

| What | Size |
| --- | --- |
| MCP tools (50, full schemas) | ~34,000 characters, about 10k tokens |
| Plugin instructions (`toolGuidance()`) | ~6,000 characters, about 1.7k tokens |
| Jarvis's built-in tools (phone, schedules, services, skills, …) | on top of that |

By plugin: browser ~17,700 characters (half of it), files ~11,000, web ~1,800, notes ~1,700, scripts ~1,100, weather ~1,000. So every turn spends roughly 12k tokens describing tools before anything is said, and it grows with each plugin added.

On a local llama.cpp server this isn't a per-call bill: llama-server keeps the processed start of the prompt (prefix cache), so an unchanged tool list isn't recomputed every turn. What it costs:

- **Context window**: 12k tokens that push the conversation out sooner.
- **Tool choice**: smaller models choose worse among 50+ tools (the browser's 17 tools are tempting for jobs `web` does better).
- **The cache**: the tool list sits at the very start of the prompt, so any change to it (the phone's tools appear only while a line runs; services' tools vary) means the whole prompt is processed again.

With a hosted API (Anthropic, OpenAI) it is also a cost on every call.

## The idea

Anthropic's approach, the **tool search** pattern: only a few core tools are sent in full; the rest are marked as deferred and found through a search tool, and their full definitions are loaded only when the model asks for them. Jarvis's skills already work this way (names and one-line descriptions in the prompt; `read skill` for the full text).

llama.cpp's OpenAI-compatible API has no deferred tools, so it goes in the harness (`apps/server/src/harness/`), the same for every provider:

1. **Always loaded** (a fixed list, so the cache holds): Jarvis's built-in tools, and the small or constantly used ones (notes, web search, weather, reading files).
2. **Listed, not loaded**: one line per deferred plugin in the system prompt, e.g. "browser: drive a web page (navigate, click, fill forms, screenshots)", plus a `tools__load` tool.
3. **Loaded on demand**: `tools__load({ plugin: "browser" })` adds that plugin's full schemas for the rest of the turn (or the session, if that proves better), and the loop's next request includes them.

Load **by plugin**, not by single tool: simpler for the model, and that's where the size is.

Plugins declare it in `mcp.json` (e.g. `"load": "always" | "on demand"`, with a one-line summary for the listing), so a new plugin chooses when it's added.

## Trade-offs

- **One extra round trip** when a deferred plugin is needed (~0.3 s locally), and that request misses the cache.
- **The model might not think of a tool it can't see**: every deferred plugin keeps its one line in the prompt, and its description says what it's for.
- **Order matters for the cache**: always-loaded tools first and in a fixed order; tools that come and go (the phone, services) after them, or always present and refusing when unavailable.

## Built (2026-11-12)

- `mcp.json`: a plugin with `"load": "on demand"` and a one-line `"summary"` (required with it). Default: `"always"`.
- The system prompt lists each on-demand plugin as one line (its summary, and how to load it); its tools and its full instructions are left out.
- `tools__load({ plugin })` is offered while there's an unloaded on-demand plugin the agent may use. It loads that plugin's tools for the rest of the reply, and returns its instructions. A new reply starts with them unloaded again, so the prompt is the same from one reply to the next.
- Measured on the real config: the browser is 24 of 72 tools, about 17,700 characters of schemas and 1,600 of instructions. Each request now drops those: about 30,400 characters of tools remain, from 48,100.
- Checked with the local LLM on the real plugin list: "open example.com and tell me the heading" loads the browser first and then uses it; "check my notes" and "say hello" don't load it.
- Tests: `test/onDemand.test.ts` (listing, loading, reply-to-reply reset, an agent without the plugin, an unknown name, tools on demand within a plugin, a waiting tool called early is refused).
- **Files, step 2:** `deferTools` names six of the files plugin's tools (write_file, append_file, edit_file, create_directory, move_file, copy_file). Their names don't change, so agents' tool lists and the messaging checks keep working. The rest of files (reading, listing, searching) is always offered. Measured: about 4,300 characters off each request. Default tool definitions without the browser are now about 26,100 characters, down from 30,400 (and 48,100 before the browser change).
- Checked with the local LLM on the real config, in a temporary workspace: "add milk to my shopping list" loaded the write tools and wrote the file; a follow-up "add eggs" appended to it. In one earlier run the model searched for several steps and never loaded them, so reliability is good but not perfect: a line in the prompt that says to load before writing is the main cue.
- The loop refuses a call to a tool that is on demand and not loaded, whatever name the model used (the skill guard and the rest of the hooks still run on the tools that are offered).

## First steps (when it's built)

1. Done: the browser on demand.
2. Done: files split (reading always; writing, editing, moving and copying on demand).
3. Still to do: check the Debug tab on a live request, to see the prompt shrink as measured rather than as computed from the schemas.
4. Keep the tool list stable across turns: watch for the built-in tools that change it.

Related: the phone becoming an MCP plugin in version 2 ([phone.md](phone.md)) would put its tools under the same rules.
