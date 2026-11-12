// Every setting Jarvis reads, in one table: where it sits in config.jsonc,
// the environment variable it also answers to, its type, default and what it
// does. The config file loader (configFile.ts), the JSON Schema your editor
// uses (config.schema.json) and the commented example file are all made from
// this table, so a setting is added in one place.
//
// The environment variable names are kept on purpose: the rest of Jarvis
// (config.ts, mcp.json's ${…}, the plugins' manifests) reads them, so moving
// to config.jsonc changed nothing else. An environment variable that's set
// wins over the file (handy for a one-off change, the release, Docker).

export type SettingType = 'string' | 'secret' | 'number' | 'boolean' | 'list' | 'path'

export interface Setting {
  /** Where it sits in config.jsonc: section, then name ("llm.url"). */
  path: string
  /** The environment variable it answers to (and fills, for the rest of Jarvis). */
  env: string
  type: SettingType
  /** As written in the file (booleans true/false, lists as arrays). Undefined: none. */
  default?: string | number | boolean | string[]
  doc: string
  /** For numbers. */
  min?: number
  max?: number
  /** Allowed values, for strings. */
  enum?: string[]
}

export interface Section {
  name: string
  doc: string
  /** Settings that are lists of objects (read by their own code, not as environment variables), with an example for the commented file. */
  structured?: { name: string; doc: string; example: string[]; schema: Record<string, unknown> }[]
}

/** One LLM connection in llm.connections (assistant/models.ts reads them). */
const CONNECTION_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$', description: 'A short name, used in "connection/model" (e.g. "anthropic").' },
      label: { type: 'string', description: 'What it is called on screen.' },
      kind: { enum: ['openai', 'anthropic'], default: 'openai', description: 'openai: any OpenAI-compatible host (OpenAI, xAI Grok, OpenRouter, Groq, llama.cpp, Ollama, LM Studio, vLLM). anthropic: Claude, through Anthropic\'s own API.' },
      url: { type: 'string', description: 'Its address (openai kind: required; e.g. https://api.openai.com, https://api.x.ai, http://127.0.0.1:5454).' },
      apiKey: { type: 'string', description: 'Its API key; "${NAME}" takes it from the environment.' },
      model: { type: 'string', description: 'The model agents on this connection use unless they name another.' },
      models: { type: 'array', items: { type: 'string' }, description: 'The models offered in the pickers. Default: the ones the connection lists.' },
      vision: { type: 'boolean', description: 'Its models can see images (anthropic: default true).' },
      llamaCpp: { type: 'boolean', description: 'A llama.cpp server: its token counter and context size feed the context meter, and replies are asked for without thinking.' },
      effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'anthropic: how hard Claude thinks (default: the model\'s own).' },
      contextWindow: { type: 'number', description: 'Its context size in tokens, for the context meter (llama.cpp tells it itself).' },
      extra: { type: 'object', description: 'Extra request fields sent with every request (openai kind).' },
      prices: {
        type: 'object',
        description: 'Dollars per million tokens, by model ("*": any model), for the usage and cost shown: { "gpt-5": { "input": 1.25, "output": 10, "cacheRead": 0.125 } }. Claude\'s are built in; llama.cpp is free.',
        additionalProperties: {
          type: 'object',
          required: ['input', 'output'],
          additionalProperties: false,
          properties: { input: { type: 'number', minimum: 0 }, output: { type: 'number', minimum: 0 }, cacheRead: { type: 'number', minimum: 0 }, cacheWrite: { type: 'number', minimum: 0 } },
        },
      },
      budget: { type: 'number', minimum: 0, description: 'Dollars a day on this connection: once spent, new turns use the default model (llm.default) until tomorrow, and you are told.' },
    },
  },
}

/** One speech server in audio.connections (audioConnections.ts reads them). */
const AUDIO_CONNECTION_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$', description: 'A short name, used in "connection/model" (e.g. "local").' },
      label: { type: 'string', description: 'What it is called on screen.' },
      kind: { enum: ['audiocpp', 'openai'], default: 'audiocpp', description: 'audiocpp: an audio.cpp server (lists its models and voices itself). openai: an OpenAI-style speech API (/v1/audio/transcriptions and /v1/audio/speech: OpenAI, Groq, Speaches, LocalAI, …).' },
      url: { type: 'string', description: 'Its address (audiocpp: required; openai default https://api.openai.com).' },
      apiKey: { type: 'string', description: 'Its API key; "${NAME}" takes it from the environment.' },
      stt: { type: 'array', items: { type: 'string' }, description: 'Its transcription models (audiocpp: default, the ones it lists).' },
      tts: { type: 'array', items: { type: 'string' }, description: 'Its text-to-speech models (audiocpp: default, the ones it lists).' },
      voices: { type: 'array', items: { type: 'string' }, description: 'Its voices (audiocpp: default, the ones it lists; openai: needed, e.g. ["alloy", "nova"]).' },
    },
  },
}

