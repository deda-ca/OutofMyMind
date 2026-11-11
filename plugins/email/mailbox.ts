// The owner's mailbox on the server (docs/email.md): IMAP to read and watch
// (IDLE: the server says the moment mail lands; a full check every 15
// minutes in case it didn't), SMTP to send, and the Sent folder kept in step.
//
// One IMAP connection, reconnected with back-off. Mail is never deleted or
// moved on the server; the only change ever made there is the "read" flag,
// when the owner marks a message read in the Email tab, and a copy of what
// Jarvis sends in Sent.

import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { log } from '../kit/plugin.ts'

export interface MailSettings {
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  user: string
  password: string
  /** The From address (default: the user name). */
  address: string
  /** The name shown with it. */
  fromName: string
}

export interface Fetched {
  uid: number
  uidValidity: string
  raw: Buffer
  seen: boolean
  internalDate?: Date
}

export interface Outgoing {
  to: string[]
  cc: string[]
  subject: string
  text: string
  inReplyTo?: string
  references?: string[]
}

const RECHECK_MS = 15 * 60_000

export class Mailbox {
  private readonly s: MailSettings
  private client: ImapFlow | null = null
  private stopped = false
  private backoff = 5
  private recheck: ReturnType<typeof setInterval> | null = null
  /** One command sequence at a time on the connection. */
  private lock: Promise<unknown> = Promise.resolve()
  state: 'off' | 'connecting' | 'watching' | 'failed' = 'off'
  detail = ''
  sentFolder = ''

  constructor(settings: MailSettings) {
    this.s = settings
  }

  /**
   * Connects and watches the inbox. `onNew` is called (one at a time) with the
   * uids above `lastUid()` whenever mail may have arrived; it fetches them with fetch().
   */
  start(onWake: () => Promise<void>): void {
    this.stopped = false
    void this.connectLoop(onWake)
    this.recheck = setInterval(() => void this.serial(onWake), RECHECK_MS)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.recheck) clearInterval(this.recheck)
    await this.client?.logout().catch(() => {})
    this.client = null
    this.state = 'off'
  }

  private async connectLoop(onWake: () => Promise<void>): Promise<void> {
    while (!this.stopped) {
      this.state = 'connecting'
      const client = new ImapFlow({
        host: this.s.imapHost,
        port: this.s.imapPort,
        secure: this.s.imapPort === 993,
        auth: { user: this.s.user, pass: this.s.password },
        logger: false,
        // IDLE whenever nothing else is going on: the server then says when mail arrives.
        maxIdleTime: 10 * 60_000,
      })
      const closed = new Promise<void>((resolve) => {
        client.on('close', () => resolve())
        client.on('error', (err: Error) => {
          this.detail = err.message
          log(`email: IMAP error: ${err.message}`)
        })
      })
      try {
        await client.connect()
        const boxes = await client.list()
        this.sentFolder = boxes.find((b) => b.specialUse === '\\Sent')?.path ?? boxes.find((b) => /(^|\.|\/)sent$/i.test(b.path))?.path ?? ''
        await client.mailboxOpen('INBOX')
        this.client = client
        this.state = 'watching'
        this.detail = ''
        this.backoff = 5
        client.on('exists', () => void this.serial(onWake))
        await this.serial(onWake)
        await closed
      } catch (err) {
        this.detail = (err as Error).message
        log(`email: couldn't connect to ${this.s.imapHost}: ${this.detail}`)
        await client.logout().catch(() => {})
      }
      this.client = null
      if (this.stopped) return
      this.state = 'failed'
      await new Promise((r) => setTimeout(r, this.backoff * 1000))
      this.backoff = Math.min(this.backoff * 2, 600)
    }
  }

  /** Runs `job` with the connection to itself (commands can't overlap). */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.lock.then(job, job)
    this.lock = next.catch((err: Error) => log(`email: ${err.message}`))
    return next
  }

  /** The inbox's UIDVALIDITY (changes if the server renumbered everything). */
  uidValidity(): string {
    const v = this.client?.mailbox && typeof this.client.mailbox === 'object' ? this.client.mailbox.uidValidity : undefined
    return v === undefined ? '' : String(v)
  }

  /** Uids in the inbox above `after`, or (on the first run) received since `since`. */
  async newUids(after: number, since: Date): Promise<number[]> {
    const c = this.client
    if (!c) return []
    const found = after > 0 ? await c.search({ uid: `${after + 1}:*` }, { uid: true }) : await c.search({ since }, { uid: true })
    // "n:*" always matches the last message, even below n.
    return (found || []).filter((u) => u > after).sort((a, b) => a - b)
  }

  /** The messages, in full. */
  async fetch(uids: number[]): Promise<Fetched[]> {
    const c = this.client
    if (!c || !uids.length) return []
    const out: Fetched[] = []
    const validity = this.uidValidity()
    for await (const m of c.fetch(uids.join(','), { uid: true, source: true, flags: true, internalDate: true }, { uid: true })) {
      if (!m.source) continue
      out.push({ uid: m.uid, uidValidity: validity, raw: m.source, seen: m.flags?.has('\\Seen') ?? false, internalDate: m.internalDate instanceof Date ? m.internalDate : undefined })
    }
    return out
  }

  /** Marks a message read or unread on the server (the owner's choice, from the tab). */
  setSeen(uid: number, seen: boolean): Promise<void> {
    return this.serial(async () => {
      const c = this.client
      if (!c) throw new Error("The mailbox isn't connected right now.")
      if (seen) await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
      else await c.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true })
    })
  }

  /** Sends through SMTP; then a copy goes to the Sent folder. Returns the raw message sent and its Message-ID. */
  async send(mail: Outgoing): Promise<{ raw: Buffer; messageId: string }> {
    const from = this.s.fromName ? { name: this.s.fromName, address: this.s.address } : this.s.address
    const message = {
      from,
      to: mail.to,
      cc: mail.cc.length ? mail.cc : undefined,
      subject: mail.subject,
      text: mail.text,
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: [...(mail.references ?? []), mail.inReplyTo].join(' ') } : {}),
      headers: { 'X-Mailer': 'Jarvis' },
    }
    const raw = await new MailComposer(message).compile().build()
    const messageId = /^Message-ID:\s*(<[^>]+>)/im.exec(raw.toString('utf8', 0, Math.min(raw.length, 8000)))?.[1] ?? ''
    const transport = nodemailer.createTransport({
      host: this.s.smtpHost,
      port: this.s.smtpPort,
      secure: this.s.smtpPort === 465,
      auth: { user: this.s.user, pass: this.s.password },
      connectionTimeout: 20_000,
    })
    await transport.sendMail({ envelope: { from: this.s.address, to: [...mail.to, ...mail.cc] }, raw })
    transport.close()
    if (this.sentFolder) {
      await this.serial(async () => {
        await this.client?.append(this.sentFolder, raw, ['\\Seen'])
      }).catch((err: Error) => log(`email: sent, but couldn't put a copy in ${this.sentFolder}: ${err.message}`))
    }
    return { raw, messageId }
  }

  /** Runs a job with the connection to itself (exposed for the watcher's fetches). */
  run<T>(job: () => Promise<T>): Promise<T> {
    return this.serial(job)
  }
}
