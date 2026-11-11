// The Telegram channel (docs/telegram.md): the owner chats with Jarvis from
// Telegram, anywhere. Their messages (text, or voice notes transcribed) go
// into the active session like something typed on a Jarvis screen; photos and
// files are saved in the workspace like ones dropped on a screen, their caption
// saying what to do. The LLM answers with the owner's tools, and the reply goes
// back to Telegram as text and as a voice note in Jarvis's voice.
//
// Only the owner's chat (TELEGRAM_OWNER_CHAT_ID) is listened to: Telegram's
// user ids can't be faked, so a message from it is the owner (it also counts
// as their "yes" for calls and texts). Everyone else is ignored, unanswered.
//
// Sending on its own (reminders, files) is the telegram plugin
// (plugins/telegram); this reads the bot's messages, which only one
// program can do at a time.

import fs from 'node:fs'
import path from 'node:path'
import { OggOpusDecoder } from 'ogg-opus-decoder'
import { Readable } from 'node:stream'
import { MAX_DOWNLOAD, type TelegramMessage, Telegram, TelegramError } from '../../../../plugins/telegram/telegram.ts'
import { type AgentLibrary, toolAllowed } from '../agents/library.ts'
import { systemPrompt } from '../assistant/assistant.ts'
import { type ChatMessage, chatTarget, streamChat } from '../assistant/llm.ts'
import { spokenSentences, synthesize } from '../assistant/speech.ts'
import { encodeOggOpus } from '../archive/oggOpus.ts'
import { saveUpload } from '../files/workspaceFiles.ts'
import { wavToPcm16k } from '../phone/voice.ts'
import type { FileRef } from '../sessions/format.ts'
import { transcribePcm } from '../audiocpp.ts'
import { config } from '../config.ts'
import { harness, type LoopResult } from '../harness/index.ts'
import { livePhoneTools } from '../phone/index.ts'
import { liveScheduleTools, notifier } from '../schedule/index.ts'
import { liveServiceTools } from '../services/index.ts'
import { historyMessages, toolUses } from '../sessions/history.ts'
import type { SessionStore } from '../sessions/store.ts'
import type { SkillLibrary } from '../skills/library.ts'

/** Messages in the LLM's history (as for a live reply). */
const HISTORY_MAX = 24
/** Older than this when Jarvis gets them (it was off): not answered, just said so. */
const STALE_MS = 60 * 60_000
/** The longest voice note transcribed. */
const MAX_VOICE_S = 300
const POLL_S = 50
/** The most of a reply read out as a voice note (about 2 minutes); the text has all of it. */
const MAX_SPOKEN_CHARS = 1800

export interface TelegramDeps {
  agents: AgentLibrary
  skills: SkillLibrary
  sessions: SessionStore
  log: (message: string, err?: unknown) => void
  /** Overrides for tests. */
  bot?: Telegram
  turn?: (signal: AbortSignal) => Promise<LoopResult>
  transcribe?: (pcm: Int16Array) => Promise<string>
  synthesize?: (text: string) => Promise<Buffer>
  stateFile?: string
  workspaceDir?: string
  voiceReplies?: VoiceReplies
  /** How long to wait for the rest of an album (ms). */
  albumWaitMs?: number
}

export type VoiceReplies = 'always' | 'voice' | 'off'

interface Attachment {
  fileId: string
  name: string
  type: string
  size?: number
}

