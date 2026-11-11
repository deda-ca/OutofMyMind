// The MCP plugins built into the release binary: `jarvis plugin <name> [args]`.
// `script` is how apps/server/mcp.json starts each one under Node (relative to
// the repository); build.ts rewrites those entries to the binary.

export const PLUGINS: Record<string, { script: string; run: () => Promise<unknown> }> = {
  notes: { script: 'plugins/notes/server.ts', run: () => import('../plugins/notes/server.ts') },
  weather: { script: 'plugins/weather/server.ts', run: () => import('../plugins/weather/server.ts') },
  scripts: { script: 'plugins/scripts/server.ts', run: () => import('../plugins/scripts/server.ts') },
  web: { script: 'plugins/web/server.ts', run: () => import('../plugins/web/server.ts') },
  browser: { script: 'plugins/browser/start.ts', run: () => import('../plugins/browser/start.ts') },
  telegram: { script: 'plugins/telegram/server.ts', run: () => import('../plugins/telegram/server.ts') },
  email: { script: 'plugins/email/server.ts', run: () => import('../plugins/email/server.ts') },
  files: {
    script: 'plugins/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js',
    // Starts itself only as the process entry point (build.ts turns that off): start it here.
    run: async () => (await import('../plugins/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js')).main(),
  },
  // Started by the browser plugin, not by mcp.json.
  playwright: { script: 'plugins/node_modules/@playwright/mcp/cli.js', run: () => import('../plugins/node_modules/@playwright/mcp/cli.js') },
}
