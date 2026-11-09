// Server configuration from environment variables (.env, then .env.local).

import path from 'node:path'

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
  allowedOrigins: env('ALLOWED_ORIGINS', 'https://127.0.0.1:5173,https://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  asrModel: env('ASR_MODEL', 'Qwen3-ASR'),
  /** Database and audio archive. Contains private conversations: never commit it. */
  dataDir: path.resolve(env('DATA_DIR', 'data')),
  /** The folder Jarvis's file tools may read and write (to-dos, lists, notes, …). Created at start-up. */
  workspaceDir: path.resolve(env('WORKSPACE_DIR', path.join(env('DATA_DIR', 'data'), 'workspace'))),
  /** OpenAI-compatible chat endpoint (llama.cpp's llama-server). */
  llmUrl: env('LLM_URL', 'http://127.0.0.1:5550'),
  llmModel: env('LLM_MODEL', 'Qwen3.6-35B-A3B'),
  /** Nous Hermes Agent's OpenAI-compatible API server (the "Hermes" brain). */
  hermesUrl: env('HERMES_URL', 'http://127.0.0.1:8642'),
  hermesModel: env('HERMES_MODEL', 'hermes-agent'),
  /** Its API_SERVER_KEY; put it in .env.local. */
  hermesApiKey: process.env.HERMES_API_KEY?.trim() || undefined,
  /** Optional: the Hermes session Jarvis talks in. Unset: one is made and kept in DATA_DIR/hermes-session.json. */
  hermesSessionId: process.env.HERMES_SESSION_ID?.trim() || undefined,
  /** MCP plugins for the harness (tools for the local brain). See src/harness/config.ts. */
  mcpConfig: path.resolve(env('MCP_CONFIG', 'mcp.json')),
  /** Text-to-speech model and voice on audio.cpp, for Jarvis's spoken replies. */
  ttsModel: env('TTS_MODEL', 'Qwen3-TTS'),
  ttsVoice: env('TTS_VOICE', 'jarvis'),
  /** Pass-key for the API. Unset: one is generated and kept in DATA_DIR/access-key. */
  accessKey: process.env.ACCESS_KEY,
  /** Optional: the owner's name, for the assistant's prompt. */
  ownerName: env('OWNER_NAME', ''),
  /** Voiceprint model (npm run fetch-models). Speaker recognition is off if the file is missing. */
  voiceprintModel: path.resolve(env('VOICEPRINT_MODEL', 'models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx')),
} as const
