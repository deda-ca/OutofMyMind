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

/** "Jarvis, use Hermes" / "Jarvis, switch to the local model": which brain answers. */
export function detectBrainSwitch(text: string): 'hermes' | 'local' | null {
  const t = text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\b(hey |ok |okay )?jarvis\b/g, ' ')
    .replace(/\b(please|now|instead)\b/g, ' ')
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t || t.split(' ').length > 8) return null
  const verb = "(use|switch to|change to|go to|go back to|back to|talk to|let me talk to|connect (me )?to|hand (me )?over to|switch over to)"
  if (new RegExp(`^(${verb} )?(the )?hermes( agent| mode)?$`).test(t) && t !== 'hermes') return 'hermes'
  if (new RegExp(`^(${verb} )?(the )?(local|local model|local llm|local brain|normal mode|default model|regular model|llama)( model| mode)?$`).test(t) && t !== 'local') return 'local'
  return null
}
