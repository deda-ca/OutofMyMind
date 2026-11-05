// Checks the Ogg Opus writer against an independent decoder (ogg-opus-decoder).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { OggOpusDecoder } from 'ogg-opus-decoder'
import { encodeOggOpus } from '../src/archive/oggOpus.ts'

/** A 2 s synthetic "voice-like" signal: a few harmonics with a slow envelope. */
function syntheticSpeech(seconds = 2, rate = 16000): Int16Array {
  const out = new Int16Array(seconds * rate)
  for (let i = 0; i < out.length; i++) {
    const t = i / rate
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)
    const f0 = 140 + 20 * Math.sin(2 * Math.PI * 0.7 * t)
    let s = 0
    for (let h = 1; h <= 8; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h
    out[i] = Math.round(6000 * envelope * s)
  }
  return out
}

async function decode(file: Uint8Array) {
  const decoder = new OggOpusDecoder()
  await decoder.ready
  try {
    return await decoder.decodeFile(file)
  } finally {
    decoder.free()
  }
}

/** Correlation between the original (16 kHz) and the decoded audio (48 kHz, every 3rd sample). */
function correlation(original: Int16Array, decoded48k: Float32Array): number {
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < original.length; i++) {
    const x = original[i]! / 32768
    const y = decoded48k[i * 3] ?? 0
    sxy += x * y
    sxx += x * x
    syy += y * y
  }
  return sxy / Math.sqrt(sxx * syy)
}

test('round-trips through an independent decoder with exact length', async () => {
  const pcm = syntheticSpeech()
  const file = await encodeOggOpus(pcm, { title: 'test' })
  const decoded = await decode(file)
  assert.equal(decoded.errors.length, 0, JSON.stringify(decoded.errors))
  assert.equal(decoded.sampleRate, 48000)
  assert.equal(decoded.samplesDecoded, pcm.length * 3, 'pre-skip and end trimming give the exact length')
  const r = correlation(pcm, decoded.channelData[0]!)
  assert.ok(r > 0.9, `decoded audio should match the original (correlation ${r.toFixed(3)})`)
})

test('size is about 32 kbps', async () => {
  const pcm = syntheticSpeech(10)
  const file = await encodeOggOpus(pcm)
  const kbps = (file.length * 8) / 10 / 1000
  assert.ok(kbps > 20 && kbps < 45, `bitrate ${kbps.toFixed(1)} kbps`)
})

test('exact length at frame and page boundaries', async () => {
  // 20 ms frames (320 samples), 50 packets per page; phrases are at least ~250 ms.
  for (const length of [320, 321, 639, 640, 1600, 16000, 16001, 16320, 32000]) {
    const decoded = await decode(await encodeOggOpus(new Int16Array(length)))
    assert.equal(decoded.samplesDecoded, length * 3, `length ${length}`)
  }
})

test('real speech sample, if available', { skip: !fs.existsSync(process.env.SPEECH_PCM ?? '') }, async () => {
  const pcm = new Int16Array(fs.readFileSync(process.env.SPEECH_PCM!).buffer.slice(0))
  const file = await encodeOggOpus(pcm)
  const decoded = await decode(file)
  assert.equal(decoded.samplesDecoded, pcm.length * 3)
  const r = correlation(pcm, decoded.channelData[0]!)
  console.log(`speech: ${(pcm.length / 16000).toFixed(1)} s → ${(file.length / 1024).toFixed(1)} KB, correlation ${r.toFixed(3)}`)
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, file)
  assert.ok(r > 0.8)
})
