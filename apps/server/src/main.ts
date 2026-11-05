import { buildApp } from './app.ts'
import { config } from './config.ts'

const app = buildApp()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}

try {
  await app.listen({ host: config.host, port: config.port })
  app.log.info(`audio.cpp at ${config.audiocppUrl}; allowed origins: ${config.allowedOrigins.join(', ')}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
