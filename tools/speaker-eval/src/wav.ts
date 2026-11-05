// Minimal 16-bit mono WAV read/write.

import fs from 'node:fs'

export function writeWav(file: string, samples: Float32Array, sampleRate: number): void {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    data.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([header, data]))
}

/** Reads a 16-bit mono PCM WAV written by writeWav (or any canonical 44-byte-header WAV). */
export function readWav(file: string): { samples: Float32Array; sampleRate: number } {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.readUInt16LE(22) !== 1 || buf.readUInt16LE(34) !== 16) {
    throw new Error(`${file}: expected 16-bit mono WAV`)
  }
  const dataStart = buf.indexOf('data', 12) + 8
  const count = (buf.length - dataStart) >> 1
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i++) samples[i] = buf.readInt16LE(dataStart + i * 2) / 32768
  return { samples, sampleRate: buf.readUInt32LE(24) }
}
