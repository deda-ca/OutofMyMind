# Email: the owner's inbox as a plugin (design)

Status: **built 2026-11-11**, the first plugin on the plugin platform ([plugins.md](plugins.md)), watching the inbox Hermes used. Tested for real: the first sync saved 100 emails, 59 addresses and 13 attachments in 2 s; a test email sent to the inbox itself went out by SMTP in 0.4 s (a copy in Sent), arrived by IDLE and was saved 0.9 s after sending, and its `email.received` event ran the triage turn; the Email tab worked in Chrome under its CSP; the release binary runs it. Not tried yet from the owner's own screens (the dev server needs a restart).

## The idea

Jarvis watches the owner's inbox, keeps a **local, parsed copy** of every email, decides what needs their attention (and tells them, on screen or by Telegram when they're away), and can **search, read, draft and send** for them. The local copy can be browsed in an **Email tab**, tagged, and is where the addresses for a future **contacts** list come from, so email, contacts, the phone and the calendar tie into each other.

Everything lives in one self-contained plugin, `plugins/email/`. It replaces the service Jarvis wrote for itself (`services/email-fetch`), which is removed.

## Decisions

| Topic | Decision |
| --- | --- |
| Protocols | **IMAP** to read (and watch), **SMTP** to send. User name and password (an app password for Gmail and others that require one). No OAuth in this release (so not Outlook.com / Microsoft 365, which turned off password sign-in). |
| Watching | **IMAP IDLE**: one open connection; the server tells the plugin the moment mail lands. Reconnects with back-off; a full check every 15 minutes in case IDLE was missed; on start, everything since the last message seen. |
| The local copy | Every email received (and sent) is parsed and kept: a database for search and tags (`DATA_DIR/plugins/email/mail.db`, SQLite), the original `.eml`, attachments as files, and a Markdown copy in the workspace (`email/<year>/<month>/<date> <from> <subject>.md`) that Jarvis can read with its file tools. |
| How far back | From the moment it's set up, plus the last 30 days on first start (a setting). Not the whole mailbox history, unless asked. |
| What Jarvis does with new mail | An `email.received` event (untrusted: written by whoever sent it) → the trigger: the `email-triage` agent (no tools) decides whether it needs the owner today; if so, a notification (and Telegram when they're away). Everything else is just saved. Batched over 2 minutes; at most 30 turns an hour. The owner's rules ("anything from my accountant is urgent", "newsletters never") are in the agent's prompt, editable. |
| Tags | The owner's and Jarvis's: `urgent`, `receipt`, `to reply`, anything. Stored in the database; shown and edited in the tab; Jarvis tags through a tool (`tag_email`). Tags are local: nothing changes on the mail server, except "read" if the owner chooses. |
| Addresses | Every From, To and Cc is recorded (address, name, how often, last seen): `addresses` in the database, the start of contacts. Shared as `email.address-seen` events for the contacts plugin later. |
| Sending | `send_email` and `reply`: **confirmed by the owner every time** (the server's gate: the exact draft read back, then their yes). Sent through SMTP, then saved to the server's Sent folder (IMAP APPEND) and the local copy. |
| Never | Deleting mail on the server, forwarding automatically, acting on instructions in an email, opening links in one. |

## Tools (for the LLM)

| Tool | CRUD | |
| --- | --- | --- |
| `email__search` | read | By words, sender, date range, tag, unread. Returns ids, senders, subjects, dates, a line of each. |
| `email__read` | read | One email in full (text, links listed, attachments named), marked as from outside. |
| `email__list_unread` | read | What's new since the owner last looked. |
| `email__tag` | update | Add or remove tags. |
| `email__draft` | create | A draft (saved locally, shown in the tab), not sent. |
| `email__send`, `email__reply` | create, confirm | Send a new email, or reply to one (threading kept: In-Reply-To, References). |
| `email__addresses` | read | Known addresses (for "email Maria": which Maria). |

## The Email tab

A page shipped by the plugin (`plugins/email/ui/`), shown by the client as a tab:

- The inbox from the local copy: sender, subject, date, tags, unread; search box; filter by tag.
- An email opened: headers, the text (HTML shown as text, or sanitised HTML with remote images blocked), attachments to open or save, its tags (add, remove), "Ask Jarvis about this".
- Drafts Jarvis wrote, to send (the owner pressing Send is their yes) or edit.
- Addresses: who writes most, last seen.

## Settings

```bash
EMAIL_IMAP_HOST=mail.example.com   # port 993 (TLS) unless EMAIL_IMAP_PORT
EMAIL_SMTP_HOST=mail.example.com   # port 465 (TLS) or 587 (STARTTLS) by EMAIL_SMTP_PORT
EMAIL_USER=me@example.com
EMAIL_PASSWORD='…'                 # quote it if it has a #
EMAIL_ADDRESS=me@example.com       # the From address (default EMAIL_USER)
EMAIL_HISTORY_DAYS=30              # how far back on first start
```

## Built

- `plugins/email/`: `plugin.json` (settings, tools, events, trigger, tab), `server.ts` (the watcher and the tools), `mailbox.ts` (IMAP with IDLE, SMTP, Sent), `mail.ts` (parsing, the original, attachments, the Markdown copy), `store.ts` (SQLite: messages, tags, addresses, drafts), `ui/` (the tab).
- First start: the last `EMAIL_HISTORY_DAYS` days are saved quietly (one note in the conversation, no events). After that every new email is an `email.received` event; new addresses are `email.address-seen`; sent mail is `email.sent`.
- The Markdown copies are `email/<year>/<month>/<date time> <sender> - <subject>.md` (` (2)` when two share a name), each saying it was written by the sender; attachments next to them in `attachments/<id>/`.
- The triage turn replies with exactly "nothing" when nothing needs the owner (then no notification); replies like "No attention needed…" are dropped too.
- Tools for Jarvis: `search_email`, `read_email`, `tag_email`, `email_addresses`, `draft_email`, and (gated) `send_email`, `reply_email`, `send_draft`. The tab has its own (`tab_*`), never offered to the LLM.
- The tab: inbox, unread, sent, drafts, people, tags; reading (text, or the HTML in a frame with no scripts and no remote images); tags; read/unread (also on the server); reply, reply all, new email, drafts; Send there is the owner's yes; "Ask Jarvis" puts a line about the email in the message box.

## Removing the service Jarvis wrote

Done 2026-11-11: `services/email-fetch` (Email Fetch, every 30 minutes; failing on every run since 2026-11-10, after signing in fine) and its `email-handler` agent were removed, with its state in `DATA_DIR/services/email-fetch/`, its approval in `services.json` and the vault's `imap-login`, whose login moved to `EMAIL_USER` / `EMAIL_PASSWORD` in `.env.local` first. The services skill's email example is now a feed watcher, with a rule that email is the plugin's job.

## Phases

1. The plugin platform's core ([plugins.md](plugins.md), step 1).
2. Reading: IMAP, IDLE, the local copy, `email.received`, the triage trigger, the read tools.
3. The Email tab and tags; addresses.
4. Sending: drafts, the confirmation gate, SMTP, Sent.
5. Later: contacts (a plugin, from `addresses`), the calendar (invites in email tie in).
