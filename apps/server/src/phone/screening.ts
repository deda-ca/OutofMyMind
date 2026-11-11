// Marvin answers the phone (docs/phone.md, phase 2): greets the caller, asks
// who it is and what it's about, rings the owner's cell and tells them, then
// connects the two (staying on, silent, recording) or takes a message.
//
// A script, not the LLM: the caller is a stranger, and nothing they say can
// make Marvin do anything but pass their words on. The owner is put through
// only on the 1 key or "connect" (never automatically: a voicemail greeting
// must never be connected to the caller).

import { CallEnded, tone, type VoiceLeg } from './voice.ts'

/** The owner's cell, once it has answered. */
export interface OwnerLeg {
  /** Marvin, talking to the owner only (the caller can't hear). */
  voice: VoiceLeg
  /** The next key the owner presses, or null after `ms`. */
  nextDigit(ms: number): Promise<string | null>
  hangUp(): Promise<void>
  readonly ended: boolean
}

export type Stage = 'greeting' | 'asking' | 'ringing owner' | 'announcing' | 'connected' | 'taking a message' | 'done'

export interface ScreenDeps {
  /** Marvin, on the caller's side. */
  marvin: VoiceLeg
  decision: 'through' | 'screen' | 'message'
  /** "Dr. Smith" (a contact's name) or the number, said for the owner. */
  callerLabel: string
  ownerName: string
  assistantName: string
  recordingNotice: boolean
  /** Rings the owner's cell; null if they don't answer (or it's busy). */
  ringOwner(): Promise<OwnerLeg | null>
  /** Joins the owner's cell to the caller (Marvin stays, silent). */
  connect(owner: OwnerLeg): void
  /** The caller asked not to be recorded. */
  stopRecording(): void
  hangUp(): Promise<void>
  stage(stage: Stage): void
  /** The result so far, each time it changes (the call can end at any moment). */
  report(result: ScreenResult): void
  /** Where the call's clock is (ms), for where the message starts in the recording. */
  clockMs(): number
  /** Pauses between hold messages, and other waits (shortened in tests). */
  timing?: Partial<typeof TIMING>
}

export interface ScreenResult {
  outcome: 'connected' | 'message' | 'hung up' | 'picked up'
  /** What the caller said when asked who they are (their words; untrusted). */
  said: string
  /** Where their message starts in the call (ms), if they left one. */
  messageFromMs: number | null
  recordingOff: boolean
}

export const TIMING = {
  /** Waiting for the caller to say who they are. */
  answerMs: 8000,
  /** Between "still trying" messages while the owner's cell rings. */
  holdMs: 15_000,
  /** Waiting for the owner's 1 or 2. */
  choiceMs: 15_000,
  /** The longest message. */
  messageMs: 120_000,
  /** Silence that ends a message. */
  messageSilenceMs: 4000,
}

