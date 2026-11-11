// The Telegram Bot API (https://core.telegram.org/bots/api), the little of it
// Jarvis uses: sending to the owner's chat, and (for the server's Telegram
// channel) receiving with long polling. Plain HTTPS, no library.
//
// The token is part of every URL: it never goes into an error message or a log.

export class TelegramError extends Error {}

type Fetch = typeof fetch

/** Telegram's limit for one message. */
export const MAX_MESSAGE = 4096

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

export interface TelegramMessage {
  message_id: number
  date: number
  chat: { id: number; type: string }
  from?: { id: number; is_bot: boolean; first_name?: string }
  text?: string
  caption?: string
  /** Photos and files sent together (an album) arrive as one message each, sharing this. */
  media_group_id?: string
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number }
  audio?: TelegramFile & { duration: number }
  video?: TelegramFile & { duration: number }
  /** Sizes of the same photo, smallest first. */
  photo?: { file_id: string; width: number; height: number; file_size?: number }[]
  document?: TelegramFile
}

export interface TelegramFile {
  file_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

/** Telegram's limit for a file a bot downloads. */
export const MAX_DOWNLOAD = 20_000_000

export class Telegram {
  private readonly token: string
  private readonly fetch: Fetch

  constructor(token: string, fetchImpl: Fetch = fetch) {
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw new TelegramError("TELEGRAM_BOT_TOKEN doesn't look like a bot token (from @BotFather: 123456:ABC…).")
    this.token = token
    this.fetch = fetchImpl
  }

  /** Calls a Bot API method; throws TelegramError with Telegram's own description. */
  async call<T>(method: string, params: Record<string, unknown> | FormData = {}, signal?: AbortSignal): Promise<T> {
    const form = params instanceof FormData
    let response: Response
    try {
      response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        ...(form ? { body: params } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }),
        signal: signal ?? AbortSignal.timeout(method === 'getUpdates' ? 70_000 : 30_000),
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError' && signal?.aborted) throw err
      // The message from fetch never includes the URL, but be sure: no token in it.
      throw new TelegramError(`Couldn't reach Telegram: ${this.redact((err as Error).message)}`)
    }
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number }
    if (!body.ok) throw new TelegramError(`Telegram refused ${method}: ${this.redact(body.description ?? `HTTP ${response.status}`)}`)
    return body.result as T
  }

  private redact(s: string): string {
    return s.split(this.token).join('<token>')
  }

  /** Sends text, split into Telegram-sized parts (at line breaks or spaces). Returns how many parts. */
  async sendText(chatId: string, text: string, opts: { silent?: boolean } = {}): Promise<number> {
    const parts = splitMessage(text)
    for (const part of parts) await this.call('sendMessage', { chat_id: chatId, text: part, disable_notification: opts.silent === true, link_preview_options: { is_disabled: true } })
    return parts.length
  }

  /** Sends a file (a photo is shown as one; anything else as a document). */
  async sendFile(chatId: string, name: string, data: Uint8Array, caption = ''): Promise<void> {
    const photo = /\.(jpe?g|png|webp)$/i.test(name) && data.length < 10_000_000
    const form = new FormData()
    form.set('chat_id', chatId)
    if (caption) form.set('caption', caption.slice(0, 1024))
    form.set(photo ? 'photo' : 'document', new Blob([new Uint8Array(data)]), name)
    await this.call(photo ? 'sendPhoto' : 'sendDocument', form)
  }

  /** A voice note (Ogg Opus), played in the chat like one the owner recorded. */
  async sendVoice(chatId: string, ogg: Uint8Array, opts: { durationS?: number; caption?: string } = {}): Promise<void> {
    const form = new FormData()
    form.set('chat_id', chatId)
    if (opts.durationS) form.set('duration', String(Math.round(opts.durationS)))
    if (opts.caption) form.set('caption', opts.caption.slice(0, 1024))
    form.set('voice', new Blob([new Uint8Array(ogg)], { type: 'audio/ogg' }), 'reply.ogg')
    await this.call('sendVoice', form)
  }

  /** "typing…" (or "recording a voice message…") in the chat for a few seconds. */
  async typing(chatId: string, action: 'typing' | 'record_voice' | 'upload_voice' = 'typing'): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action }).catch(() => {})
  }

  /** New messages since `offset` (long polling: waits up to `timeoutS` for one). */
  updates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: timeoutS, allowed_updates: ['message'] }, signal)
  }

  /** Downloads a file someone sent (a voice note, a photo). */
  async download(fileId: string, maxBytes = MAX_DOWNLOAD): Promise<{ data: Uint8Array; path: string }> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId })
    if (!file.file_path) throw new TelegramError('Telegram has no copy of that file (too big, over 20 MB?).')
    if (file.file_size && file.file_size > maxBytes) throw new TelegramError('That file is too big.')
    let response: Response
    try {
      response = await this.fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) })
    } catch (err) {
      throw new TelegramError(`Couldn't download from Telegram: ${this.redact((err as Error).message)}`)
    }
    if (!response.ok) throw new TelegramError(`Couldn't download from Telegram (HTTP ${response.status}).`)
    return { data: new Uint8Array(await response.arrayBuffer()), path: file.file_path }
  }
}

/** Cuts text into parts of at most MAX_MESSAGE characters, at a line break or space when there's one near the end. */
export function splitMessage(text: string, max = MAX_MESSAGE): string[] {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = window.lastIndexOf('\n')
    if (cut < max / 2) cut = window.lastIndexOf(' ')
    if (cut < max / 2) cut = max
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}
