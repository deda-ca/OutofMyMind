# Telegram: Jarvis on the owner's phone

Status: built 2026-11-11. Sending tested with a real message and a real voice-note reply to the owner's chat; the channel tested with a fake Telegram (the owner's messages, strangers, commands, order), a real voice note (text-to-speech encoded as Ogg Opus, decoded and transcribed), and a real LLM turn (it used the weather tool and replied in plain text). Not yet tried by the owner from their phone.

## What it does

Two parts, both through the owner's own Telegram bot:

| | What | Where |
| --- | --- | --- |
| **Sending** | Jarvis sends the owner a message or a file: when they ask ("send me that by Telegram"), from a schedule ("remind me by Telegram"), or from a service. | The `telegram` MCP plugin: `telegram__send_message`, `telegram__send_file` ([mcp-plugins/telegram](../mcp-plugins/telegram/server.ts)) |
| **Chatting** | The owner writes to the bot, sends a voice note, or sends photos and files with a line saying what to do with them, from anywhere; Jarvis answers there, as text and as a voice note, in the same conversation as at home. | The server's Telegram channel ([apps/server/src/telegram](../apps/server/src/telegram/index.ts)) |

They're split because a bot's messages can be read by one program only (Telegram's `getUpdates`; a second reader gets "409 Conflict"), while anything can send.

## Who it talks to

- **Only the owner.** The plugin sends only to `TELEGRAM_OWNER_CHAT_ID`: nothing in a web page, an email or a phone call can make Jarvis message anyone else. The channel answers only the owner's private chat (both the chat and the sender must be that id); anyone else is ignored without a reply, and logged.
- **Telegram's user id can't be faked** (unlike caller ID), so a message from the owner's chat is the owner: it goes into the session as theirs, and counts as their "yes" for calls and texts waiting on one (the phone's two-step confirmation).
- The bot token is part of every API address: it never goes into an error message or a log.

## The channel

- Long polling (`getUpdates`, 50 s): no public address or webhook needed. Where it got to is kept in `DATA_DIR/telegram.json`, so a restart doesn't answer messages twice.
- A message from the owner: recorded in the active session as the owner's, answered by the LLM with the conversation so far (the last 24 messages), the owner's plugins (by the session's agent) and Jarvis's live tools (schedules, services, the phone), and the reply recorded and sent back. "typing…" shows meanwhile. Messages are answered one at a time, in order.
- The LLM is told the message came from Telegram: reply in plain text (no Markdown), don't also send it with `telegram__send_message`, nothing can be shown on a Jarvis screen.
- **Voice notes** (5 minutes at most): downloaded, decoded (Ogg Opus, 48 → 16 kHz), transcribed with the same speech recognition as at home (audio.cpp), then answered like text; the reply starts with what was heard (🎙 "…").
- **Photos and files** (documents, videos, audio files; an album as one message): saved in the workspace's `uploads/<date>/` and added to the conversation like files dropped on a Jarvis screen (a "files" message). **The caption is the instruction** ("file this under receipts", "send this to my notes"): Jarvis does it with its file tools. Without a caption Jarvis says where it saved them and asks what to do; the next message says. A photo is downloaded at its largest size. Bots can download 20 MB at most (Telegram's limit): bigger files are refused with that reason. **With `LLM_VISION=on`** (a model that sees: llama.cpp with its `--mmproj` image projector) Jarvis sees the photos too, here and on a screen: "What do you see?" on a photo of a can was answered in 3 s ("a 355 mL can of Canada Dry Zero Sugar Tonic Water…"). The latest 3 images in the conversation are sent with each request; older ones are just named (ask again to have one looked at). Without it, Jarvis files, moves and sends images but can't say what's in them.
- **Voice-note replies**: every reply is sent as text, then spoken in Jarvis's voice (the session agent's) and sent as a voice note ("recording a voice message…" shows meanwhile); about 2 minutes at most (the text has the rest). `TELEGRAM_VOICE_REPLIES=voice` replies by voice only to voice notes; `off`, text only. A 13-second reply took 3.8 s to make and send.
- Messages more than an hour old when Jarvis gets them (it was off): not acted on; Jarvis says it was off and asks to send it again.
- `/start`: a greeting. `/new`: a new conversation (like "Jarvis, new session").

## Settings

In `apps/server/.env.local` (git ignores it):

```bash
TELEGRAM_BOT_TOKEN='123456:ABC…'   # from @BotFather; Jarvis's alone (one reader of its messages)
TELEGRAM_OWNER_CHAT_ID=123456789   # the owner's chat with the bot (send it /start, then read getUpdates)
TELEGRAM=off                       # optional: no channel (the plugin still sends)
TELEGRAM_VOICE_REPLIES=always      # optional: voice-note replies always (default), only to voice notes (voice), or never (off)
```

The channel starts with the server when both are set. The bot's display name and picture are changed with @BotFather (`/setname`, `/setuserpic`); its username can't be.

## Not yet

- Looking at an image already in the workspace that wasn't sent in the conversation ("what's in receipts/may.jpg?"): a tool that shows it to the model.
- Shrinking big photos before sending them to the model (Telegram's are already at most 1280 px; a camera original from a screen can cost thousands of tokens).
- Replies with formatting (Telegram's HTML), and long replies as a file.
- Messages the owner sends while a reply is being written aren't merged into it (they're answered next).