export const SECTIONS: Section[] = [
  { name: 'owner', doc: 'Who Jarvis works for.' },
  { name: 'server', doc: 'The API server: where it listens, who may call it, HTTPS.' },
  { name: 'data', doc: 'Where Jarvis keeps its data and your files.' },
  {
    name: 'llm',
    doc: 'The LLMs Jarvis answers with. One connection (url, model, apiKey below), or several in "connections": each agent picks "connection/model".',
    structured: [
      {
        name: 'connections',
        doc: 'Several LLM connections (when set, the url, model, apiKey and vision above are not used: make your local server one of these).',
        example: [
          '"connections": [',
          '  { "id": "local", "kind": "openai", "url": "http://127.0.0.1:5454", "model": "Assistant", "llamaCpp": true, "vision": true },',
          '  { "id": "anthropic", "kind": "anthropic", "apiKey": "${ANTHROPIC_API_KEY}", "model": "claude-opus-5-5", "budget": 5 },',
          '  { "id": "openai", "kind": "openai", "url": "https://api.openai.com", "apiKey": "${OPENAI_API_KEY}", "model": "gpt-5", "prices": { "gpt-5": { "input": 1.25, "output": 10, "cacheRead": 0.125 } } },',
          '  { "id": "grok", "kind": "openai", "url": "https://api.x.ai", "apiKey": "${XAI_API_KEY}", "model": "grok-4" }',
          ']',
        ],
        schema: CONNECTION_SCHEMA,
      },
    ],
  },
  {
    name: 'audio',
    doc: 'Speech: transcription (speech-to-text) and text-to-speech, and the voiceprint model. One audio.cpp server (url, asrModel, ttsModel below), or several servers in "connections": transcription and speech each pick "connection/model", and agents can pick their own speech model and voice.',
    structured: [
      {
        name: 'connections',
        doc: 'Several speech servers (when set, url, asrModel and ttsModel above are not used: make your audio.cpp one of these).',
        example: [
          '"connections": [',
          '  { "id": "local", "kind": "audiocpp", "url": "http://127.0.0.1:5552" },',
          '  { "id": "openai", "kind": "openai", "apiKey": "${OPENAI_API_KEY}", "stt": ["gpt-4o-transcribe"], "tts": ["gpt-4o-mini-tts"], "voices": ["alloy", "nova", "onyx"] }',
          ']',
        ],
        schema: AUDIO_CONNECTION_SCHEMA,
      },
    ],
  },
  { name: 'services', doc: 'Background services Jarvis writes for itself (docs/services.md).' },
  { name: 'scripts', doc: 'Scripts Jarvis runs (the scripts plugin), and the Node.js used for them and for services.' },
  { name: 'web', doc: 'Web search and the browser Jarvis uses (the web and browser plugins).' },
  { name: 'weather', doc: 'The weather plugin.' },
  { name: 'phone', doc: 'The phone line through VoIP.ms: calls, Marvin answering, texts (docs/phone.md).' },
  { name: 'telegram', doc: 'Telegram: chat with Jarvis from your phone, and Jarvis messages you there (docs/telegram.md).' },
  { name: 'email', doc: 'The email plugin: the inbox Jarvis watches and sends from (docs/email.md).' },
  { name: 'calendar', doc: 'The calendar plugin: a CalDAV calendar (docs/calendar.md).' },
]

