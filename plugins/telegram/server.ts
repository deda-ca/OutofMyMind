// The Telegram plugin: Jarvis sends the owner a message or a file on Telegram,
// through the owner's own bot. Only ever to the owner's chat
// (TELEGRAM_OWNER_CHAT_ID): nothing in a page, an email or a call can make it
// message anyone else. Files only from the workspace.
//
// Receiving (the owner chatting with Jarvis from Telegram) is the server's
// Telegram channel (apps/server/src/telegram), not this plugin: a bot has one
// reader of its messages.
//
// ⚠️ Needs the internet: messages go through Telegram's servers.

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { createPlugin, failure, serve, text } from '../kit/plugin.ts'
import { Telegram, TelegramError } from './telegram.ts'

const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''
const chatId = process.env.TELEGRAM_OWNER_CHAT_ID?.trim() ?? ''
const workspace = process.env.WORKSPACE_DIR?.trim() ?? ''
const MAX_FILE = 50_000_000

let bot: Telegram | null = null
let setupError = ''
try {
  if (!token || !chatId) throw new TelegramError('Telegram isn\'t set up: telegram.botToken and telegram.ownerChatId go in apps/server/config.jsonc (docs/telegram.md).')
  bot = new Telegram(token)
} catch (err) {
  setupError = (err as Error).message
}

const plugin = createPlugin('telegram', '0.1.0', "Send the owner a message or a file on Telegram (their phone), through their own bot. Only to the owner: there's no way to message anyone else.")

plugin.registerTool(
  'send_message',
  {
    description:
      "Send the owner a Telegram message (it arrives on their phone). Use it when they ask to be told by Telegram, or for a reminder or something urgent when they're away from their Jarvis screen. " +
      'Plain text (no Markdown); long texts are split. Only ever to the owner.',
    inputSchema: {
      text: z.string().min(1).describe('The message.'),
      silent: z.boolean().optional().describe('Deliver without a sound (default false).'),
    },
    annotations: { openWorldHint: true },
  },
  async ({ text: message, silent }) => {
    if (!bot) return failure(setupError)
    try {
      const parts = await bot.sendText(chatId, message, { silent })
      return text(parts > 1 ? `Sent to the owner on Telegram (in ${parts} parts).` : 'Sent to the owner on Telegram.')
    } catch (err) {
      if (err instanceof TelegramError) return failure(err.message)
      throw err
    }
  },
)

plugin.registerTool(
  'send_file',
  {
    description: "Send the owner a file from the workspace on Telegram: an image is shown as a photo, anything else as a document. Up to 50 MB. Only ever to the owner.",
    inputSchema: {
      path: z.string().min(1).describe('The file, inside the workspace: a full path, or relative to it (e.g. scripts/out/chart.png).'),
      caption: z.string().optional().describe('A line to go with it.'),
    },
    annotations: { openWorldHint: true },
  },
  async ({ path: asked, caption }) => {
    if (!bot) return failure(setupError)
    if (!workspace) return failure("The workspace isn't known (WORKSPACE_DIR): can't send files.")
    try {
      const root = fs.realpathSync(workspace)
      const file = fs.realpathSync(path.resolve(root, asked))
      if (file !== root && !file.startsWith(root + path.sep)) return failure(`Only files inside the workspace can be sent: ${asked}`)
      const stat = fs.statSync(file)
      if (!stat.isFile()) return failure(`Not a file: ${asked}`)
      if (stat.size > MAX_FILE) return failure(`Too big for Telegram (${Math.round(stat.size / 1e6)} MB; 50 MB at most).`)
      await bot.sendFile(chatId, path.basename(file), fs.readFileSync(file), caption ?? '')
      return text(`Sent ${path.relative(root, file)} to the owner on Telegram.`)
    } catch (err) {
      if (err instanceof TelegramError) return failure(err.message)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return failure(`No such file: ${asked}`)
      throw err
    }
  },
)

await serve(plugin)
