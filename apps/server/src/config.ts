// Server configuration from environment variables (.env, then .env.local).

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim()
  return value ? value : fallback
}

function port(name: string, fallback: number): number {
  const value = Number(env(name, String(fallback)))
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a port number`)
  return value
}

export const config = {
  /** Bind to localhost only unless deliberately opened up. */
  host: env('HOST', '127.0.0.1'),
  port: port('PORT', 5180),
  audiocppUrl: env('AUDIOCPP_URL', 'http://127.0.0.1:5552'),
  /** Browser origins allowed to call the API. Requests without an Origin (native apps, curl) are allowed. */
  allowedOrigins: env('ALLOWED_ORIGINS', 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  asrModel: env('ASR_MODEL', 'Qwen3-ASR'),
} as const
