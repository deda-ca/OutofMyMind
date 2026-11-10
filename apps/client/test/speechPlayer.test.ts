// Run: node --test test/ (Node strips the TypeScript types).
// The speech player with a fake AudioContext: each "WAV" is one byte (its
// sentence number, 255 = undecodable), and a sentence ends when the test says so.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SpeechPlayer, type PlayerState } from '../src/audio/speechPlayer.ts'

interface FakeSource {
  buffer: { n: number } | null
  onended: (() => void) | null
  started: boolean
  stopped: boolean
}

const sources: FakeSource[] = []

class FakeContext {
  state = 'running'
  currentTime = 0
  destination = {}
  createGain() {
    return { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }
  }
  createBufferSource() {
    const source: FakeSource & { connect(): void; start(): void; stop(): void } = {
      buffer: null,
      onended: null,
      started: false,
      stopped: false,
      connect() {},
      start() {
        this.started = true
      },
      stop() {
        this.stopped = true
      },
    }
    sources.push(source)
    return source
  }
  async decodeAudioData(bytes: ArrayBuffer) {
    const n = new Uint8Array(bytes)[0]!
    if (n === 255) throw new Error('bad audio')
    return { n }
  }
  async resume() {}
  async suspend() {}
  async close() {}
}
;(globalThis as { AudioContext?: unknown }).AudioContext = FakeContext

const tick = () => new Promise((r) => setTimeout(r, 0))
const wav = (n: number) => btoa(String.fromCharCode(n))
const bytes = (n: number) => Uint8Array.of(n).buffer

/** What's playing now (the sentence number), or undefined. */
function playing(): number | undefined {
  const s = sources.at(-1)
  return s && s.started && !s.stopped && s.onended ? s.buffer!.n : undefined
}

/** The playing sentence ends. */
async function end(): Promise<void> {
  const s = sources.at(-1)!
  s.stopped = true
  s.onended?.()
  await tick()
}

function newPlayer() {
  sources.length = 0
  const states: PlayerState[] = []
  return { player: new SpeechPlayer((s) => states.push(s)), states }
}

test('a fetched replay plays in order, one sentence fetched ahead, and resolves at the end', async () => {
  const { player } = newPlayer()
  const asked: number[] = []
  let resolved = false
  const done = player.playFetched(3, async (i) => (asked.push(i), bytes(i))).then(() => (resolved = true))
  await tick()
  await tick()
  assert.equal(playing(), 0)
  assert.deepEqual(asked, [0, 1]) // not 2: only one ahead of the one playing
  await end()
  assert.equal(playing(), 1)
  await new Promise((r) => setTimeout(r, 150))
  assert.deepEqual(asked, [0, 1, 2])
  await end()
  assert.equal(playing(), 2)
  assert.equal(resolved, false)
  await end()
  await done
  assert.equal(playing(), undefined)
  assert.equal(player.playerState, 'idle')
})

test('a new live reply replaces a replay, stops its fetching and settles it', async () => {
  const { player } = newPlayer()
  let signal: AbortSignal | undefined
  const done = player.playFetched(5, async (i, s) => ((signal = s), bytes(i)))
  await tick()
  await tick()
  assert.equal(playing(), 0)
  player.add(7, 0, wav(70))
  await done
  assert.equal(signal?.aborted, true)
  await tick()
  assert.equal(playing(), 70)
})

test('a failed fetch rejects and stops the replay; cancel settles it', async () => {
  const { player } = newPlayer()
  await assert.rejects(
    player.playFetched(2, async () => {
      throw new Error('TTS is down')
    }),
    /TTS is down/,
  )
  const pending = player.playFetched(2, async (i) => bytes(i))
  await tick()
  await tick()
  player.cancel()
  await pending
  assert.equal(playing(), undefined)
})

test('repeat plays a kept reply again and resolves at its end; an undecodable sentence is skipped', async () => {
  const { player } = newPlayer()
  player.add(1, 0, wav(10))
  player.add(1, 1, wav(255))
  player.add(1, 2, wav(12))
  await tick()
  await tick()
  assert.equal(playing(), 10)
  await end()
  assert.equal(playing(), 12) // 11 couldn't be decoded
  await end()
  assert.equal(player.has(1), true)
  assert.equal(player.has(2), false)

  let resolved = false
  const again = player.repeat(1).then(() => (resolved = true))
  assert.equal(playing(), 10)
  await end()
  assert.equal(playing(), 12)
  assert.equal(resolved, false)
  await end()
  await again
})

test("an older reply's late sentences don't take over; a newer reply does", async () => {
  const { player } = newPlayer()
  player.add(5, 0, wav(50))
  await tick()
  player.add(4, 0, wav(40)) // superseded: never seen before, older
  await tick()
  assert.equal(playing(), 50)
  assert.equal(player.has(4), false)
  player.add(6, 0, wav(60))
  await tick()
  assert.equal(playing(), 60)
})
