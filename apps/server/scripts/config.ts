// config.jsonc tools (src/configFile.ts):
//
//   npm run config:init     writes config.jsonc from .env and .env.local (only what differs from
//                           the defaults; every other setting is there too, commented out, with
//                           what it does). Never overwrites an existing config.jsonc.
//   npm run config:schema   writes config.schema.json (your editor checks and completes the file
//                           with it) and config.example.jsonc, from the settings table.

import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { configSchema, renderConfig, valuesFromEnv } from '../src/configFile.ts'

const here = path.resolve(import.meta.dirname, '..')
const [command, ...args] = process.argv.slice(2)

if (command === 'schema') {
  fs.writeFileSync(path.join(here, 'config.schema.json'), `${JSON.stringify(configSchema(), null, 2)}\n`)
  fs.writeFileSync(
    path.join(here, 'config.example.jsonc'),
    renderConfig({}, {
      schema: './config.schema.json',
      header: ["Jarvis's settings. Copy to config.jsonc (git ignores it) and set what you need; every setting is", 'here with what it does, commented out at its default. "${NAME}" in a value is taken from the environment.'],
    }),
  )
  console.log('wrote config.schema.json and config.example.jsonc')
} else if (command === 'init') {
  const target = path.resolve(args[0] ?? path.join(here, 'config.jsonc'))
  if (fs.existsSync(target)) {
    console.error(`${target} exists: not overwritten. Move it away first to make it again.`)
    process.exit(1)
  }
  // Only what the two files say (not this shell's own variables), .env.local winning, as before.
  const read = (name: string) => (fs.existsSync(path.join(here, name)) ? parseEnv(fs.readFileSync(path.join(here, name), 'utf8')) : {})
  const fromFiles = { ...read('.env'), ...read('.env.local') }
  const { values, skipped } = valuesFromEnv(fromFiles)
  if (skipped.length) console.warn(`not settings Jarvis reads, left out: ${skipped.join(', ')}`)
  const text = renderConfig(values, {
    schema: './config.schema.json',
    header: ["Jarvis's settings (git ignores this file: it has passwords). Made from .env and .env.local by", '`npm run config:init`; every setting is here, the ones not set commented out at their default.', 'An environment variable that is set wins over this file. "${NAME}" in a value comes from the environment.'],
  })
  fs.writeFileSync(target, text, { mode: 0o600 })
  console.log(`wrote ${target} (${Object.keys(values).length} settings set)`)
} else {
  console.error('npm run config:init | npm run config:schema')
  process.exit(2)
}