/** The photo (its largest size) or file a message carries, if any. */
export function attachmentsOf(m: TelegramMessage): Attachment[] {
  const stamp = new Date(m.date * 1000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  if (m.photo?.length) {
    const best = m.photo.at(-1)!
    return [{ fileId: best.file_id, name: `photo-${stamp}-${m.message_id}.jpg`, type: 'image/jpeg', size: best.file_size }]
  }
  const f = m.document ?? m.video ?? m.audio
  if (!f) return []
  const kind = m.document ? 'file' : m.video ? 'video' : 'audio'
  const ext = f.mime_type ? `.${(f.mime_type.split('/')[1] ?? 'bin').replace(/^x-/, '').replace('quicktime', 'mov').replace('mpeg', m.audio ? 'mp3' : 'mpeg')}` : ''
  return [{ fileId: f.file_id, name: f.file_name || `${kind}-${stamp}-${m.message_id}${ext}`, type: f.mime_type ?? '', size: f.file_size }]
}

export class TelegramChannel {
  private readonly d: TelegramDeps
  private readonly bot: Telegram
  private readonly chatId: string
  private readonly stateFile: string
  private offset = 0
  private abort = new AbortController()
  private stopped = false
  private queue: Promise<void> = Promise.resolve()
  private loop: Promise<void> | null = null
  private readonly albums = new Map<string, { messages: TelegramMessage[] }>()
  private readonly albumWaitMs: number
  private readonly workspaceDir: string

  constructor(token: string, chatId: string, deps: TelegramDeps) {
    this.d = deps
    this.bot = deps.bot ?? new Telegram(token)
    this.chatId = chatId
    this.stateFile = deps.stateFile ?? path.join(config.dataDir, 'telegram.json')
    this.workspaceDir = deps.workspaceDir ?? config.workspaceDir
    this.albumWaitMs = deps.albumWaitMs ?? 1500
    try {
      this.offset = Number((JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { offset?: number }).offset) || 0
    } catch {
      // first start
    }
  }

  start(): void {
    this.loop ??= this.poll()
  }

  /** Resolves once every message received so far has been answered. */
  settled(): Promise<void> {
    return this.queue
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    await this.loop?.catch(() => {})
    await this.queue.catch(() => {})
  }

  /** Long polling: one request waits up to 50 s for a message. */
  private async poll(): Promise<void> {
    let backoff = 5
    while (!this.stopped) {
      try {
        const updates = await this.bot.updates(this.offset, POLL_S, this.abort.signal)
        backoff = 5
        for (const u of updates) {
          this.offset = u.update_id + 1
          if (u.message) this.receive(u.message)
        }
        if (updates.length) this.saveOffset()
      } catch (err) {
        if (this.stopped) return
        const message = (err as Error).message
        // 409: another program reads this bot's messages (one reader per bot).
        if (/terminated by other getUpdates|Conflict/i.test(message)) this.d.log('telegram: another program is reading this bot\'s messages (only one can): stop it, or give Jarvis its own bot')
        else this.d.log(`telegram: ${message}`)
        await new Promise((r) => setTimeout(r, backoff * 1000))
        backoff = Math.min(backoff * 2, 300)
      }
    }
  }

  private saveOffset(): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
      fs.writeFileSync(this.stateFile, JSON.stringify({ offset: this.offset }))
    } catch (err) {
      this.d.log('telegram: could not save where it got to', err)
    }
  }

  /** A message arrived: the owner's are handled in order; anyone else's are ignored. */
  receive(msg: TelegramMessage): void {
    if (String(msg.chat.id) !== this.chatId || String(msg.from?.id ?? '') !== this.chatId || msg.chat.type !== 'private') {
      this.d.log(`telegram: ignored a message from chat ${msg.chat.id} (not the owner's)`)
      return
    }
    // An album (several photos or files sent together) arrives as one message each: gathered, then handled as one.
    if (msg.media_group_id) {
      const group = this.albums.get(msg.media_group_id)
      if (group) {
        group.messages.push(msg)
        return
      }
      const messages = [msg]
      this.albums.set(msg.media_group_id, { messages })
      // Its place in line is taken now, so a message sent after the album is answered after it.
      const complete = new Promise<void>((resolve) =>
        setTimeout(() => {
          this.albums.delete(msg.media_group_id!)
          resolve()
        }, this.albumWaitMs),
      )
      this.enqueue(messages, complete)
      return
    }
    this.enqueue([msg])
  }

  private enqueue(messages: TelegramMessage[], ready: Promise<void> = Promise.resolve()): void {
    this.queue = this.queue
      .then(() => ready)
      .then(() => this.handle(messages))
      .catch((err) => this.d.log('telegram: handling a message failed', err))
  }

  private async handle(messages: TelegramMessage[]): Promise<void> {
    const msg = messages[0]!
    const at = new Date(msg.date * 1000)
    const caption = (messages.find((m) => m.caption?.trim())?.caption ?? '').trim()
    if (Date.now() - at.getTime() > STALE_MS) {
      const what = (msg.text ?? caption).slice(0, 60)
      await this.reply(`I was off when you sent ${what ? `"${what}${what.length === 60 ? '…' : ''}"` : 'that'}: send it again if you still need it.`)
      return
    }
    const command = msg.text?.trim().toLowerCase()
    if (command === '/start') return void (await this.reply(`Hi${config.ownerName ? ` ${config.ownerName.split(/\s+/)[0]}` : ''}, it's Jarvis. Write, send a voice note, or send photos and files with a line saying what to do with them, as you'd ask me at home.`))
    if (command === '/new') {
      this.d.sessions.startNew()
      return void (await this.reply('New conversation started.'))
    }

    // Photos and files: saved in the workspace like files dropped on a Jarvis screen; the caption says what to do.
    const attachments = messages.flatMap((m) => attachmentsOf(m))
    if (attachments.length) return this.handleFiles(attachments, caption, at)

    let text = (msg.text ?? '').trim()
    let heard = ''
    if (!text && msg.voice) {
      if (msg.voice.duration > MAX_VOICE_S) return void (await this.reply(`That voice note is too long for me (${MAX_VOICE_S / 60} minutes at most).`))
      try {
        heard = await this.transcribeVoice(msg.voice.file_id)
      } catch (err) {
        this.d.log('telegram: transcribing a voice note failed', err)
        return void (await this.reply("I couldn't make out that voice note (is audio.cpp running?). Could you type it?"))
      }
      if (!heard) return void (await this.reply("I couldn't make out any words in that voice note."))
      text = heard
    }
    if (!text) return void (await this.reply("I can't read that kind of message: send text, a voice note, or photos and files."))

    // From the owner (their Telegram id): their words, and their "yes" for anything waiting on one.
    notifier.heard()
    this.d.sessions.record({ kind: 'owner', at: at.toISOString(), text })
    await this.answer(heard ? `🎙 “${heard}”\n\n` : '', Boolean(heard))
  }

  /** Saves what was sent into uploads/ and, with a caption, answers it; without one, asks what to do. */
  private async handleFiles(attachments: Attachment[], caption: string, at: Date): Promise<void> {
    const saved: FileRef[] = []
    const problems: string[] = []
    void this.bot.typing(this.chatId)
    for (const a of attachments) {
      if (a.size && a.size > MAX_DOWNLOAD) {
        problems.push(`${a.name} is too big for a bot to download (Telegram allows ${MAX_DOWNLOAD / 1e6} MB)`)
        continue
      }
      try {
        const { data } = await this.bot.download(a.fileId)
        saved.push(await saveUpload(this.workspaceDir, Readable.from(Buffer.from(data)), a.name, a.type, at))
      } catch (err) {
        problems.push(`${a.name}: ${(err as Error).message}`)
      }
    }
    const trouble = problems.length ? `Couldn't save ${problems.join('; ')}.` : ''
    if (!saved.length) return void (await this.reply(trouble || "I couldn't save that."))
    notifier.heard()
    this.d.sessions.record({ kind: 'files', at: at.toISOString(), text: caption, files: saved })
    const list = saved.map((f) => f.path).join(', ')
    if (!caption) {
      // Nothing to do yet: the next message says what (the files are in the conversation for it).
      return void (await this.reply(`Got ${saved.length === 1 ? 'it' : `all ${saved.length}`}: saved in ${list}. What should I do with ${saved.length === 1 ? 'it' : 'them'}?${trouble ? `\n${trouble}` : ''}`))
    }
    await this.answer(trouble ? `${trouble}\n\n` : '', false)
  }

  /** The LLM's turn on what's now last in the session; the reply goes back as text, and as a voice note. */
  private async answer(prefix: string, sentVoice: boolean): Promise<void> {
    const typing = setInterval(() => void this.bot.typing(this.chatId), 4500)
    void this.bot.typing(this.chatId)
    let result: LoopResult
    try {
      result = await (this.d.turn ?? ((s) => this.turn(s)))(this.abort.signal)
    } catch (err) {
      if (this.stopped) return
      this.d.log('telegram: the reply failed', err)
      await this.reply(`Sorry, something went wrong: ${(err as Error).message}`)
      return
    } finally {
      clearInterval(typing)
    }
    const answer = result.text.replace(/<\/?think>/g, '').trim()
    const tools = toolUses(result.steps)
    this.d.sessions.record({ kind: 'jarvis', at: new Date().toISOString(), text: answer, ...(tools.length ? { tools } : {}) })
    if (answer || prefix) await this.reply(prefix + (answer || '(no reply)'))
    const mode = this.d.voiceReplies ?? config.telegram.voiceReplies
    if (answer && (mode === 'always' || (mode === 'voice' && sentVoice))) await this.replyVoice(answer)
  }

  private async reply(text: string): Promise<void> {
    try {
      await this.bot.sendText(this.chatId, text)
    } catch (err) {
      this.d.log(`telegram: couldn't send the reply: ${err instanceof TelegramError ? err.message : String(err)}`)
    }
  }

  /** The reply spoken in Jarvis's voice (the session agent's), as a voice note after the text. */
  private async replyVoice(text: string): Promise<void> {
    const sentences = spokenSentences(text)
    let chars = 0
    const said = sentences.filter((s) => (chars += s.length) <= MAX_SPOKEN_CHARS)
    if (!said.length) return
    const recording = setInterval(() => void this.bot.typing(this.chatId, 'record_voice'), 4500)
    void this.bot.typing(this.chatId, 'record_voice')
    try {
      const voice = this.d.agents.get(this.d.sessions.agentId() || undefined).voice ?? config.ttsVoice
      const speak = this.d.synthesize ?? ((t: string) => synthesize(t, this.abort.signal, voice))
      const pieces: Int16Array[] = []
      for (const sentence of said) pieces.push(wavToPcm16k(await speak(sentence)))
      const total = pieces.reduce((n, p) => n + p.length, 0)
      const pcm = new Int16Array(total)
      let at = 0
      for (const p of pieces) {
        pcm.set(p, at)
        at += p.length
      }
      const ogg = await encodeOggOpus(pcm, { TITLE: 'Jarvis' })
      await this.bot.sendVoice(this.chatId, ogg, { durationS: total / 16000, ...(said.length < sentences.length ? { caption: '(the start of the reply; the rest is in the text)' } : {}) })
    } catch (err) {
      if (!this.stopped) this.d.log(`telegram: couldn't send the voice reply: ${(err as Error).message}`)
    } finally {
      clearInterval(recording)
    }
  }

  private async transcribeVoice(fileId: string): Promise<string> {
    const { data } = await this.bot.download(fileId)
    const decoder = new OggOpusDecoder()
    await decoder.ready
    try {
      const decoded = await decoder.decodeFile(data)
      const ch = decoded.channelData[0]!
      // 48 kHz → 16 kHz: every third sample, averaged (a light low-pass).
      const pcm = new Int16Array(Math.floor(ch.length / 3))
      for (let i = 0; i < pcm.length; i++) {
        const v = (ch[i * 3]! + ch[i * 3 + 1]! + ch[i * 3 + 2]!) / 3
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)))
      }
      const transcribe = this.d.transcribe ?? ((p: Int16Array) => transcribePcm(Buffer.from(p.buffer, p.byteOffset, p.byteLength), 16000, ''))
      return (await transcribe(pcm)).trim()
    } finally {
      decoder.free()
    }
  }

  /** One turn of the LLM, as for a live reply, with the conversation so far (the owner's message is its last entry) and the owner's tools. */
  private async turn(signal: AbortSignal): Promise<LoopResult> {
    const { agents, skills, sessions } = this.d
    const owner = config.ownerName || 'the owner'
    const agent = agents.get(sessions.agentId() || undefined)
    const rules = [
      `${owner}'s latest message came from Telegram, on their phone: they may not be at home or near a Jarvis screen.`,
      'Your reply is sent back to them on Telegram as plain text: no Markdown (no **, #, tables or code fences); short paragraphs and simple "- " lists are fine; links as plain URLs. It may also be read out to them as a voice note, so write it to read well aloud too.',
      'Photos and files they send from Telegram are saved in the workspace (uploads/) and come with their note saying what to do with them: do that with your file tools.',
      "Don't send it again with telegram__send_message: your reply is the message. To send them a file, use telegram__send_file. Nothing can be shown on a Jarvis screen for them to see right now.",
    ].join('\n')
    const system = systemPrompt(agent, agents, skills, [['Telegram', rules]])
    const messages = [system, ...historyMessages(sessions.entries(), HISTORY_MAX)]
    const target = chatTarget()
    const allow = (name: string) => toolAllowed(agent, name)
    const builtins = [...liveScheduleTools(), ...liveServiceTools(), ...livePhoneTools()]
    if (!harness.status().length) {
      const plain = messages.filter((m): m is ChatMessage => m.role !== 'tool' && typeof m.content === 'string')
      return { text: await streamChat(target, plain, () => {}, signal), steps: [] }
    }
    return harness.run(target, messages, () => {}, signal, undefined, allow, builtins)
  }
}

let channel: TelegramChannel | null = null

export function startTelegram(deps: Omit<TelegramDeps, 'bot' | 'turn' | 'transcribe' | 'stateFile'>): void {
  const { token, ownerChatId, enabled } = config.telegram
  if (channel || !enabled) return
  try {
    channel = new TelegramChannel(token, ownerChatId, deps)
  } catch (err) {
    deps.log(`telegram: not started: ${(err as Error).message}`)
    return
  }
  channel.start()
  deps.log('telegram: listening for the owner\'s messages')
}

export async function stopTelegram(): Promise<void> {
  await channel?.stop()
  channel = null
}
