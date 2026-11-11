// The release binary's entry point (built by release/build.ts with Bun):
//
//   jarvis                      the server, serving the web client
//   jarvis plugin <name> […]    a built-in MCP plugin (mcp.json starts them this way)
//   jarvis fetch-models         downloads the voiceprint model into ./models
//   jarvis version
//
// Configuration as in development: environment variables, .env and .env.local
// in the folder it's started from (Bun loads them), paths relative to it.

import fs from 'node:fs'
import path from 'node:path'
import { BUILD, KIT, MCP_JSON, SITE } from './.generated/embedded.ts'
import { PLUGINS } from './plugins.ts'
import { pruneOtherBuilds, unpack } from './unpack.ts'

// mcp.json starts the plugins with this binary; the browser plugin starts Playwright with it.
process.env.JARVIS_BIN = process.execPath

const [command, ...rest] = process.argv.slice(2)

if (command === 'plugin') {
  const plugin = PLUGINS[rest[0] ?? '']
  if (!plugin) {
    console.error(`jarvis plugin: one of ${Object.keys(PLUGINS).join(', ')}`)
    process.exit(2)
  }
  // The plugin sees only its own arguments.
  process.argv.splice(2, 2)
  await plugin.run()
} else if (command === 'fetch-models') {
  await import('../apps/server/scripts/fetch-models.ts')
} else if (command === 'version' || command === '--version') {
  console.log(`jarvis ${BUILD.version} (${BUILD.commit}, built ${BUILD.date})`)
} else if (command === undefined || command === 'serve') {
  process.env.SITE_DIR ||= unpack('site', SITE)
  process.env.JARVIS_KIT_DIR = unpack('kit', KIT)
  pruneOtherBuilds()
  // Nothing sits in front of this server, so it speaks HTTPS itself unless told not to.
  if (!process.env.TLS?.trim()) process.env.TLS = 'self-signed'
  // The plugins' config, the first time: edit it like apps/server/mcp.json.
  const mcpConfig = path.resolve(process.env.MCP_CONFIG?.trim() || 'mcp.json')
  if (!fs.existsSync(mcpConfig)) {
    fs.writeFileSync(mcpConfig, MCP_JSON)
    console.log(`wrote ${mcpConfig} (the built-in plugins)`)
  }
  await import('../apps/server/src/main.ts')
} else {
  console.error(`jarvis ${BUILD.version}

  jarvis                      the server and the web client
  jarvis plugin <name> […]    a built-in MCP plugin (${Object.keys(PLUGINS).join(', ')})
  jarvis fetch-models         download the voiceprint model into ./models
  jarvis version`)
  process.exit(command === 'help' || command === '--help' ? 0 : 2)
}
