# Apps Paradigm Shift

Status: **exploring** (draft 2, 2026-11-12). Nothing here is built. This file is the running record of the idea: what's been decided, what's proposed, what's expected to work, what isn't, and what's still open. Each point says which it is:

- **Decided**: the owner chose it.
- **Proposed**: suggested in discussion, not yet confirmed.
- **Unverified**: a claim nobody has tested on the local model yet.

## 1. The idea

**Decided.** Jarvis has no apps. There is no contacts app, calendar app, email app or to-do app with its own code and screen. There is only:

- **Data**: plain text files in the working folder (Markdown and JSON).
- **Skills**: text files that say how each kind of data is kept.
- **The model**: which does everything by reading and editing those files, following the skills.
- **Views**: screens shown on request, from a view file and the data. Nobody writes a "contacts screen" into the product.

The owner works with all of it by talking to Jarvis. "Add milk to the shopping list" edits a file. "Show my shopping list" opens a view. Ticking a box on that view is the same as saying "check off milk": the model receives it and acts as if it had been said (marks it, moves it, stamps the date).

**Decided: why.** Fewer tools, less code, less UI. Everything goes through the model. The model uses **skills instead of tools**: no calendar tool, contacts tool, email tool or to-do tool. Running locally, token use isn't a concern.

**Decided: tools are minimised, not eliminated.** The model can't touch a file without a tool to read and write it, so a few generic tools stay. What goes is every tool that belongs to one domain.

## 2. The layers

| Layer | What it is | Where | Today |
| --- | --- | --- | --- |
| Data | The owner's things: lists, contacts, events, notes, logs, mail | Workspace files | Exists |
| Skills | How a kind of data is kept: layout, stamps, what "done" means, what to ask | `skills/` | Exists (to-do, weight log) |
| Views | How a kind of data is shown, and what can be done on the screen | With the skill (new) | Plugin tabs only |
| Generic tools | Read, write, search, run a script, show a view | The server | Mostly exists |
| Engines and connectors | The clock; syncing with the outside world (mail, CalDAV, the phone line) | The server, background | Exists as plugins with tools and tabs |