export const SETTINGS: Setting[] = [
  // owner
  { path: 'owner.name', env: 'OWNER_NAME', type: 'string', default: '', doc: 'Your name, so Jarvis knows who it works for.' },

  // server
  { path: 'server.host', env: 'HOST', type: 'string', default: '127.0.0.1', doc: 'The address to listen on: 127.0.0.1 (this machine only) unless deliberately opened up.' },
  { path: 'server.port', env: 'PORT', type: 'number', default: 5180, min: 1, max: 65535, doc: 'The port to listen on.' },
  {
    path: 'server.allowedOrigins',
    env: 'ALLOWED_ORIGINS',
    type: 'list',
    default: ['https://127.0.0.1:5173', 'https://localhost:5173'],
    doc: "Browser origins allowed to call the API. Add this machine's LAN address to use Jarvis from a phone, e.g. https://192.168.1.50:5173.",
  },
  { path: 'server.accessKey', env: 'ACCESS_KEY', type: 'secret', doc: 'The pass-key for signing in. Unset: one is generated and kept in the data folder (access-key).' },
  { path: 'server.tls', env: 'TLS', type: 'string', default: 'off', enum: ['off', 'self-signed'], doc: 'HTTPS: off (under Node, Vite serves HTTPS in front), or self-signed (a certificate made once). The release binary defaults to self-signed.' },
  { path: 'server.tlsCert', env: 'TLS_CERT', type: 'path', doc: 'Your own certificate (PEM), with tlsKey: overrides tls.' },
  { path: 'server.tlsKey', env: 'TLS_KEY', type: 'path', doc: "Your certificate's private key (PEM)." },
  { path: 'server.siteDir', env: 'SITE_DIR', type: 'path', doc: 'The built web client to serve at /. Unset: not served (in development Vite serves it; the release binary sets it).' },
  { path: 'server.logLevel', env: 'LOG_LEVEL', type: 'string', default: 'info', enum: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'], doc: 'How much the server logs.' },

  // data
  { path: 'data.dir', env: 'DATA_DIR', type: 'path', default: 'data', doc: 'The database, audio archive and everything Jarvis keeps (relative to apps/server). Private conversations: never commit it.' },
  { path: 'data.workspace', env: 'WORKSPACE_DIR', type: 'path', doc: "The folder Jarvis's file tools work in (to-dos, lists, notes, …). Default: <data.dir>/workspace." },
  { path: 'data.history', env: 'DATA_HISTORY', type: 'boolean', default: true, doc: 'Keep the data folder in git, committing every change (any change can be undone).' },
  { path: 'data.plugins', env: 'MCP_CONFIG', type: 'path', default: 'mcp.json', doc: "Which plugins are on (the LLM's tools)." },

  // llm
  { path: 'llm.default', env: 'LLM_DEFAULT', type: 'string', doc: 'With several connections: the model agents use unless they pick one, as "connection/model" (e.g. "local/Assistant"). Default: the first connection\'s model.' },
  { path: 'llm.url', env: 'LLM_URL', type: 'string', default: 'http://127.0.0.1:5454', doc: 'The OpenAI-compatible chat endpoint (llama.cpp\'s llama-server, or a hosted service).' },
  { path: 'llm.model', env: 'LLM_MODEL', type: 'string', default: 'Assistant', doc: 'The model name to ask for.' },
  { path: 'llm.apiKey', env: 'LLM_API_KEY', type: 'secret', doc: 'Sent as "Authorization: Bearer …" (a hosted service, or llama-server --api-key).' },
  { path: 'llm.vision', env: 'LLM_VISION', type: 'boolean', default: false, doc: "The model can see images (llama.cpp with --mmproj): photos you add are sent to it." },

  // audio
  { path: 'audio.stt', env: 'AUDIO_STT', type: 'string', doc: 'With several connections: the transcription model, as "connection/model" (e.g. "local/Qwen3-ASR"). Default: the first one there is.' },
  { path: 'audio.tts', env: 'AUDIO_TTS', type: 'string', doc: 'With several connections: the text-to-speech model, as "connection/model" (e.g. "local/Qwen3-TTS"). Agents can pick their own. Default: the first one there is.' },
  { path: 'audio.url', env: 'AUDIOCPP_URL', type: 'string', default: 'http://127.0.0.1:5552', doc: 'audio.cpp, for transcription and text-to-speech.' },
  { path: 'audio.asrModel', env: 'ASR_MODEL', type: 'string', default: 'Qwen3-ASR', doc: 'The transcription model on audio.cpp.' },
  { path: 'audio.ttsModel', env: 'TTS_MODEL', type: 'string', default: 'Qwen3-TTS', doc: 'The text-to-speech model on audio.cpp.' },
  { path: 'audio.ttsVoice', env: 'TTS_VOICE', type: 'string', default: 'jarvis', doc: "Jarvis's voice: one the text-to-speech model has (agents can have their own)." },
  { path: 'audio.voiceprintModel', env: 'VOICEPRINT_MODEL', type: 'path', default: 'models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx', doc: 'The voiceprint model for speaker recognition (npm run fetch-models). Missing: recognition is off.' },

  // services
  { path: 'services.enabled', env: 'SERVICES', type: 'boolean', default: true, doc: 'Background services on.' },
  { path: 'services.dailyTurns', env: 'SERVICES_DAILY_TURNS', type: 'number', default: 200, min: 0, doc: "LLM turns services' (and plugins') events may start in a day, all together." },
  { path: 'services.localHosts', env: 'SERVICES_LOCAL_HOSTS', type: 'list', default: [], doc: '"host:port" services may reach although they resolve to a private address (a device at home).' },

  // scripts
  { path: 'scripts.node', env: 'JARVIS_NODE', type: 'path', doc: 'The Node.js 24 that runs scripts and services. Unset: the first node on PATH.' },
  { path: 'scripts.timeoutSeconds', env: 'SCRIPTS_TIMEOUT_SECONDS', type: 'number', min: 1, doc: 'The longest a script may run.' },
  { path: 'scripts.memoryMb', env: 'SCRIPTS_MEMORY_MB', type: 'number', min: 16, doc: 'The most memory a script may use.' },

  // web
  { path: 'web.searchEngine', env: 'WEB_SEARCH_ENGINE', type: 'string', doc: 'Which search engine the web plugin uses (see plugins/README.md).' },
  { path: 'web.braveApiKey', env: 'BRAVE_API_KEY', type: 'secret', doc: 'For Brave Search.' },
  { path: 'web.searxngUrl', env: 'SEARXNG_URL', type: 'string', doc: 'Your SearXNG instance.' },
  { path: 'web.browserExecutable', env: 'BROWSER_EXECUTABLE', type: 'path', doc: "The browser the browser plugin drives. Unset: Chrome's usual place." },
  { path: 'web.browserHeadless', env: 'BROWSER_HEADLESS', type: 'boolean', doc: 'Run it without a window.' },
  { path: 'web.browserPort', env: 'BROWSER_PORT', type: 'number', min: 1, max: 65535, doc: "Its remote-debugging port." },

  // weather
  { path: 'weather.home', env: 'WEATHER_HOME', type: 'string', doc: 'Where you live, used when no place is named, e.g. "Ottawa, Ontario, Canada".' },
  { path: 'weather.units', env: 'WEATHER_UNITS', type: 'string', enum: ['celsius', 'fahrenheit'], doc: 'celsius (default) or fahrenheit.' },

  // phone
  { path: 'phone.enabled', env: 'PHONE', type: 'boolean', default: true, doc: 'The phone line on (when the SIP settings are there).' },
  { path: 'phone.sipServer', env: 'VOIPMS_SIP_SERVER', type: 'string', doc: 'The nearest VoIP.ms server, e.g. toronto.voip.ms.' },
  { path: 'phone.sipUser', env: 'VOIPMS_SIP_USER', type: 'string', doc: "Jarvis's VoIP.ms sub-account, e.g. 123456_jarvis." },
  { path: 'phone.sipPassword', env: 'VOIPMS_SIP_PASSWORD', type: 'secret', doc: "The sub-account's password." },
  { path: 'phone.did', env: 'VOIPMS_DID', type: 'string', doc: "Jarvis's phone number (10 digits)." },
  { path: 'phone.callerId', env: 'VOIPMS_CALLER_ID', type: 'string', doc: 'Caller ID on calls placed for you (your cell, verified at VoIP.ms). Empty: the DID.' },
  { path: 'phone.ownerCell', env: 'OWNER_CELL', type: 'string', doc: 'Your cell: where Marvin rings you.' },
  { path: 'phone.apiUser', env: 'VOIPMS_API_USER', type: 'string', doc: 'For texts: your VoIP.ms login email.' },
  { path: 'phone.apiPassword', env: 'VOIPMS_API_PASSWORD', type: 'secret', doc: 'For texts: the API password (not the login password).' },
  { path: 'phone.apiToken', env: 'VOIPMS_API_TOKEN', type: 'secret', doc: "The bearer token from VoIP.ms's API page." },
  { path: 'phone.assistantName', env: 'PHONE_ASSISTANT_NAME', type: 'string', default: 'Marvin', doc: 'What the assistant calls itself when it answers the phone.' },
  { path: 'phone.model', env: 'PHONE_MODEL', type: 'string', doc: 'The LLM Marvin talks with when it calls a business for you, as "connection/model" (llm.connections). Default: llm.default.' },
  { path: 'phone.speech', env: 'PHONE_SPEECH', type: 'string', doc: 'The text-to-speech model it speaks with on the phone, as "connection/model" (audio.connections). Default: audio.tts.' },
  { path: 'phone.voice', env: 'PHONE_VOICE', type: 'string', doc: 'Its voice on the phone (one the speech model has). Default: audio.ttsVoice.' },
  { path: 'phone.maxCallMinutes', env: 'PHONE_MAX_CALL_MINUTES', type: 'number', default: 120, min: 1, doc: 'The longest call.' },
  { path: 'phone.dailyMinutes', env: 'PHONE_DAILY_MINUTES', type: 'number', default: 180, min: 0, doc: 'Outgoing minutes a day, all calls together.' },
  { path: 'phone.dailyTexts', env: 'PHONE_DAILY_TEXTS', type: 'number', default: 50, min: 0, doc: 'Texts Jarvis may send a day.' },
  { path: 'phone.textPollSeconds', env: 'PHONE_TEXT_POLL_SECONDS', type: 'number', default: 30, min: 10, doc: 'How often to check for new texts.' },
  { path: 'phone.ringSeconds', env: 'PHONE_RING_SECONDS', type: 'number', default: 30, min: 5, doc: 'How long an incoming call rings your screens before Marvin answers.' },

  // telegram
  { path: 'telegram.enabled', env: 'TELEGRAM', type: 'boolean', default: true, doc: 'Chatting from Telegram on (when the bot token and chat are set; sending works regardless).' },
  { path: 'telegram.botToken', env: 'TELEGRAM_BOT_TOKEN', type: 'secret', doc: 'The bot token from @BotFather (a bot Jarvis alone uses).' },
  { path: 'telegram.ownerChatId', env: 'TELEGRAM_OWNER_CHAT_ID', type: 'string', doc: 'Your chat with the bot.' },
  { path: 'telegram.voiceReplies', env: 'TELEGRAM_VOICE_REPLIES', type: 'string', default: 'always', enum: ['always', 'voice', 'off'], doc: 'Replies as a voice note too: always, only to voice notes, or never.' },

  // email
  { path: 'email.imapHost', env: 'EMAIL_IMAP_HOST', type: 'string', doc: 'The IMAP server.' },
  { path: 'email.imapPort', env: 'EMAIL_IMAP_PORT', type: 'number', default: 993, min: 1, max: 65535, doc: 'Its port (993: TLS).' },
  { path: 'email.smtpHost', env: 'EMAIL_SMTP_HOST', type: 'string', doc: 'The SMTP server (default: the IMAP server).' },
  { path: 'email.smtpPort', env: 'EMAIL_SMTP_PORT', type: 'number', default: 465, min: 1, max: 65535, doc: 'Its port (465: TLS; 587: STARTTLS).' },
  { path: 'email.user', env: 'EMAIL_USER', type: 'string', doc: 'The login (usually the address).' },
  { path: 'email.password', env: 'EMAIL_PASSWORD', type: 'secret', doc: 'The password (an app password where the provider requires one).' },
  { path: 'email.address', env: 'EMAIL_ADDRESS', type: 'string', doc: 'The From address (default: the login).' },
  { path: 'email.fromName', env: 'EMAIL_FROM_NAME', type: 'string', doc: 'The name shown with it.' },
  { path: 'email.historyDays', env: 'EMAIL_HISTORY_DAYS', type: 'number', default: 30, min: 0, doc: 'How far back to save mail on the first start.' },

  // calendar
  { path: 'calendar.url', env: 'CALENDAR_URL', type: 'string', doc: 'The CalDAV server (the calendar is found from there).' },
  { path: 'calendar.user', env: 'CALENDAR_USER', type: 'string', doc: 'The login.' },
  { path: 'calendar.password', env: 'CALENDAR_PASSWORD', type: 'secret', doc: 'The password.' },
  { path: 'calendar.name', env: 'CALENDAR_NAME', type: 'string', doc: 'Which calendar, if the account has several (default: the first that holds events).' },
  { path: 'calendar.reminderMinutes', env: 'CALENDAR_REMINDER_MINUTES', type: 'number', default: 15, min: 0, doc: "Minutes before an event to remind you (unless it has its own reminder)." },
  { path: 'calendar.pollSeconds', env: 'CALENDAR_POLL_SECONDS', type: 'number', default: 120, min: 30, doc: 'How often to check the calendar for changes.' },
]
