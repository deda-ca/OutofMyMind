# Loading tools on demand (design, for version 2)

Status: not built. Written 2026-11-11 so the next version is designed this way from the start rather than changed later.

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

## First steps (when it's built)

1. Defer the **browser** only: about 17,700 characters off almost every turn. Check with the Debug tab (captured LLM traffic) that the prompt shrank and that browsing tasks still load it.
2. Then split **files**: reading always loaded; writing, editing and moving on demand.
3. Keep the tool list stable across turns: watch for the built-in tools that change it.

Related: the phone becoming an MCP plugin in version 2 ([phone.md](phone.md)) would put its tools under the same rules.
