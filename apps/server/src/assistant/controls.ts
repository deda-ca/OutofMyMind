// Spoken playback controls: stop, continue, repeat. Matched on transcribed
// text, deterministically: these must always work, and fast, so they never go
// through the LLM. Only short phrases count ("stop", "Jarvis, say that again"),
// so a sentence that merely contains "stop" isn't a command.

export type Control = 'stop' | 'continue' | 'repeat'

const PATTERNS: [Control, RegExp][] = [
  ['stop', /^(stop|stop (it|that|talking|there|please)|please stop|quiet|be quiet|quiet please|silence|shush|hush|shut up|enough|that'?s enough|ok(ay)? that'?s enough|cancel|pause|wait|wait a (second|sec|moment|minute)|hold on|hang on|one (second|sec|moment))$/],
  ['continue', /^(continue|please continue|go on|go ahead|keep going|carry on|resume|proceed|keep talking|you can (continue|go on)|ok(ay)? (continue|go on|go ahead)|and then)$/],
  ['repeat', /^(repeat|repeat (that|it|please)|please repeat|say (that|it) again|can you (repeat that|say that again)|come again|pardon|pardon me|sorry|what|what was that|what did you say|one more time|again)$/],
]

/** The command in a short phrase, or null. "Jarvis", "please", "okay" and punctuation are ignored. */
export function detectControl(text: string): Control | null {
  const t = text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\b(hey |ok |okay )?jarvis\b/g, ' ')
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t || t.split(' ').length > 6) return null
  for (const [control, pattern] of PATTERNS) if (pattern.test(t)) return control
  return null
}

/** "Jarvis, new session" / "start a new conversation" / "start over": Jarvis starts a fresh session. */
export function detectNewSession(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\b(hey |ok |okay )?jarvis\b/g, ' ')
    .replace(/\b(please|now)\b/g, ' ')
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t || t.split(' ').length > 7) return false
  return /^((let's |let us |can we |can you )?(start|begin|open|make|create) )?(a )?(new|fresh) (session|conversation|chat)$/.test(t) || /^(let's )?start (over|afresh|fresh)$/.test(t)
}

/**
 * "Jarvis, only when I say your name" → wake-word-only (no follow-ups: every request needs "Jarvis").
 * "Jarvis, normal mode" / "you can listen for follow-ups again" → follow-ups.
 */
export function detectListenMode(text: string): 'wake-word-only' | 'follow-ups' | null {
  const t = text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\b(hey |ok |okay )?jarvis\b/g, ' ')
    .replace(/\b(please|now|from now on|for now)\b/g, ' ')
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t || t.split(' ').length > 10) return null
  if (
    /^(only (answer |respond |listen )?(when|if) i (say|use|call) your name|(use )?wake word only|wake word mode|name only( mode)?|only when called|stand by|standby|wait (until|till) i (say|call) your name)$/.test(t)
  ) {
    return 'wake-word-only'
  }
  if (/^(normal mode|back to normal|follow ups on|(you can )?listen (for follow ups )?again|(turn )?follow ups (back )?on|end wake word( only)?( mode)?)$/.test(t)) {
    return 'follow-ups'
  }
  return null
}
