import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { AgentLibrary, parseAgent, toAgentFile, validate } from '../src/agents/library.ts'
import { type ClaudeClient, setClaudeClient, toClaude } from '../src/assistant/anthropic.ts'
import { type ChatTarget, LlmError, postChat, readSse } from '../src/assistant/llm.ts'
import { defaultRef, ModelError, readConnections, resolve, splitRef } from '../src/assistant/models.ts'
import { runLoop, type ToolHost } from '../src/harness/loop.ts'

const local = { url: 'http://127.0.0.1:5454', model: 'Assistant', apiKey: undefined, vision: false }

test('no llm.connections: one "local" connection from llm.url and llm.model', () => {
  const [c, ...rest] = readConnections({}, local)
  assert.equal(rest.length, 0)
  assert.deepEqual(c, { id: 'local', label: 'Local', kind: 'openai', url: local.url, model: 'Assistant', models: [], vision: false, llamaCpp: true })
})

test('llm.connections: defaults by kind, ${NAME} from the environment, mistakes said', () => {
  process.env.TEST_CLAUDE_KEY = 'sk-ant-test'
  const list = readConnections(
    {
      llm: {
        connections: [
          { id: 'claude', kind: 'anthropic', apiKey: '${TEST_CLAUDE_KEY}', effort: 'low' },
          { id: 'grok', url: 'https://api.x.ai', apiKey: 'k', models: ['grok-4', 'grok-4-fast'] },
        ],
      },
    },
    local,
  )
  assert.deepEqual(list[0], { id: 'claude', label: 'claude', kind: 'anthropic', url: 'https://api.anthropic.com', apiKey: 'sk-ant-test', model: 'claude-opus-5-5', models: [], vision: true, llamaCpp: false, effort: 'low' })
  assert.equal(list[1]!.model, 'grok-4')
  assert.equal(list[1]!.kind, 'openai')
  assert.equal(list[1]!.vision, false)
  const bad = (connections: unknown, says: RegExp) => assert.throws(() => readConnections({ llm: { connections } }, local), (e: Error) => e instanceof ModelError && says.test(e.message))
  bad([{ id: 'a b', url: 'x', model: 'm' }], /id/)
  bad([{ id: 'a', model: 'm' }], /needs its "url"/)
  bad([{ id: 'a', url: 'x' }], /"model"/)
  bad([{ id: 'a', url: 'x', model: 'm' }, { id: 'a', url: 'y', model: 'n' }], /two connections/)
  bad([{ id: 'a', kind: 'gemini', url: 'x', model: 'm' }], /kind/)
  bad([], /list/)
})

