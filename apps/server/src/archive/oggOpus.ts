// Encodes 16 kHz mono PCM into an Ogg Opus file (.opus), playable in browsers
// and standard tools.
//
// libopus-wasm produces raw Opus packets; the Ogg container around them is
// written here, following RFC 7845 (Ogg encapsulation for Opus) and RFC 3533
// (Ogg). It's small and fully specified, so it isn't worth a dependency.

import { Application, Signal, createEncoder } from 'libopus-wasm'

export const OPUS_BITRATE = 32000
const SAMPLE_RATE = 16000
/** 20 ms frames. */
const FRAME_SAMPLES = 320
/** Ogg granule positions for Opus are always counted at 48 kHz. */
const GRANULE_RATE = 48000
const GRANULE_PER_SAMPLE = GRANULE_RATE / SAMPLE_RATE
/** Roughly one second of packets per Ogg page. */
const PACKETS_PER_PAGE = 50
const VENDOR = 'jarvis (libopus-wasm)'

export const OPUS_FORMAT = `opus-${OPUS_BITRATE / 1000}k-${SAMPLE_RATE / 1000}khz-mono`

/**
 * Encodes one recording. `tags` become Vorbis comments (e.g. TITLE, DATE).
 * Recordings shorter than one 20 ms frame aren't trimmed exactly by every
 * decoder; phrases are always far longer.
 */
export async function encodeOggOpus(pcm: Int16Array, tags: Record<string, string> = {}): Promise<Uint8Array> {
  const encoder = await createEncoder({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    application: Application.Audio,
    signal: Signal.Voice,
    bitrate: OPUS_BITRATE,
    complexity: 10,
    frameSize: FRAME_SAMPLES,
  })
  try {
    // The encoder delays its output by `lookahead` samples. Feed that many
    // extra zeros so the end of the recording is encoded too; the decoder
    // skips the first `lookahead` samples (pre-skip) and the final granule
    // position trims the padding off the end.
    const lookahead = encoder.getLookahead()
    const padded = new Int16Array(Math.ceil((pcm.length + lookahead) / FRAME_SAMPLES) * FRAME_SAMPLES)
    padded.set(pcm)
    const packets: Uint8Array[] = []
    for (let i = 0; i < padded.length; i += FRAME_SAMPLES) {
      packets.push(encoder.encode(padded.subarray(i, i + FRAME_SAMPLES)))
    }

    const preSkip = lookahead * GRANULE_PER_SAMPLE
    const ogg = new OggWriter(randomSerial())
    ogg.writePage([opusHead(preSkip)], 0, { first: true })
    ogg.writePage([opusTags(tags)], 0)
    // Granule position = 48 kHz samples decoded up to the end of each page.
    // The last packet always gets its own final page: if the first audio page
    // were also the last, decoders disagree on whether its granule position
    // means "trim the start" or "trim the end". Because the padding is under
    // one frame plus the lookahead, the final granule is then never smaller
    // than the previous page's.
    const body = packets.slice(0, -1)
    for (let i = 0; i < body.length; i += PACKETS_PER_PAGE) {
      const pagePackets = body.slice(i, i + PACKETS_PER_PAGE)
      ogg.writePage(pagePackets, (i + pagePackets.length) * FRAME_SAMPLES * GRANULE_PER_SAMPLE)
    }
    ogg.writePage(packets.slice(-1), preSkip + pcm.length * GRANULE_PER_SAMPLE, { last: true })
    return ogg.bytes()
  } finally {
    encoder.free()
  }
}

/** RFC 7845 §5.1 identification header. */
function opusHead(preSkip: number): Uint8Array {
  const head = new Uint8Array(19)
  const view = new DataView(head.buffer)
  head.set(ascii('OpusHead'), 0)
  head[8] = 1 // version
  head[9] = 1 // channels
  view.setUint16(10, preSkip, true)
  view.setUint32(12, SAMPLE_RATE, true) // original input rate (informational)
  view.setInt16(16, 0, true) // output gain
  head[18] = 0 // channel mapping family 0: mono/stereo
  return head
}

/** RFC 7845 §5.2 comment header (Vorbis comment format). */
function opusTags(tags: Record<string, string>): Uint8Array {
  const vendor = utf8(VENDOR)
  const comments = Object.entries(tags).map(([key, value]) => utf8(`${key.toUpperCase()}=${value}`))
  const size = 8 + 4 + vendor.length + 4 + comments.reduce((sum, c) => sum + 4 + c.length, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let offset = 0
  out.set(ascii('OpusTags'), offset)
  offset += 8
  view.setUint32(offset, vendor.length, true)
  out.set(vendor, offset + 4)
  offset += 4 + vendor.length
  view.setUint32(offset, comments.length, true)
  offset += 4
  for (const comment of comments) {
    view.setUint32(offset, comment.length, true)
    out.set(comment, offset + 4)
    offset += 4 + comment.length
  }
  return out
}

class OggWriter {
  private readonly chunks: Uint8Array[] = []
  private sequence = 0
  private readonly serial: number

  constructor(serial: number) {
    this.serial = serial
  }

  /** Writes packets that start and end on this page (no continuation across pages). */
  writePage(packets: Uint8Array[], granule: number, flags: { first?: boolean; last?: boolean } = {}): void {
    const lacing: number[] = []
    for (const packet of packets) {
      let remaining = packet.length
      while (remaining >= 255) {
        lacing.push(255)
        remaining -= 255
      }
      lacing.push(remaining) // a final value < 255 ends the packet (0 if an exact multiple)
    }
    if (lacing.length > 255) throw new Error('Too many segments for one Ogg page')

    const bodyLength = packets.reduce((sum, p) => sum + p.length, 0)
    const page = new Uint8Array(27 + lacing.length + bodyLength)
    const view = new DataView(page.buffer)
    page.set(ascii('OggS'), 0)
    page[4] = 0 // stream structure version
    page[5] = (flags.first ? 0x02 : 0) | (flags.last ? 0x04 : 0)
    view.setBigUint64(6, BigInt(granule), true)
    view.setUint32(14, this.serial, true)
    view.setUint32(18, this.sequence++, true)
    view.setUint32(22, 0, true) // CRC, filled in below
    page[26] = lacing.length
    page.set(lacing, 27)
    let offset = 27 + lacing.length
    for (const packet of packets) {
      page.set(packet, offset)
      offset += packet.length
    }
    view.setUint32(22, oggCrc(page), true)
    this.chunks.push(page)
  }

  bytes(): Uint8Array {
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}

/** Ogg's CRC-32: polynomial 0x04c11db7, no reflection, initial value 0. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    table[i] = r >>> 0
  }
  return table
})()

function oggCrc(data: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < data.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[i]!) & 0xff]!) >>> 0
  return crc
}

function randomSerial(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0))
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
