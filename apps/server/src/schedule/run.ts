// A schedule going off, as one unattended turn of the LLM: it's told what
// went off and its instructions, has its tools (the screen, presence, and the
// plugins), and decides what to say and how to reach the owner. Nobody is
// watching, so unless the schedule allows changes, it gets no tool that
// changes or deletes the owner's things (sending a message is "create", so a
// messaging plugin still works).

import { AgentLibrary, toolAllowed } from '../agents/library.ts'
import { systemPrompt } from '../assistant/assistant.ts'
import { chatTarget, streamChat } from '../assistant/llm.ts'
import { config } from '../config.ts'
import { harness, type BuiltinTool, type LoopResult } from '../harness/index.ts'
import type { SkillLibrary } from '../skills/library.ts'
import { toolUses } from '../sessions/history.ts'
import type { Notifier } from './notifier.ts'
import type { RunOutcome, RunRequest } from './scheduler.ts'
import { describeRepeat, describeTime } from './when.ts'

/** Tools that reach the owner (by name): a call to one that succeeded means the owner was told. */
export const MESSAGING = /(^|_)(send|notify|message|messages|email|mail|sms|text|telegram|whatsapp|signal|matrix|slack|discord|push|ntfy|publish|post|alert|dm)(_|$)/i

export function scheduledRun(deps: { agents: AgentLibrary; skills: SkillLibrary; notifier: Notifier; builtins: (scheduleId: string, followUp: boolean) => BuiltinTool[] }) {
  return async (req: RunRequest): Promise<RunOutcome> => {
    const s = req.schedule
    const owner = config.ownerName || 'the owner'
    const agent = deps.agents.get(undefined)
    const target = chatTarget(agent)
    const allow = (name: string) => toolAllowed(agent, name) && (s.allowChanges === true || !harness.crudOf(name).some((k) => k === 'update' || k === 'delete'))
    const now = new Date()
    const repeat = s.repeat ? describeRepeat(s.repeat, new Date(s.start)) : 'once'
    const rules = [
      `This turn is from Jarvis's scheduler, not from ${owner}: something ${owner} scheduled has gone off, and nobody is waiting for an answer in the conversation.`,
      `Whatever you write as your reply is spoken and shown on ${owner}'s Jarvis screen (as a notification), so write it for ${owner}, briefly, as you'd say it aloud. If you have nothing to tell them, reply with nothing.`,
      `If the instructions (or ${owner}'s rules) say to reach them another way (a messaging tool such as Telegram or email), use that tool; then your reply is only noted, not spoken. jarvis__presence tells you whether anyone is at a Jarvis screen.`,
      s.allowChanges ? '' : `You can look things up and send messages, but not change or delete ${owner}'s files or data in this turn. If the instructions need that, say it couldn't be done unattended.`,
    ].filter(Boolean).join('\n')
    const system = systemPrompt(agent, deps.agents, deps.skills, [['Scheduled run', rules]])

    let ask: string
    if (req.reason === 'unacknowledged') {
      ask =
        `(Scheduler: the ${s.kind} "${s.title}" has been ringing on the Jarvis screen for 2 minutes and nobody has stopped it. ${deps.notifier.describePresence()} ` +
        `It is still ringing there; don't ring or notify it again. If you have a messaging tool and ${owner}'s rules or the instructions say to use it, send them a short message now ("${s.message}"). Otherwise reply with nothing.)`
    } else {
      const ringing = req.ringing ? ` It is ringing on the Jarvis screen now, with: "${s.message}".` : ''
      const late = req.late ? ` It was due ${describeTime(req.dueAt, now)}, but Jarvis was off then: say it's late.` : ''
      ask = `(Scheduler: the ${s.kind} "${s.title}" (${repeat}) has gone off.${ringing}${late} Your instructions for it: ${s.prompt})`
    }
    const builtins = deps.builtins(s.id, req.reason === 'unacknowledged')
    // With plugins: the tool loop (the screen tools come with it). Without: plain chat, whose reply is the notification.
    const result: LoopResult = harness.status().length
      ? await harness.run(target, [system, { role: 'user', content: ask }], () => {}, req.signal, undefined, allow, builtins)
      : { text: await streamChat(target, [system, { role: 'user', content: ask }], () => {}, req.signal), steps: [] }
    const steps = result.steps
    const text = result.text
    const tools = toolUses(steps)
    const ok = (t: { result: string }) => !/^(error|failed|not available|the tool)/i.test(t.result.trim())
    return {
      text: req.reason === 'unacknowledged' ? '' : cleanReply(text),
      notified: tools.some((t) => t.name === 'jarvis__notify' && ok(t)),
      sent: tools.some((t) => !t.name.startsWith('jarvis__') && MESSAGING.test(t.name.split('__')[1] ?? '') && ok(t)),
      tools,
    }
  }
}

/** "Nothing to say" in words isn't something to speak. */
function cleanReply(text: string): string {
  const t = text.trim()
  return /^\(?(nothing|no reply|none|n\/a)\.?\)?$/i.test(t) ? '' : t
}
