// The MCP plugins built into the release binary: `jarvis plugin <name> [args]`.
// `script` is how apps/server/mcp.json starts each one under Node (relative to
// the repository); build.ts rewrites those entries to the binary.

export const PLUGINS: Record<string, { script: string; run: () => Promise<unknown> }> = {
  notes: { script: 'mcp-plugins/notes/server.ts', run: () => import('../mcp-plugins/notes/server.ts') },
  weather: { script: 'mcp-plugins/weather/server.ts', run: () => import('../mcp-plugins/weather/server.ts') },
  scripts: { script: 'mcp-plugins/scripts/server.ts', run: () => import('../mcp-plugins/scripts/server.ts') },
  web: { script: 'mcp-plugins/web/server.ts', run: () => import('../mcp-plugins/web/server.ts') },
  browser: { script: 'mcp-plugins/browser/start.ts', run: () => import('../mcp-plugins/browser/start.ts') },
  telegram: { script: 'mcp-plugins/telegram/server.ts', run: () => import('../mcp-plugins/telegram/server.ts') },
  files: {
    script: 'mcp-plugins/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js',
    // Starts itself only as the process entry point (build.ts turns that off): start it here.
    run: async () => (await import('../mcp-plugins/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js')).main(),
  },
  // Started by the browser plugin, not by mcp.json.
  playwright: { script: 'mcp-plugins/node_modules/@playwright/mcp/cli.js', run: () => import('../mcp-plugins/node_modules/@playwright/mcp/cli.js') },
}
