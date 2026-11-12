import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ConfigError, configFilePath, configSchema, loadConfigFile, renderConfig, valuesFromEnv } from '../src/configFile.ts'
import { SECTIONS, SETTINGS } from '../src/settings.ts'

function file(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-config-'))
  const f = path.join(dir, 'config.jsonc')
  fs.writeFileSync(f, text)
  return f
}

test('config file: sections fill the environment; a set variable wins; ${NAME} from the environment', () => {
  const f = file(`{
    // comments are fine, and trailing commas
    "owner": { "name": "Charbel" },
    "server": { "port": 5200, "allowedOrigins": ["https://a:5173", "https://b:5173"], },
    "llm": { "vision": true, "apiKey": "\${MY_KEY}" },
    "phone": { "did": 6135550100, "enabled": false },
    "email": { "password": "has # and 'quotes'" },
  }`)
  const env: NodeJS.ProcessEnv = { PORT: '6000', MY_KEY: 'secret-1' }
  const s = loadConfigFile(env, f)
  assert.equal(s.found, true)
  assert.equal(env.OWNER_NAME, 'Charbel')
  assert.equal(env.PORT, '6000') // the environment wins
  assert.deepEqual(s.overridden, ['server.port'])
  assert.equal(env.ALLOWED_ORIGINS, 'https://a:5173,https://b:5173')
  assert.equal(env.LLM_VISION, 'on')
  assert.equal(env.LLM_API_KEY, 'secret-1')
  assert.equal(env.VOIPMS_DID, '6135550100') // a number taken as text
  assert.equal(env.PHONE, 'off')
  assert.equal(env.EMAIL_PASSWORD, "has # and 'quotes'")
  assert.deepEqual(s.warnings, [])
})

test('config file: mistakes say where; unknown settings and unset references are warned about', () => {
  assert.throws(() => loadConfigFile({}, file('{ "server": { "port": 5200 ')), (e: Error) => e instanceof ConfigError && /line 1, column \d+/.test(e.message))
  assert.throws(() => loadConfigFile({}, file('{ "server": { "port": "lots" } }')), /server\.port: should be a number/)
  assert.throws(() => loadConfigFile({}, file('{ "server": { "port": 70000 } }')), /server\.port: should be at most 65535/)
  assert.throws(() => loadConfigFile({}, file('{ "telegram": { "voiceReplies": "sometimes" } }')), /should be one of "always", "voice", "off"/)
  assert.throws(() => loadConfigFile({}, file('{ "llm": { "vision": "yes" } }')), /llm\.vision: should be true or false/)
  const env: NodeJS.ProcessEnv = {}
  const s = loadConfigFile(env, file('{ "sever": {}, "server": { "prot": 1 }, "llm": { "apiKey": "${NOT_SET}" } }'))
  assert.deepEqual(s.warnings.sort(), ['llm.apiKey uses ${NOT_SET}, which isn\'t set', 'unknown section "sever"', 'unknown setting "server.prot"'].sort())
  assert.equal(env.LLM_API_KEY, undefined) // empty after the reference: not set
  // No file, or turned off.
  assert.equal(loadConfigFile({}, path.join(os.tmpdir(), 'no-such-config.jsonc')).found, false)
  assert.equal(configFilePath({ CONFIG_FILE: 'off' }), null)
})

test('config file: the commented file Jarvis writes reads back to the same settings, and the schema covers them all', () => {
  const fromEnv = { OWNER_NAME: 'Charbel', PORT: '5180', LLM_VISION: 'on', ALLOWED_ORIGINS: 'https://a,https://b', VOIPMS_SIP_PASSWORD: 'p#1', HERMES_API_KEY: 'x' }
  const { values, skipped } = valuesFromEnv(fromEnv)
  assert.deepEqual(skipped, ['HERMES_API_KEY'])
  assert.equal(values['server.port'], undefined) // the default: not written
  const text = renderConfig(values, { schema: './config.schema.json' })
  assert.match(text, /\/\/ "port": 5180/)
  const env: NodeJS.ProcessEnv = {}
  loadConfigFile(env, file(text))
  assert.deepEqual({ OWNER_NAME: env.OWNER_NAME, LLM_VISION: env.LLM_VISION, ALLOWED_ORIGINS: env.ALLOWED_ORIGINS, VOIPMS_SIP_PASSWORD: env.VOIPMS_SIP_PASSWORD }, { OWNER_NAME: 'Charbel', LLM_VISION: 'on', ALLOWED_ORIGINS: 'https://a,https://b', VOIPMS_SIP_PASSWORD: 'p#1' })
  // The empty file (every setting commented out) reads, and sets nothing.
  assert.deepEqual(loadConfigFile({}, file(renderConfig())).applied, [])
  const schema = configSchema() as { properties: Record<string, { properties: Record<string, unknown> }> }
  for (const s of SETTINGS) {
    const [section, name] = s.path.split('.')
    assert.ok(schema.properties[section!]?.properties[name!], s.path)
  }
  assert.equal(new Set(SETTINGS.map((s) => s.env)).size, SETTINGS.length, 'each environment variable once')
  assert.ok(SETTINGS.every((s) => SECTIONS.some((x) => s.path.startsWith(`${x.name}.`))))
})

test('the committed example file and schema match the settings table (npm run config:schema)', () => {
  const here = path.resolve(import.meta.dirname, '..')
  assert.equal(fs.readFileSync(path.join(here, 'config.schema.json'), 'utf8'), `${JSON.stringify(configSchema(), null, 2)}\n`)
  const example = fs.readFileSync(path.join(here, 'config.example.jsonc'), 'utf8')
  for (const s of SETTINGS) assert.ok(example.includes(`"${s.path.split('.')[1]}":`), s.path)
})
