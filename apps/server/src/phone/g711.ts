// G.711 μ-law (PCMU), the phone network's codec, and the 8 ⇄ 16 kHz
// conversion between it and the rest of Jarvis (which works at 16 kHz).

const BIAS = 0x84
const CLIP = 32635

/** μ-law byte → 16-bit sample. */
const DECODE = new Int16Array(256)
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff
  const exponent = (u >> 4) & 0x07
  const mantissa = u & 0x0f
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS
  DECODE[i] = u & 0x80 ? -magnitude : magnitude
}

export function ulawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = DECODE[bytes[i]!]!
  return out
}

export function ulawEncode(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i]!
    const sign = s < 0 ? 0x80 : 0
    if (sign) s = -s
    if (s > CLIP) s = CLIP
    s += BIAS
    let exponent = 7
    for (let mask = 0x4000; exponent > 0 && (s & mask) === 0; mask >>= 1) exponent--
    const mantissa = (s >> (exponent + 3)) & 0x0f
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff
  }
  return out
}

/**
 * 8 kHz → 16 kHz, one stream: each output pair is a sample and the midpoint
 * to the next. Keeps the last sample between calls, so frames join smoothly.
 */
export class Upsampler {
  private last = 0

  process(input: Int16Array): Int16Array {
    const out = new Int16Array(input.length * 2)
    for (let i = 0; i < input.length; i++) {
      const s = input[i]!
      out[2 * i] = (this.last + s) >> 1
      out[2 * i + 1] = s
      this.last = s
    }
    return out
  }
}

/**
 * 16 kHz → 8 kHz, one stream: a short low-pass (taps 1-2-1 over three
 * samples, keeping the two before each frame) then every other sample. Enough
 * for a phone line, whose audio stops at 3.4 kHz anyway.
 */
export class Downsampler {
  private prev = 0

  process(input: Int16Array): Int16Array {
    const out = new Int16Array(input.length >> 1)
    for (let i = 0; i < out.length; i++) {
      const a = 2 * i === 0 ? this.prev : input[2 * i - 1]!
      const b = input[2 * i]!
      const c = input[2 * i + 1]!
      out[i] = (a + 2 * b + c) >> 2
    }
    this.prev = input[input.length - 1] ?? 0
    return out
  }
}
