import { buildApp } from './app.ts'
import { loadAccessKey } from './auth.ts'
import { config } from './config.ts'
import { harness } from './harness/index.ts'
import { VoiceprintModel } from './speaker/voiceprint.ts'

const voiceprintModel = await VoiceprintModel.load(config.voiceprintModel, (message) => console.warn(message))
const access = loadAccessKey(config.dataDir, config.accessKey)
const app = buildApp({ voiceprintModel, accessKey: access.key })
app.addHook('onClose', () => harness.close())
await harness.start(config.mcpConfig, (message, err) => (err ? console.warn(message, err) : console.log(message)))

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}

try {
  await app.listen({ host: config.host, port: config.port })
  app.log.info(`audio.cpp at ${config.audiocppUrl}; allowed origins: ${config.allowedOrigins.join(', ')}`)
  app.log.info(voiceprintModel ? `speaker recognition on (${voiceprintModel.name})` : 'speaker recognition off')
  if (config.accessKey) app.log.info('access key: from ACCESS_KEY')
  else console.log(`\n  Jarvis access key: ${access.key}${access.generated ? '  (new; saved in ' + config.dataDir + '/access-key)' : ''}\n  Enter it once on each device. Set ACCESS_KEY in .env.local to choose your own.\n`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
