# Read aloud: a plugin with its own tab

Status: moved out of the client into a self-contained plugin on 2026-11-11 ([plugins.md](plugins.md)); it used to be a side panel built into the Jarvis page (`ReaderPanel.vue`, `reader.ts`, now gone). Tested in Chrome with real speech: text handed over by Jarvis's tool appeared with its title, the voices loaded, playing started 0.8 s after Play with the word being read highlighted and moving, and it paused while Jarvis spoke and carried on after.

## What it does

- An editable page in the **Read aloud** tab: paste or type (pasted Markdown is shown formatted, cleaned with DOMPurify), or a document opened from the viewer's 🔊, or text Jarvis hands over.
- Read sentence by sentence in a chosen voice (by default one that isn't Jarvis's) and speed; the sentence and the word being read are highlighted; click a word, or select text, to read from there; previous / next sentence, stop.
- Audio is fetched a couple of sentences ahead and kept, so going back is instant. The word being read is estimated from each sentence's audio length.
- **Jarvis talking pauses it**, and it carries on when Jarvis is done (the Jarvis page tells every open tab, `jarvis.onHost`).
- **It keeps reading in the background**: an opened plugin tab stays alive (hidden) while another tab is shown.
- **One bar**: the title, the player (previous, play/pause, stop, next), "Sentence x of y", the text size (A− / A+, or Ctrl − / Ctrl + / Ctrl 0), the voice, the speed, clear. The text size goes from 0.85× to 2.8×.
- **The tab's button** shows a gently pulsing 🔊 while reading (on any tab), ⏸ while paused.
- The voice, speed and text size are remembered by the plugin (`DATA_DIR/plugins/reader/prefs.json`): a sandboxed tab has no browser storage.

## How it's put together

| Piece | Where |
| --- | --- |
| The plugin: speech models and voices, one sentence as speech (asked of the server: `speechOptions` and `speak`, the WAV base64 to the tab), preferences, text handed over | `plugins/reader/server.ts`, `plugin.json` |
| The tab: the page, words and sentences, playback, highlighting | `plugins/reader/ui/` (with `marked` and `DOMPurify` copied in `ui/vendor/`, versions and licenses in its README) |
| Jarvis's tool | `reader__read_aloud` (text, title): Jarvis gets the text first (a file, a page, an email), the tab opens with it, the owner presses Play |
| The client | the 🔊 button beside the message box opens the tab; the document viewer's 🔊 hands the document over (`readAloud` in `apps/client/src/plugins.ts`) |

Settings: none of its own. The speech comes from the server's speech servers (`audio.connections`), so any speech model and voice there can read; the bar shows a speech model choice when there's more than one, and the voice list follows it. The choices are remembered.