const CONNECT = /\b(connect|yes|yeah|yep|put (them|him|her) through|i'?ll take it|take it)\b/i
const MESSAGE = /\b(message|no|nope|not now|busy|later|voicemail)\b/i
const NO_RECORDING = /\b(don'?t|do not|stop|please don'?t|no)\b[^.?!]{0,25}\brecord/i

/** "16135550123" → "6 1 3, 5 5 5, 0 1 2 3" (said digit by digit); anything else as it is. */
export function spokenNumber(number: string): string {
  const m = /^1?(\d{3})(\d{3})(\d{4})$/.exec(number.replace(/\D/g, ''))
  return m ? [m[1], m[2], m[3]].map((g) => g!.split('').join(' ')).join(', ') : number
}

/** The caller's words, cut to something the owner can listen to. */
function quote(said: string): string {
  const words = said.replace(/\s+/g, ' ').trim().split(' ')
  return words.length > 40 ? `${words.slice(0, 40).join(' ')}…` : words.join(' ')
}

export async function screenCall(d: ScreenDeps): Promise<ScreenResult> {
  const t = { ...TIMING, ...d.timing }
  const result: ScreenResult = { outcome: 'hung up', said: '', messageFromMs: null, recordingOff: false }
  const owner = d.ownerName.trim()
  const first = owner.split(/\s+/)[0] ?? ''
  const notice = d.recordingNotice ? ' This call is recorded.' : ''
  const m = d.marvin
  const set = (patch: Partial<ScreenResult>) => {
    Object.assign(result, patch)
    d.report({ ...result })
  }

  const takeMessage = async (lead: string): Promise<void> => {
    d.stage('taking a message')
    if (result.recordingOff) {
      await m.say(`${lead} Since I'm not recording, I can't take a voice message: please call back later, or send a text to this number. Goodbye.`)
      set({ outcome: 'message' })
      await d.hangUp()
      return
    }
    await m.say(`${lead} Please leave your message after the tone, and hang up when you're done.`)
    await m.play(tone(1000, 400))
    set({ messageFromMs: d.clockMs(), outcome: 'message' })
    const until = Date.now() + t.messageMs
    let wait = 10_000
    while (Date.now() < until) {
      const heard = await m.hear(Math.min(wait, until - Date.now()), { endSilenceMs: t.messageSilenceMs, maxMs: Math.max(1000, until - Date.now()) })
      if (!heard) break
      wait = t.messageSilenceMs
    }
    await m.say("Thanks, I'll pass that on. Goodbye.")
    await d.hangUp()
  }

  try {
    d.stage('greeting')
    if (d.decision === 'through') {
      await m.say(`Hi, this is ${d.assistantName}, ${owner ? `${owner}'s` : 'an'} AI assistant.${notice} One moment, I'll get them for you.`)
    } else {
      const greet = `Hi, you've reached ${owner ? `${owner}'s phone` : 'this number'}. I'm ${d.assistantName}, an AI assistant.${notice}`
      if (d.decision === 'message') {
        await takeMessage(`${greet} ${owner ? `${first} can't` : "They can't"} take calls right now, so I'll take a message.`)
        d.stage('done')
        return result
      }
      await m.say(`${greet} Who's calling, and what's it about?`)
      d.stage('asking')
      set({ said: await m.listen(t.answerMs) })
      if (!result.said) {
        await m.say("Sorry, I didn't catch that. Who's calling, and what's it about?")
        set({ said: await m.listen(t.answerMs) })
      }
      if (NO_RECORDING.test(result.said)) {
        set({ recordingOff: true })
        d.stopRecording()
        await m.say("Okay, I've stopped recording.")
      }
      await m.say("Thanks. One moment, I'll see if they're available.")
    }

    // Ringing the owner's cell, with a word now and then so the caller knows they're still on.
    d.stage('ringing owner')
    let leg: OwnerLeg | null | undefined
    const settled = d
      .ringOwner()
      .catch(() => null)
      .then((l) => (leg = l))
    for (;;) {
      await Promise.race([settled, new Promise((r) => setTimeout(r, t.holdMs))])
      if (leg !== undefined) break
      await m.say('Still trying, thanks for waiting.')
    }
    if (!leg) {
      await takeMessage("Sorry, they're not answering.")
      d.stage('done')
      return result
    }

    d.stage('announcing')
    const who = d.callerLabel
    const choice = await askOwner(leg, `Hi${first ? ` ${first}` : ''}, it's ${d.assistantName}. ${who} is calling${result.said ? `. They said: ${quote(result.said)}` : ", and didn't say what it's about"}. Press 1 or say connect to talk to them, or press 2 and I'll take a message.`, t.choiceMs)
    if (choice === 'connect') {
      await leg.voice.say('Connecting you now.').catch(() => {})
      if (!leg.ended) {
        await m.say('Thanks for waiting. Here they are.')
        set({ outcome: 'connected' })
        d.connect(leg)
        d.stage('connected')
        return result
      }
    }
    if (!leg.ended) {
      await leg.voice.say("Okay, I'll take a message.").catch(() => {})
      await leg.hangUp().catch(() => {})
    }
    await takeMessage("Sorry, they can't take your call right now.")
    d.stage('done')
    return result
  } catch (err) {
    if (!(err instanceof CallEnded)) throw err
    // The caller hung up (or the owner picked up on a screen: the phone says which).
    d.stage('done')
    return result
  }
}

/** Tells the owner who's calling and waits for 1 / "connect" or 2 / "message": null if neither (or their cell hung up). */
async function askOwner(leg: OwnerLeg, announcement: string, waitMs: number): Promise<'connect' | 'message' | null> {
  try {
    for (const text of [announcement, 'Press 1 to talk to them, or 2 for a message.']) {
      await leg.voice.say(text)
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && !leg.ended) {
        const left = deadline - Date.now()
        // Words only count when there are some: the key's wait (null at the deadline) decides when time's up.
        const speech = leg.voice.listen(left).then((s) => (s ? s : new Promise<string>(() => {})))
        speech.catch(() => {})
        const got = await Promise.race([leg.nextDigit(left).then((k) => ({ k, s: '' })), speech.then((s) => ({ k: null as string | null, s }))])
        if (got.k === '1' || (got.s && CONNECT.test(got.s))) return 'connect'
        if (got.k === '2' || (got.s && MESSAGE.test(got.s))) return 'message'
        if (got.k === null && !got.s) break
      }
      if (leg.ended) return null
    }
  } catch (err) {
    if (err instanceof CallEnded) return null
    throw err
  }
  return null
}