test('"connection/model": the agent\'s pick, else the default (an unknown connection falls back, saying so)', () => {
  const list = readConnections({ llm: { connections: [{ id: 'local', url: 'http://x', model: 'Assistant' }, { id: 'or', url: 'http://y', model: 'a/b' }] } }, local)
  assert.deepEqual(splitRef('or/meta-llama/llama-4'), { connection: 'or', model: 'meta-llama/llama-4' })
  assert.equal(splitRef('nothing'), null)
  assert.equal(defaultRef(list, ''), 'local/Assistant')
  assert.equal(defaultRef(list, 'or/x'), 'or/x')
  assert.equal(defaultRef(list, 'gone/x'), 'local/Assistant')
  const picked = resolve('or/meta-llama/llama-4', list)
  assert.equal(picked.connection.id, 'or')
  assert.equal(picked.model, 'meta-llama/llama-4')
  assert.equal(picked.note, undefined)
  const gone = resolve('gone/model', list)
  assert.equal(gone.connection.id, 'local')
  assert.match(gone.note!, /"gone" isn't in llm.connections/)
  assert.equal(resolve(undefined, list).model, process.env.LLM_DEFAULT ? resolve(undefined, list).model : 'Assistant')
})

const claude: ChatTarget = { kind: 'anthropic', connection: 'claude', url: 'https://api.anthropic.com', model: 'claude-opus-5-5', apiKey: 'sk-ant-test', vision: true, llamaCpp: false, effort: 'medium' }
const tool = { type: 'function', function: { name: 'files__read', description: 'Reads a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }

test('the chat as Claude takes it: system prompt, images, tool calls and results', () => {
  const png = Buffer.from('fake').toString('base64')
  const params = toClaude(claude, {
    tools: [tool],
    messages: [
      { role: 'system', content: 'You are Jarvis.' },
      { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] },
      { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'files__read', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'Error: no such file' },
      { role: 'system', content: 'The owner is away.' },
      { role: 'user', content: 'ok' },
    ],
  })
  assert.equal(params.system, 'You are Jarvis.')
  assert.equal(params.temperature, undefined)
  assert.deepEqual(params.output_config, { effort: 'medium' })
  assert.equal(params.fallbacks, 'default')
  assert.deepEqual(params.cache_control, { type: 'ephemeral' })
  assert.deepEqual(params.tools, [{ name: 'files__read', description: 'Reads a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } }, eager_input_streaming: true }])
  assert.deepEqual(params.messages, [
    { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't1', name: 'files__read', input: { path: 'a.txt' } }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'Error: no such file', is_error: true },
        { type: 'text', text: '(Note from the system: The owner is away.)' },
        { type: 'text', text: 'ok' },
      ],
    },
  ])
})

test('without tools, earlier tool calls go to Claude as text; a chat starting with Claude gets an opening', () => {
  const params = toClaude({ ...claude, model: 'claude-haiku-5-5' }, {
    messages: [
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'files__read', arguments: '{}' } }], raw: { model: 'claude-haiku-5-5', content: [{ type: 'thinking', thinking: '…', signature: 's' }] } },
      { role: 'tool', tool_call_id: 't1', content: 'hello' },
    ],
  })
  assert.equal(params.fallbacks, undefined)
  assert.equal(params.tools, undefined)
  assert.deepEqual(params.messages, [
    { role: 'user', content: [{ type: 'text', text: '(The conversation so far.)' }] },
    { role: 'assistant', content: [{ type: 'text', text: '[called files__read with {}]' }] },
    { role: 'user', content: [{ type: 'text', text: '[files__read result: hello]' }] },
  ])
})

/** A fake Anthropic client: answers each request with the next script; keeps what was asked. */
function fakeClaude(scripts: { events: Record<string, unknown>[]; final: Record<string, unknown> }[]) {
  const asked: Record<string, unknown>[] = []
  const client: ClaudeClient = {
    beta: {
      messages: {
        stream(params) {
          asked.push(structuredClone(params))
          const s = scripts.shift()
          if (!s) throw new Error('no more scripts')
          return {
            async *[Symbol.asyncIterator]() {
              yield* s.events
            },
            finalMessage: async () => s.final as never,
          }
        },
      },
    },
  }
  return { client, asked }
}

