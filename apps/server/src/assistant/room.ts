// What Jarvis has heard around it lately: every phrase, from anyone, for the
// room-memory window (a setting, 5 minutes by default). Each request to the
// LLM gets a note built from it, placed just before the owner's latest
// message: who has been heard (how many people, and how sure each voice match
// is) and what was said that isn't already in the conversation, with times.
// So "answer Maria's question" works, and Jarvis knows whether it's alone
// with the owner or in a room of five.

import type { Confidence, SpeakerTag } from '../speaker/speakers.ts'

export interface RoomLine {
  at: number
  /** Who, as the LLM sees it: "Owner", "Maria", "Maria (probably)", "Speaker B (unsure)". */
  who: string
  /** Groups lines by person for the people list. */
  key: string
  /** For the people list: the name without the confidence note. */
  name: string
  sure: boolean
  text: string
  /** Already in the conversation (a request to Jarvis, or context it was given): not repeated in the note. */
  inSession: boolean
}

/** At most this many lines are kept, and this many go in a note (the most recent). */
const MAX_LINES = 300
const MAX_NOTE_LINES = 40

/**
 * How a phrase's speaker is named for the LLM. A name is only given plainly
 * when the voice match is sure: "(probably)" for a likely match, "(unsure)"
 * for a guess, so the model doesn't greet the wrong person by name.
 */
export function speakerLabel(speaker: SpeakerTag | undefined): { who: string; key: string; name: string; sure: boolean } {
  if (speaker?.isOwner === true) return { who: 'Owner', key: 'owner', name: 'Owner', sure: true }
  const name = speaker?.name && speaker.name !== 'You' ? speaker.name : null
  if (!name) return { who: 'Someone (unknown voice)', key: 'unknown', name: 'someone unidentified', sure: false }
  const key = speaker!.speakerId !== null ? `person:${speaker!.speakerId}` : `name:${name}`
  const note = confidenceNote(speaker!.confidence)
  return { who: note ? `${name} (${note})` : name, key, name, sure: note === '' }
}

function confidenceNote(confidence: Confidence): string {
  return confidence === 'high' ? '' : confidence === 'low' ? 'probably' : 'unsure'
}

export class Room {
  private lines: RoomLine[] = []
  private readonly windowMs: () => number

  constructor(windowMs: () => number) {
    this.windowMs = windowMs
  }

  /** A phrase was heard (or typed by the owner). Returns its line, to mark it if it goes into the session. */
  hear(speaker: SpeakerTag | undefined, text: string, at = Date.now()): RoomLine {
    const line: RoomLine = { at, ...speakerLabel(speaker), text, inSession: false }
    this.lines.push(line)
    this.prune(at)
    return line
  }

  /** Lines still within the window. */
  recent(now = Date.now()): RoomLine[] {
    const windowMs = this.windowMs()
    if (windowMs <= 0) return []
    return this.lines.filter((l) => now - l.at <= windowMs)
  }

  /**
   * The note for the LLM, or null with room memory off. `exclude`: the line
   * being answered right now (it's the request itself).
   */
  note(now = Date.now(), exclude?: RoomLine): string | null {
    const windowMs = this.windowMs()
    if (windowMs <= 0) return null
    const recent = this.recent(now)
    const minutes = Math.round(windowMs / 60_000)
    const span = minutes >= 1 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${Math.round(windowMs / 1000)} seconds`

    // Who: one entry per person, the owner first, sure before unsure.
    const people = new Map<string, { name: string; sure: boolean; lines: number }>()
    for (const l of recent) {
      const p = people.get(l.key) ?? { name: l.name, sure: false, lines: 0 }
      p.lines++
      p.sure ||= l.sure
      people.set(l.key, p)
    }
    const others = [...people.entries()].filter(([k]) => k !== 'owner')
    const list = [
      ...(people.has('owner') ? ['the owner'] : []),
      ...others
        .sort(([, a], [, b]) => Number(b.sure) - Number(a.sure) || b.lines - a.lines)
        .map(([, p]) => `${p.name} (${p.sure ? 'voice match sure' : 'voice match not sure'})`),
    ]
    const count = people.size
    const who =
      count === 0
        ? `Nobody has been heard in the last ${span}.`
        : others.length === 0
          ? `Only the owner has been heard in the last ${span}.`
          : `${count} ${count === 1 ? 'voice' : 'voices'} heard in the last ${span}: ${list.join(', ')}.`

    const said = recent.filter((l) => !l.inSession && l !== exclude).slice(-MAX_NOTE_LINES)
    const lines = said.map((l) => `[${clock(l.at)}] ${l.who}: ${l.text}`)
    return [
      `(Room note from Jarvis's software, not a request. It's ${clock(now)}. ${who}`,
      lines.length ? `Said nearby and not already in this conversation, oldest first:\n${lines.join('\n')})` : 'Nothing else was said nearby.)',
    ].join('\n')
  }

  private prune(now: number): void {
    // Keep at least 30 minutes (the longest setting), so raising the setting brings older lines back.
    const keep = Math.max(this.windowMs(), 30 * 60_000)
    this.lines = this.lines.filter((l) => now - l.at <= keep).slice(-MAX_LINES)
  }
}

/** "14:32:05", in the server's local time. */
export function clock(at: number | string): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
