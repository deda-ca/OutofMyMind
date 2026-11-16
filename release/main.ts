// The release binary's entry point (built by release/build.ts with Bun):
//
//   jarvis [--data DIR]                 the server, serving the web client
//   jarvis init [--data DIR]            makes the data folder, with config.jsonc to edit
//   jarvis plugin <name> […]            a built-in MCP plugin (mcp.json starts them this way)
//   jarvis fetch-models [--data DIR]    downloads the voiceprint model into DIR/models (it's built in too)
//   jarvis version
//
// Everything Jarvis keeps is in one folder, the data folder: --data DIR, else
// JARVIS_HOME, else ./data. It holds config.jsonc (the settings), mcp.json
// (the plugins, written the first time), the database, workspace and the rest;
// the binary works from inside it, so relative paths in config.jsonc are
// relative to it. Environment variables still win over config.jsonc.

import fs from 'node:fs'
import path from 'node:path'
import { configSchema, loadConfigFile, renderConfig } from '../apps/server/src/configFile.ts'
import { BUILD, KIT, MCP_JSON, MODELS, PLATFORM_KIT, PLUGIN_FILES, SITE } from './.generated/embedded.ts'
import { PLUGINS } from './plugins.ts'
import { pruneOtherBuilds, unpack } from './unpack.ts'

// mcp.json starts the plugins with this binary; the browser plugin starts Playwright with it.
process.env.JARVIS_BIN = process.execPath

const [command, ...rest] = process.argv.slice(2)

/** The data folder, from --data DIR / --data=DIR, JARVIS_HOME, or ./data. */
function dataFolder(args: string[]): string {
  let chosen: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--data' || a === '-d') chosen = args[++i]
    else if (a.startsWith('--data=')) chosen = a.slice('--data='.length)
    else {
      console.error(`jarvis: unknown argument ${a}`)
      process.exit(2)
    }
    if (!chosen) {
      console.error('jarvis: --data needs a folder')
      process.exit(2)
    }
  }
  return path.resolve(chosen || process.env.JARVIS_HOME?.trim() || 'data')
}

/** Into the data folder (made if missing), so every relative path is relative to it. */
function enter(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  process.chdir(dir)
  process.env.JARVIS_HOME = dir
}

/** config.schema.json (always, it's this build's) and a commented config.jsonc (if there's none). */
function writeConfigFiles(dir: string): boolean {
  fs.writeFileSync(path.join(dir, 'config.schema.json'), `${JSON.stringify(configSchema(), null, 2)}\n`)
  const file = path.join(dir, 'config.jsonc')
  if (fs.existsSync(file)) return false
  const header = ['Jarvis settings. Every setting is listed, commented out at its default: uncomment what you change.', 'Relative paths are relative to this folder (the data folder). Environment variables win over this file.']
  fs.writeFileSync(file, renderConfig({}, { schema: './config.schema.json', header }), { mode: 0o600 })
  return true
}

const usage = `jarvis ${BUILD.version}

  jarvis [--data DIR]                the server and the web client
  jarvis init [--data DIR]           make the data folder, with a config.jsonc to edit
  jarvis plugin <name> […]           a built-in MCP plugin (${Object.keys(PLUGINS).join(', ')})
  jarvis fetch-models [--data DIR]   download the voiceprint model into DIR/models (not needed: it's built in)
  jarvis version

  The data folder (--data DIR, else $JARVIS_HOME, else ./data) holds everything:
  config.jsonc, mcp.json, the database, the workspace, the access key.`

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
  enter(dataFolder(rest))
  await import('../apps/server/scripts/fetch-models.ts')
} else if (command === 'version' || command === '--version') {
  console.log(`jarvis ${BUILD.version} (${BUILD.commit}, built ${BUILD.date})`)
} else if (command === 'init') {
  const dir = dataFolder(rest)
  enter(dir)
  const made = writeConfigFiles(dir)
  console.log(made ? `wrote ${path.join(dir, 'config.jsonc')}: set at least llm.url, llm.model, audio.url, owner.name, then run jarvis --data ${dir}` : `${path.join(dir, 'config.jsonc')} is already there (config.schema.json updated)`)
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(usage)
} else if (command === undefined || command === 'serve' || command.startsWith('-')) {
  const dir = dataFolder(command === undefined || command === 'serve' ? rest : [command, ...rest])
  enter(dir)
  process.env.SITE_DIR ||= unpack('site', SITE)
  process.env.JARVIS_KIT_DIR = unpack('kit', KIT)
  // Self-contained plugins' manifests and tabs (mcp.json points at them), and the tabs' shared kit.
  process.env.JARVIS_PLUGINS_DIR = unpack('plugins', PLUGIN_FILES)
  process.env.JARVIS_PLATFORM_KIT = unpack('platform-kit', PLATFORM_KIT)
  pruneOtherBuilds()
  if (writeConfigFiles(dir)) console.log(`wrote ${path.join(dir, 'config.jsonc')} (every setting, at its default: edit it and restart)`)
  // The data folder is the data: data.dir in config.jsonc (from a development setup, "data") doesn't apply.
  process.env.CONFIG_FILE = path.join(dir, 'config.jsonc')
  process.env.DATA_DIR = dir
  // config.jsonc next: the defaults below apply only to what it (or the environment) doesn't set.
  const status = loadConfigFile()
  if (status.overridden.includes('data.dir')) console.log(`config: data.dir is ignored by the release: the data folder is ${dir}`)
  // The voiceprint model: DIR/models if it's there (fetch-models), else the one built in.
  if (!process.env.VOICEPRINT_MODEL?.trim() && MODELS.length) {
    const [name] = MODELS[0]!
    if (!fs.existsSync(path.join(dir, 'models', name))) process.env.VOICEPRINT_MODEL = path.join(unpack('models', MODELS), name)
  }
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
  console.error(usage)
  process.exit(2)
}
