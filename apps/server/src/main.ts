import { buildApp } from './app.ts'
import { config } from './config.ts'
import { VoiceprintModel } from './speaker/voiceprint.ts'

const voiceprintModel = await VoiceprintModel.load(config.voiceprintModel, (message) => console.warn(message))
const app = buildApp({ voiceprintModel })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}

try {
  await app.listen({ host: config.host, port: config.port })
  app.log.info(`audio.cpp at ${config.audiocppUrl}; allowed origins: ${config.allowedOrigins.join(', ')}`)
  app.log.info(voiceprintModel ? `speaker recognition on (${voiceprintModel.name})` : 'speaker recognition off')
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
