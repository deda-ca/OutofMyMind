import fs from 'node:fs'
import { AgentLibrary } from './agents/library.ts'
import { SkillLibrary } from './skills/library.ts'
import { buildApp } from './app.ts'
import { loadAccessKey } from './auth.ts'
import { config, configFile } from './config.ts'
import { harness } from './harness/index.ts'
import { DataHistory } from './history/history.ts'
import { VoiceprintModel } from './speaker/voiceprint.ts'
import { loadTls } from './tls.ts'

// What config.jsonc gave, and anything in it that looks wrong (a typo in a setting's name).
if (configFile.found) console.log(`config: ${configFile.file}: ${configFile.applied.length} settings${configFile.overridden.length ? `; overridden by the environment: ${configFile.overridden.join(', ')}` : ''}`)
for (const w of configFile.warnings) console.warn(`config: ${w}`)

const voiceprintModel = await VoiceprintModel.load(config.voiceprintModel, (message) => console.warn(message))
const access = loadAccessKey(config.dataDir, config.accessKey)
const tls = loadTls(config)
const app = buildApp({ voiceprintModel, accessKey: access.key, schedules: true, https: tls ?? undefined, siteDir: config.siteDir })
app.addHook('onClose', () => harness.close())
// The file tools' folder must exist before their plugin starts (it refuses to run without it).
fs.mkdirSync(config.workspaceDir, { recursive: true })
// SYSTEM.md and the default agent, the first time.
new AgentLibrary(config.workspaceDir).seed()
// The starter skills (to-do list, weight log), the first time.
new SkillLibrary(config.workspaceDir).seed()
await harness.start(config.mcpConfig, (message, err) => (err ? console.warn(message, err) : console.log(message)))
// Every change to the data folder, committed to git (DATA_HISTORY=off to turn it off).
const history = config.dataHistory ? new DataHistory({ dataDir: config.dataDir, workspaceDir: config.workspaceDir, log: (m, err) => (err ? console.warn(m, err) : console.log(m)) }) : null
await history?.start().catch((err: Error) => console.warn(`history: off: ${err.message}`))
app.addHook('onClose', () => history?.stop())

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}

try {
  await app.listen({ host: config.host, port: config.port })
  app.log.info(`audio.cpp at ${config.audiocppUrl}; allowed origins: ${config.allowedOrigins.join(', ')}`)
  app.log.info(voiceprintModel ? `speaker recognition on (${voiceprintModel.name})` : 'speaker recognition off')
  if (tls) app.log.info(`HTTPS (${tls.source}); certificate SHA-256 ${tls.fingerprint}`)
  if (config.siteDir) console.log(`\n  Jarvis: ${tls ? 'https' : 'http'}://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/${config.host === '0.0.0.0' ? ' (and this machine\'s other addresses)' : ''}`)
  if (config.accessKey) app.log.info('access key: from ACCESS_KEY')
  else console.log(`\n  Jarvis access key: ${access.key}${access.generated ? '  (new; saved in ' + config.dataDir + '/access-key)' : ''}\n  Enter it once on each device. Set server.accessKey in config.jsonc to choose your own.\n`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