Skills and views are separate things because the same data can have several views (today's to-dos, all of them, a printable list), and one view can show several kinds of data ("my day": events, to-dos, unread mail).

## 3. The tool set

**Proposed.** About five generic tools, down from about 72 tool definitions today:

| Tool | For |
| --- | --- |
| read | A file, or part of one |
| write | Create, edit, append, move (with the checks in section 8) |
| search | Find files and text in the workspace |
| run script | A saved helper, or a one-off (section 7) |
| show view | Open a view on the owner's screen |

Things that aren't data keep their own tools: phone calls, the web, weather. They're actions or lookups, not files the owner keeps.

**What this does not reduce: round trips.** "Add a dentist appointment" is one tool call today. With skills it's read the file, then edit it: two or three steps. The gain is fewer tools and less code, not fewer calls to the model.

## 4. Data: Markdown or JSON

**Background (general pattern, not measured on the local model).** Models read both well. They write and edit Markdown more reliably: adding a line or ticking a box is a small local edit, and a slip leaves an odd line. JSON is strict: one missing quote, comma or bracket breaks the whole file, and small local models make those slips more often. Jarvis's own tool loop already has handling for tool calls whose JSON arguments come out broken or cut off.

**Proposed: split by who writes it.**

- **Markdown** for what the model writes freely and the owner may open by hand: to-do, shopping and other lists, notes, logs. Skills keep these in a strict shape (checkbox lines under headings, tables). One generic reader turns that shape into JSON for a view.
- **JSON** for records a connector maintains: the mail index, synced calendar events, synced contacts. The model doesn't hand-edit large JSON files.

**Open.** With the "no domain tools" decision, the model would edit records by file too. That argues for keeping model-edited records small and forgiving: one file per contact or per day, in Markdown with a few fields at the top, rather than one big JSON file. Not settled.

**Unverified.** How often the local model breaks a Markdown list versus a JSON file over the same edits. A test is planned (section 13).

## 5. Views

### 5.1 What was considered

1. **The model writes the whole page each time, data included.** Exactly "generated on the fly", and fine for a short list. Two problems for anything large: speed (300 contacts is the model typing 300 cards, tens of seconds) and trust (a model copying 300 phone numbers can get one wrong and nothing would show it). **Not chosen as the main path.**
2. **The model writes a page with slots; code fills in the data.** Fast, and a number on screen is always the number in the file. This led to option 3.
3. **Vue views fed JSON.** **Decided** (the owner's proposal).

### 5.2 Vue views

**Decided.** A view is a Vue file. It runs in the browser and builds the screen from pure JSON data it's given. The model can write a view, rewrite it or change it. People can download views (extensions, plugins) to show the same data in other formats or styles. To show something, the view file is loaded and handed its data in the JSON shape it expects.

What this fixes:

- **Speed**: the view is loaded, not generated. The model writes a view only when it's created or changed.
- **Consistency**: the same file renders the same way every time.
- **Checkable**: a Vue file can be compiled when the model writes it, so a broken view goes back to the model before the owner sees it.
- **Sharing**: a view is one file plus a statement of the data it expects.
- **No new dependency**: the client is already Vue.

### 5.3 Where the JSON comes from

**Proposed.** The model must not retype data for display: that brings back the speed and wrong-number problems. Jarvis loads the data and hands it to the view:

- Data already in JSON: handed over directly, no model involved.
- Data in Markdown: the generic reader turns the skill's strict shape into JSON.
- A downloaded view that expects a different shape: the model writes the mapping once and it's saved, not redone on every request.

So the model's part in display is writing views and mappings. It is never in the path of the data itself.

### 5.4 A view is code

A Vue template can run JavaScript, and a downloaded view is someone else's code. **Proposed** conditions:

- Views run in the sandboxed frame plugin tabs use today: no network, no access to the workspace or to Jarvis's API.
- A view gets only the data it declares, which the owner approves on install.
- A view can send only the actions it declares (5.5).
- Views are compiled on the server: that's the check in 5.2, and the frame then doesn't need to allow `eval`.
- Jarvis provides a kit of styled components (list, card, table, checkbox, form), so views look alike by default. A view may bring its own styles.

### 5.5 Acting on a view

**Decided: what it must do.** A checkbox or a form on a view can be submitted, and the model receives it as if the owner had said it.

**Proposed: how.**

1. The owner ticks "milk". The view calls something like `jarvis.act('check', { id })`.
2. Jarvis looks the action up in the view's declared list and starts a turn with its sentence: *"(From the Shopping list screen) Check off milk on the shopping list."*
3. The model follows the skill: ticks it, stamps the date, moves it under Bought.
4. The file changed, so the view gets fresh data.

- **It feels instant**: the box shows ticked ("saving") at once, and the real result replaces it. If the turn fails, it's unticked and Jarvis says why.
- **Only declared actions**: a view can't send free text as an instruction. Values (the text typed into an "add" box) are data, never instructions.
- **Same rules as speaking**: anything that needs the owner's yes by voice needs it from a view (section 9).
- **Quiet**: an action from a screen isn't answered aloud unless something went wrong.
- **Always through the model** (in line with section 1). A direct path for plain ticks could come later if it's too slow.

## 6. Time: one clock that reads files

**The hole.** Something has to fire a reminder at 3 pm, and a script can't wake itself. Models are also unreliable at date arithmetic ("every second Tuesday", time zones, "am I free Thursday?" over hundreds of events).

**Proposed.**

- **No reminder tool.** Any file can carry a time stamp in a fixed form (`remind: 2026-11-17 14:45`, `repeat: every 2 weeks on Tue`). One engine watches for stamps and starts a turn when one comes due ("It's 14:45: from calendar/2026-11-17.md: Dentist at 3"). Writing the line is setting the reminder. Today's scheduler becomes this engine.
- **The model reads dates, it doesn't compute them.** The prompt carries the next two weeks as a small table ("Tue 2026-11-17"). **Unverified** that this removes most weekday mistakes.
- **Shape the data so questions are reading.** One file per day, with repeating events expanded into the day files by the engine, so "what's on Tuesday" is opening a file.

## 7. Scripts

**The question.** The model can write scripts on the fly. Can they handle timing, reminders and the like?

**Assessment.**

- **Written fresh each time**: fine for one-off questions ("average weight in October"), where the result is looked at and the stakes are low. Not for recurring duties: every fresh script is a new chance for a bug. **Unverified** how often the local model gets one wrong.
- **Saved and tested**: reliable. The model writes a helper once, it's run against example inputs before it's accepted, and from then on it's ordinary code. Jarvis already has saved scripts and a sandbox that only sees the workspace.
- **Timing**: not a job for scripts (section 6).
- **Complex connectors** (IMAP, CalDAV): beyond what a local model writes reliably. The email service Jarvis wrote for itself was replaced by a plugin for this reason. They stay as shipped code.

## 8. Guarantees: check, read back, undo

**The hole.** A tool enforces rules. A skill asks for them. The earlier 12-turn test of the to-do and weight-log skills on the local model showed the soft failures: section choice and row format varied a little, and the model skipped rules it wasn't reminded of. A misplaced to-do is harmless. A wrong date or a wrong recipient is not.

**Proposed.** Code stops doing things and starts checking them:

- **Check on every write.** Each skill declares the shape of the files it governs. The write tool checks the shape after each edit and refuses a bad one with the reason, so the model fixes it. Skills already declare which files they govern, and the view's expected JSON can serve as the shape.
- **Read back.** The write returns what was understood ("Added: Dentist, Tue Nov 17, 3:00 to 4:00 pm"). The model says that, so a wrong date is heard at once.
- **Undo.** Every change to the data folder is already committed to git.
- **Folder permissions.** Read-only areas, and tighter limits for turns started by outside content (an incoming email, a text).

## 9. The outside world: propose by file, release by owner

**The hole.** The model can't speak IMAP, CalDAV or SIP. And if it can write a file that sends an email, then text inside an email it reads could make it send one.

**Proposed.**

- **The folder is the interface.** A connector syncs mail into `mail/inbox/`. The model sends by writing a file. The calendar works the same way. Connectors are background file-syncers with no tools and no screens.
- **Drafts and release.** The model writes outgoing things into `outbox/drafts/`. Only the server can move one to `outbox/send/`, after the owner's spoken yes or their click on the view. The model can't write there. One mechanism covers email, texts and calls, and replaces every per-tool confirmation.
- **Results come back as files**: sent items move to `sent/`, failures to `failed/` with the reason.

## 10. A skill becomes a package

**Proposed.** `skills/<name>/` holds everything for one kind of data:

| File | What |
| --- | --- |
| Rules | How the data is kept (today's skill) |
| View(s) | The Vue files, the data each expects, the actions each offers |
| Shape | What the governed files must look like (the check in section 8) |
| Scripts | Saved, tested helpers |
| Examples | Sample data and requests, for testing a changed view or script |

A package is what replaces an "app", and what people would share or download.

## 11. What becomes of today's Jarvis

| Today | In this design |
| --- | --- |
| Skills (to-do, weight log) | Stay, grow into packages |
| Plugin tabs (Email, Calendar, Contacts, Read aloud) | The sandboxed frame and bridge are reused for views; the tabs themselves become views |
| Plugins' tools (`email__*`, `calendar__*`, `contacts__*`) | Go. The plugins shrink to connectors that sync folders |
| `jarvis__show_file`, the document viewer | Becomes "show view" |
| The scheduler and its tools | Becomes the clock engine; the tools go |
| The confirmation gate for tools | Becomes drafts and release |
| The skill guard (rules shown before a governed file changes) | Becomes the check on every write |
| Data history (git) | Stays: the undo |
| Tools on demand | Matters less: there are few tools left |
| Phone, web, weather | Stay as they are |

## 12. Viability, as assessed so far

| Area | Assessment |
| --- | --- |
| Lists, notes, logs | **Works today** this way (skills plus file tools) |
| Contacts (the owner's own address book) | Expected to work. Unverified |
| A personal calendar | Expected to work with the clock engine and day files. Unverified |
| A calendar synced with CalDAV, with repeating events | The hardest piece: a connector has to translate both ways |
| Email: reading and drafting | Expected to work. Sending needs drafts and release |
| Email at thousands of messages | Needs search, or an index file the connector keeps |
| Phone calls, web, weather | Not data: stay as tools |
| Fewer tools, less code, less UI | Yes |
| Fewer calls to the model | No: more steps per request, each cheap locally |

## 13. Planned test

**Proposed, not run.** Before building: contacts and a calendar as pure skills in a scratch workspace, on the local model. About 30 scripted requests each (add, change, move, "what's on next week", "am I free Thursday morning"), counting correct results against today's tools, with and without the check and read-back of section 8. Also the same 20 edits on a Markdown list and on a JSON file, counting broken files and wrong edits (section 4).

## 14. Order of work (proposed)

1. **Shopping list and to-do as views**: a Vue view, the Markdown reader, the frame, the tick and the add box through the model. The whole loop on the smallest data.
2. **Check and read back on writes** for those two skills.
3. **The model writes and changes views by request** ("show the due date too"), with the compile check.
4. **The clock engine** reading stamps from files; the schedule tools retire.
5. **Contacts as a package** (files, no tools).
6. **Calendar**, then **email** with drafts and release; their tabs and tools retire.
7. **Sharing**: installing a package from outside, with its approval step.

## 15. Risks

| Risk | Answer |
| --- | --- |
| The model keeps data badly (wrong section, wrong date) | Check on write, read back, undo |
| The screen shows wrong data | The model is never in the display path |
| A broken view | Compiled and tried on the examples before it's accepted |
| Text in the data acts as an instruction | Declared actions only; values are data; drafts and release for anything outgoing |
| A downloaded view or package misbehaves | The sandboxed frame; declared data and actions; approval on install |
| Too slow to feel like an app | Views load instantly; the instant tick; a direct path later if needed |
| Date mistakes | The date table in the prompt; day files; the engine expands repeats |
| Two things edit a file at once (a sync and the model) | Small files (one per item or day), atomic writes |

## 16. Open questions

- Lists in Markdown with a reader, or everything in JSON with Markdown as one of its views? (Section 4: Markdown proposed.)
- Records the model edits (contacts, events): one small file each, in which format?
- Does a view live inside its skill's package (proposed) or in its own `views/` folder?
- Editing in place on a view (click a to-do to rename it): an action with a text field, or just ask Jarvis?
- What a view may be when there's no screen: over Telegram, on the phone app, read aloud.
- How the owner's spoken yes is tied to one particular draft.
- How much of today's plugins' code survives as connectors, and whether the model can write simple connectors itself (a feed, a weather file).

## 17. Discussion log

| Date | What |
| --- | --- |
| 2026-11-12 | The idea stated: no apps, data in files, views generated on request, checkboxes that act as speech. |
| 2026-11-12 | Draft 1: data, skills and views as layers; view files in words; the model writing pages whole or with slots; actions as declared sentences. |
| 2026-11-12 | The owner proposed Vue as the view language, fed JSON, with views the model can rewrite and people can share. Adopted. Noted: the model must not retype the data, and a view is code, so it's sandboxed. |
| 2026-11-12 | Markdown or JSON: models edit Markdown more reliably. Proposed split by who writes the data. |
| 2026-11-12 | The owner set the direction: skills instead of tools, everything through the model, generic tools only. Assessed as viable for owned data, with three holes: the outside world, time and arithmetic, guarantees. |
| 2026-11-12 | Filling the holes: the clock that reads files, check and read back, drafts and release, saved and tested scripts, the skill as a package. Scripts written fresh each time judged fit for one-off questions only. |
