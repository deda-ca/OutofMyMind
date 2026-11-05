// Wake word and dismissal phrases, matched on transcribed text.
// Transcripts vary in case and punctuation ("Jarvis,", "jarvis?", "Jarvis.").

const WAKE = /\bjarvis\b/i

/** Words that, with the wake word, mean "you can go" ("thanks, Jarvis"). */
const DISMISS_WITH_NAME = [
  /\b(thanks|thank you|cheers)\b[\s,.!]*(jarvis)?[\s,.!]*$/i,
  /\b(that'?s all|that is all|that'?ll be all|goodbye|bye|good night|dismissed)\b/i,
  /\bjarvis\b[\s,.!]*(go to sleep|sleep|stop|stop listening|that'?s all|you can go|dismissed)\b/i,
  /\b(go to sleep|stop listening|you can go)\b/i,
]

/** While in a conversation, these end it even without "Jarvis". */
const DISMISS_ALONE = /^[\s,.!]*(ok(ay)?[\s,.!]*)?(thanks|thank you)?[\s,.!]*(that'?s all|that is all|that'?ll be all|goodbye|bye|never ?mind|stop listening|go to sleep|dismissed|i'?m done|we'?re done)[\s,.!]*$/i

function normalise(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

export function hasWakeWord(text: string): boolean {
  return WAKE.test(text)
}

/** The request with the wake word taken out ("Jarvis, what time is it?" → "what time is it?"). */
export function withoutWakeWord(text: string): string {
  return normalise(text.replace(/\b(hey|hi|ok|okay)?[\s,]*jarvis\b[\s,.!?]*/gi, ' '))
}

/**
 * Whether a phrase dismisses Jarvis.
 * Idle: only together with the wake word ("thanks, Jarvis"). In a conversation: also the short phrases alone.
 */
export function isDismissal(text: string, inConversation: boolean): boolean {
  const t = normalise(text)
  if (inConversation && DISMISS_ALONE.test(t)) return true
  if (!WAKE.test(t)) return false
  // "Jarvis, thank you, that's all" yes; "Jarvis, thanks for the reminder earlier, what's next?" no:
  // a dismissal is short and has no question.
  if (t.includes('?') || withoutWakeWord(t).split(' ').length > 6) return false
  return DISMISS_WITH_NAME.some((r) => r.test(t))
}

/** Just "Jarvis" (possibly "Hey Jarvis"), with no request. */
export function isWakeOnly(text: string): boolean {
  return hasWakeWord(text) && withoutWakeWord(text).replace(/[^\p{L}\p{N}]/gu, '').length === 0
}
