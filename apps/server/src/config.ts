// Server configuration: config.jsonc (configFile.ts, every setting listed in
// settings.ts), with environment variables winning over it.

import path from 'node:path'
import { loadConfigFile } from './configFile.ts'

/** What config.jsonc gave (main.ts logs it). Read first: everything below reads the environment it fills. */
export const configFile = loadConfigFile()

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
  /** Keep DATA_DIR in git, committing every change (src/history/history.ts). On unless DATA_HISTORY=off. */
  dataHistory: !/^(0|off|false|no)$/i.test(env('DATA_HISTORY', 'on')),
  /** The folder Jarvis's file tools may read and write (to-dos, lists, notes, …). Created at start-up. */
  workspaceDir: path.resolve(env('WORKSPACE_DIR', path.join(env('DATA_DIR', 'data'), 'workspace'))),
  /** OpenAI-compatible chat endpoint (llama.cpp's llama-server). */
  llmUrl: env('LLM_URL', 'http://127.0.0.1:5454'),
  llmModel: env('LLM_MODEL', 'Assistant'),
  /** Optional: sent as "Authorization: Bearer …" to LLM_URL (a hosted service, or llama-server --api-key); llm.apiKey in config.jsonc. */
  llmApiKey: process.env.LLM_API_KEY?.trim() || undefined,
  /** MCP plugins for the harness (the LLM's tools). See src/harness/config.ts. */
  mcpConfig: path.resolve(env('MCP_CONFIG', 'mcp.json')),
  /** Text-to-speech model and voice on audio.cpp, for Jarvis's spoken replies. */
  ttsModel: env('TTS_MODEL', 'Qwen3-TTS'),
  ttsVoice: env('TTS_VOICE', 'jarvis'),
  /** Pass-key for the API. Unset: one is generated and kept in DATA_DIR/access-key. */
  accessKey: process.env.ACCESS_KEY,
  /** Optional: the owner's name, for the assistant's prompt. */
  ownerName: env('OWNER_NAME', ''),
  /** The LLM can see images (a vision model: llama.cpp with --mmproj): photos the owner adds are sent as images (assistant/vision.ts). */
  llmVision: /^(1|on|true|yes)$/i.test(env('LLM_VISION', 'off')),
  /** Background services Jarvis writes (docs/services.md). On unless SERVICES=off. */
  services: !/^(0|off|false|no)$/i.test(env('SERVICES', 'on')),
  /** LLM turns all services together may start in a day. */
  servicesDailyTurns: Math.max(0, Math.floor(Number(env('SERVICES_DAILY_TURNS', '200'))) || 0),
  /** "host:port" services may reach although they resolve to a private address (a device at home), comma-separated. */
  servicesLocalHosts: env('SERVICES_LOCAL_HOSTS', '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  /** The phone line (docs/phone.md): on when the VoIP.ms SIP settings are there, unless PHONE=off. */
  phone: {
    enabled: !/^(0|off|false|no)$/i.test(env('PHONE', 'on')) && Boolean(process.env.VOIPMS_SIP_SERVER?.trim() && process.env.VOIPMS_SIP_USER?.trim() && process.env.VOIPMS_SIP_PASSWORD),
    server: env('VOIPMS_SIP_SERVER', ''),
    user: env('VOIPMS_SIP_USER', ''),
    password: process.env.VOIPMS_SIP_PASSWORD ?? '',
    /** Jarvis's number (10 digits). */
    did: env('VOIPMS_DID', ''),
    /** Caller ID on calls placed for the owner (empty: the DID). */
    callerId: env('VOIPMS_CALLER_ID', ''),
    /** The owner's cell (where Marvin rings them; calls to it show the DID). */
    ownerCell: env('OWNER_CELL', ''),
    /** Longest call, and outgoing minutes a day (all calls together). */
    maxCallMinutes: Math.max(1, Number(env('PHONE_MAX_CALL_MINUTES', '120')) || 120),
    dailyMinutes: Math.max(0, Number(env('PHONE_DAILY_MINUTES', '180')) || 0),
    /** The REST API, for texts: the login email and the API password. Texts are on when both are set. */
    apiUser: env('VOIPMS_API_USER', ''),
    apiPassword: process.env.VOIPMS_API_PASSWORD ?? '',
    /** Texts Jarvis may send a day, and how often it checks for new ones. */
    dailyTexts: Math.max(0, Number(env('PHONE_DAILY_TEXTS', '50')) || 0),
    textPollSeconds: Math.max(10, Number(env('PHONE_TEXT_POLL_SECONDS', '30')) || 30),
    /** How long an incoming call rings before it's turned away. */
    ringSeconds: Math.max(5, Number(env('PHONE_RING_SECONDS', '30')) || 30),
    /** What the assistant calls itself when it answers the phone. */
    assistantName: env('PHONE_ASSISTANT_NAME', 'Marvin'),
  },
  /** Telegram (docs/telegram.md): the owner chats with Jarvis from Telegram; on when both are set, unless TELEGRAM=off. */
  telegram: {
    enabled: !/^(0|off|false|no)$/i.test(env('TELEGRAM', 'on')) && Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_OWNER_CHAT_ID?.trim()),
    token: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '',
    ownerChatId: env('TELEGRAM_OWNER_CHAT_ID', ''),
    /** Replies as a voice note too: always (default), only when the owner sent a voice note ("voice"), or never ("off"). */
    voiceReplies: ((v) => (v === 'off' || v === 'voice' ? v : 'always'))(env('TELEGRAM_VOICE_REPLIES', 'always').toLowerCase()) as 'always' | 'voice' | 'off',
  },
  /** The built web client (apps/client/dist), served at /. Unset: not served (in development Vite serves it). The release binary sets it. */
  siteDir: process.env.SITE_DIR?.trim() ? path.resolve(process.env.SITE_DIR.trim()) : null,
  /**
   * HTTPS (src/tls.ts): "off", or "self-signed" (a certificate made once in DATA_DIR/tls).
   * TLS_CERT and TLS_KEY (PEM files) override both. Off under Node, where Vite's
   * HTTPS dev server sits in front; the release binary defaults to self-signed.
   */
  tls: env('TLS', 'off'),
  tlsCert: process.env.TLS_CERT?.trim() ? path.resolve(process.env.TLS_CERT.trim()) : null,
  tlsKey: process.env.TLS_KEY?.trim() ? path.resolve(process.env.TLS_KEY.trim()) : null,
  /** Voiceprint model (npm run fetch-models). Speaker recognition is off if the file is missing. */
  voiceprintModel: path.resolve(env('VOICEPRINT_MODEL', 'models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx')),
} as const