const thinking = { type: 'thinking', thinking: 'They want the file.', signature: 'sig-1' }
const toolStep = {
  events: [
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'They want the file.' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me look.' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'files__read', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ],
  final: {
    content: [thinking, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_1', name: 'files__read', input: { path: 'a.txt' } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 },
  },
}
const answerStep = {
  events: [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It says hello.' } }],
  final: { content: [{ type: 'text', text: 'It says hello.' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 4 } },
}

test("Claude's stream comes back as OpenAI-style chunks: text, tool calls, usage, its own blocks", async (t) => {
  const { client } = fakeClaude([toolStep])
  setClaudeClient(client)
  t.after(() => setClaudeClient(null))
  const response = await postChat(claude, { messages: [{ role: 'user', content: 'Read a.txt' }], tools: [tool] })
  const chunks: Record<string, unknown>[] = []
  for await (const { data } of readSse(response.body!)) chunks.push(data)
  const deltas = chunks.map((c) => (c as { choices?: { delta?: unknown; finish_reason?: unknown }[] }).choices?.[0])
  assert.deepEqual(deltas[0], { index: 0, delta: { content: 'Let me look.' }, finish_reason: null })
  assert.deepEqual(deltas[1]!.delta, { tool_calls: [{ index: 0, id: 'toolu_1', type: 'function', function: { name: 'files__read', arguments: '' } }] })
  assert.deepEqual(deltas[2]!.delta, { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] })
  assert.equal(deltas[4]!.finish_reason, 'tool_calls')
  assert.deepEqual(chunks[5], { choices: [], usage: { prompt_tokens: 1015, completion_tokens: 20, total_tokens: 1035, prompt_tokens_details: { cached_tokens: 1000 } } })
  assert.deepEqual(chunks[6], { jarvis_raw: { model: 'claude-opus-5-5', content: toolStep.final.content } })
})

test("the tool loop with Claude: its thinking goes back unchanged; the last step has tools but can't call them", async (t) => {
  const { client, asked } = fakeClaude([toolStep, answerStep, structuredClone(answerStep)])
  setClaudeClient(client)
  t.after(() => setClaudeClient(null))
  const host: ToolHost = {
    tools: () => [tool as never],
    label: () => 'Reading',
    call: async (_name, args) => ({ text: `contents of ${args.path}: hello`, isError: false }),
  }
  let said = ''
  const result = await runLoop(claude, [{ role: 'user', content: 'Read a.txt' }], host, { onDelta: (d) => (said += d) })
  assert.equal(said, 'Let me look. It says hello.')
  assert.equal(result.text, said)
  const second = asked[1]!.messages as { role: string; content: Record<string, unknown>[] }[]
  assert.deepEqual(second[1], { role: 'assistant', content: toolStep.final.content })
  assert.deepEqual(second[2]!.content[0], { type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents of a.txt: hello' })
  assert.equal(asked[1]!.tool_choice, undefined)

  // One step only: it's the last, so the tools are there (Claude needs them for the history) with tool_choice none.
  await runLoop(claude, [{ role: 'user', content: 'hi' }], host, { onDelta: () => {}, maxSteps: 1 })
  assert.deepEqual(asked[2]!.tool_choice, { type: 'none' })
  assert.equal((asked[2]!.tools as unknown[]).length, 1)
})

test('a Claude connection without an apiKey says so', async () => {
  await assert.rejects(postChat({ ...claude, apiKey: undefined }, { messages: [{ role: 'user', content: 'hi' }] }), (e: Error) => e instanceof LlmError && /no apiKey/.test(e.message))
})

test("an agent's model: read from its file, written back, checked", () => {
  const agent = parseAgent('helper', '---\nname: Helper\nmodel: "claude/claude-sonnet-5-5"\n---\nHi.\n')
  assert.equal(agent.model, 'claude/claude-sonnet-5-5')
  assert.match(toAgentFile({ name: 'Helper', description: '', tools: null, model: 'or/meta-llama/llama-4:free', body: 'Hi.' }), /^model: "or\/meta-llama\/llama-4:free"$/m)
  assert.equal(parseAgent('x', '---\nname: X\nmodel: no-slash\n---\n').model, undefined)
  assert.throws(() => validate({ name: 'X', description: '', tools: null, model: 'no-slash', body: '' }), /connection\/model/)
  assert.equal(validate({ name: 'X', description: '', tools: null, model: ' local/Assistant ', body: '' }).model, 'local/Assistant')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-model-'))
  fs.mkdirSync(path.join(dir, 'agents'))
  const library = new AgentLibrary(dir)
  const created = library.create({ name: 'Writer', description: '', tools: null, model: 'claude/claude-opus-5-5', body: 'Write.' })
  assert.equal(library.get(created).model, 'claude/claude-opus-5-5')
  fs.rmSync(dir, { recursive: true, force: true })
})
