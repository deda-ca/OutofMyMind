import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Its own config file (read once per process: this test file runs in its own).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'))
fs.writeFileSync(
  path.join(dir, 'config.jsonc'),
  JSON.stringify({
    llm: {
      default: 'local/Assistant',
      connections: [
        { id: 'local', url: 'http://127.0.0.1:1', model: 'Assistant', llamaCpp: true },
        { id: 'claude', kind: 'anthropic', apiKey: 'k', model: 'claude-opus-5-5', budget: 0.05 },
      ],
    },
  }),
)
process.env.CONFIG_FILE = path.join(dir, 'config.jsonc')
const { chatTarget } = await import('../src/assistant/llm.ts')
const { usageLog } = await import('../src/assistant/usage.ts')

test("a connection's daily budget spent: new turns use the default model", () => {
  assert.equal(chatTarget({ model: 'claude/claude-opus-5-5' }).connection, 'claude')
  // 10K output tokens on Opus 5.5 = $0.20: over the $0.05 budget.
  usageLog.record({ connection: 'claude', kind: 'anthropic', model: 'claude-opus-5-5', budget: 0.05 }, { input: 0, cached: 0, cacheWrite: 0, output: 10_000 })
  const t = chatTarget({ model: 'claude/claude-opus-5-5' })
  assert.equal(t.connection, 'local')
  assert.equal(t.model, 'Assistant')
  fs.rmSync(dir, { recursive: true, force: true })
})
