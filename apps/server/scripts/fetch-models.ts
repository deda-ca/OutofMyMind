// Downloads the voiceprint (speaker-embedding) model into models/ and checks
// its SHA-256 against sherpa-onnx's published checksum.
//
// Model: 3D-Speaker CAM++ (VoxCeleb, English), chosen in docs/speaker-model-eval.md.
// Usage: npm run fetch-models

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models'
const FILE = '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx'
const SHA256 = '357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b'

const target = path.resolve('models', FILE)
fs.mkdirSync(path.dirname(target), { recursive: true })
if (!fs.existsSync(target)) {
  console.log(`downloading ${FILE} …`)
  const response = await fetch(`${RELEASE}/${FILE}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  fs.writeFileSync(target, new Uint8Array(await response.arrayBuffer()))
}
const actual = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
if (actual !== SHA256) {
  fs.unlinkSync(target)
  throw new Error(`checksum mismatch (file deleted): expected ${SHA256}, got ${actual}`)
}
console.log(`ok: ${target}`)
