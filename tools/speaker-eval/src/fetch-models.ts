// Downloads the speaker-embedding models to compare, from sherpa-onnx's GitHub
// release, and checks each against the release's SHA-256 checksums.
//
// Usage: node src/fetch-models.ts

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { MODELS } from './models.ts'

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models'
const OUT = path.resolve('models')

const checksums = new Map(
  (await (await fetch(`${RELEASE}/checksum.txt`)).text())
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/) as [string, string])
    .map(([name, hash]) => [name, hash]),
)

fs.mkdirSync(OUT, { recursive: true })
for (const model of MODELS) {
  const file = path.join(OUT, model.file)
  const expected = checksums.get(model.file)
  if (!expected) throw new Error(`No checksum published for ${model.file}`)
  if (!fs.existsSync(file)) {
    process.stdout.write(`downloading ${model.file} … `)
    const response = await fetch(`${RELEASE}/${encodeURIComponent(model.file)}`)
    if (!response.ok) throw new Error(`${response.status} for ${model.file}`)
    fs.writeFileSync(file, new Uint8Array(await response.arrayBuffer()))
  } else {
    process.stdout.write(`have ${model.file} … `)
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (actual !== expected) {
    fs.unlinkSync(file)
    throw new Error(`${model.file}: checksum mismatch (deleted). Expected ${expected}, got ${actual}`)
  }
  console.log(`ok (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`)
}
