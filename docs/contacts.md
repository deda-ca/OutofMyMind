# Contacts: the owner's people, as a plugin

Status: built 2026-11-11, a self-contained plugin on the plugin platform ([plugins.md](plugins.md)). Tested for real with the email plugin: while contacts couldn't start, email's 59 addresses were kept by the server and sent to contacts when it started (47 suggested, 12 set aside as machines); the Contacts tab worked in Chrome under its CSP.

## What it does

- **People** with a name, organisation ("dentist" works), several emails and phone numbers (each with a label: cell, work, home), birthday, tags and notes. Kept in `DATA_DIR/plugins/contacts/contacts.db`. Phone numbers are kept as E.164 digits (`16135550123`) so "613-555-0123", "+1 (613) 555 0123" and a caller ID all match. An email belongs to one person: given to someone else, it moves.
- **Learning from email, with the owner deciding.** Contacts subscribes to the email plugin's `email.address-seen` (through the server, never calling email directly). Every address seen for the first time becomes a **suggestion** in the Contacts tab: **Add** (a new contact, named as in the email), **Add to someone…** (another address for a person already there), or **Ignore**. Machines (`no-reply@`, `notifications@`, newsletters, mailing systems) are **set aside** automatically, with the reason, and can be brought back. Nothing becomes a contact on its own.
- **Missed events aren't lost.** The server keeps the events plugins subscribe to and sends a plugin what it missed when it (re)connects (the platform's event log, [plugins.md](plugins.md)).
- **vCard**: import a `.vcf` from a phone or another app (2.1, 3.0 and 4.0; people already there, by email or phone, are merged), and export everyone to `contacts/contacts.vcf` in the workspace.
- **Events out**: `contact.added`, `contact.updated`, `contact.deleted`, for plugins that will want them (the phone's screening, the calendar).

## Tools for Jarvis

| Tool | CRUD | |
| --- | --- | --- |
| `contacts__find_contact` | read | By name, organisation, email or digits of a number: their emails and numbers. Before emailing, texting or calling someone by name. |
| `contacts__who_is` | read | Who an email address or phone number is. |
| `contacts__add_contact` | create | When the owner asks or says who someone is. Never strangers on its own. |
| `contacts__update_contact` | update | Add or remove emails and numbers; rename; organisation, notes, birthday, tags. |

The tab has its own tools (`tab_*`: list, edit, delete, suggestions, import, export), never offered to the LLM.

## Not yet

- The phone using contacts: caller names on incoming calls, screening rules by contact (today's "always" list), names in the call log.
- Telegram and text messages as sources of numbers.
- Merging two contacts that turn out to be the same person (by hand in the tab today: add the address to one, delete the other).
- Syncing with a phone or a server (CardDAV); import and export by file for now.
