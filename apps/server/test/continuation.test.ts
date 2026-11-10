// A request said in pieces: pausing mid-sentence ends a phrase, and the next
// phrase continues the request. The assistant with a fake local LLM.
import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { Assistant, type AssistantMessage, type AssistantPhrase } from '../src/assistant/assistant.ts'
import { config } from '../src/config.ts'
import type { SessionEntry } from '../src/sessions/format.ts'
import type { SpeakerTag } from '../src/speaker/speakers.ts'

/** A chat-completions server that answers "Answer N." after `delayMs`, and records what it was asked. */
async function fakeLlm(delayMs: number) {
  const asked: { role: string; content: string }[][] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const n = asked.push(JSON.parse(body).messages)
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Answer ${n}.` } }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      }, delayMs)
      res.on('close', () => clearTimeout(timer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { asked, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() }
}

const owner: SpeakerTag = { speakerId: 1, name: 'You', named: true, isOwner: true, similarity: 0.7, match: null, confidence: 'high' }
const stranger: SpeakerTag = { speakerId: 2, name: 'Speaker A', named: false, isOwner: false, similarity: 0.4, match: 0.8, confidence: 'high' }

function setup(ownerTrained: boolean) {
  const events: AssistantMessage[] = []
  const entries: SessionEntry[] = []
  const assistant = new Assistant({
    emit: (m) => events.push(m),
    saveReply: () => {},
    ownerTrained: () => ownerTrained,
    followUpMs: () => 60_000,
    speak: () => false,
    roomMemoryMs: () => 0,
    session: { entries: () => entries, agentId: () => '', record: (e) => void entries.push(e), startNew: () => void (entries.length = 0) },
    log: () => {},
  })
  let id = 0
  const say = (text: string, speaker: SpeakerTag | undefined = ownerTrained ? owner : undefined) => {
    const phrase: AssistantPhrase = { id: ++id, archiveId: null, text, speaker }
    assistant.handle(phrase)
  }
  const kinds = () => events.filter((e) => e.type !== 'assistant.state').map((e) => `${e.type.slice(10)}:${'replyId' in e ? e.replyId : ''}`)
  return { assistant, events, entries, say, kinds }
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('pieces of one request: the unanswered reply is dropped, and the next answers the whole request', async (t) => {
  const llm = await fakeLlm(200)
  const saved = config.llmUrl
  ;(config as { llmUrl: string }).llmUrl = llm.url
  t.after(() => {
    ;(config as { llmUrl: string }).llmUrl = saved
    llm.close()
  })
  const { assistant, entries, say, kinds, events } = setup(false)
  say('Jarvis, go to DuckDuckGo and search for')
  await until(() => llm.asked.length === 1)
  say('ticket prices between Ottawa and Montreal')
  await until(() => events.some((e) => e.type === 'assistant.done'))
  assistant.close()

  // Reply 1 is withdrawn (its line goes), reply 2 answers.
  assert.deepEqual(kinds().filter((k) => !k.startsWith('delta')), ['start:1', 'cancel:1', 'start:2', 'done:2'])
  assert.equal((events.find((e) => e.type === 'assistant.done') as { text: string }).text, 'Answer 2.')
  // No empty "…" turn for the model to copy: both pieces, then the answer.
  assert.deepEqual(
    entries.map((e) => `${e.kind}: ${e.text}`),
    ['owner: Jarvis, go to DuckDuckGo and search for', 'owner: ticket prices between Ottawa and Montreal', 'jarvis: Answer 2.'],
  )
  // The model gets both pieces as the owner's, with no answer of its own in between.
  const [, ...turns] = llm.asked[1]!
  assert.deepEqual(
    turns.map((m) => `${m.role}: ${m.content.replace(/^\[\d\d:\d\d\] /, '')}`),
    ['user: Jarvis, go to DuckDuckGo and search for', 'user: ticket prices between Ottawa and Montreal'],
  )
})

test('once Jarvis has answered, the next phrase is a new request', async (t) => {
  const llm = await fakeLlm(10)
  const saved = config.llmUrl
  ;(config as { llmUrl: string }).llmUrl = llm.url
  t.after(() => {
    ;(config as { llmUrl: string }).llmUrl = saved
    llm.close()
  })
  const { assistant, entries, say, kinds } = setup(false)
  say('Jarvis, what time is it')
  await until(() => kinds().includes('done:1'))
  say('and the date')
  await until(() => kinds().includes('done:2'))
  assistant.close()
  assert.ok(!kinds().some((k) => k.startsWith('cancel')))
  assert.deepEqual(entries.map((e) => e.text), ['Jarvis, what time is it', 'Answer 1.', 'and the date', 'Answer 2.'])
})

test("a short phrase scored as someone else, right after the owner's request, doesn't end the conversation", async (t) => {
  const llm = await fakeLlm(10)
  const saved = config.llmUrl
  ;(config as { llmUrl: string }).llmUrl = llm.url
  t.after(() => {
    ;(config as { llmUrl: string }).llmUrl = saved
    llm.close()
  })
  const { assistant, entries, say, kinds } = setup(true)
  say('Jarvis, find me a round-trip flight')
  await until(() => kinds().includes('done:1'))
  say("Doesn't matter when I fly", stranger) // misheard voice: context, not a request
  say('search this week and next week') // the owner, no "Jarvis": still in the conversation
  await until(() => kinds().includes('done:2'))
  assistant.close()
  assert.deepEqual(
    entries.map((e) => e.kind),
    ['owner', 'jarvis', 'context', 'owner', 'jarvis'],
  )
})
