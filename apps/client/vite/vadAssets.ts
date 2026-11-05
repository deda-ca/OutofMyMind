// Serves the files Silero VAD needs at runtime from node_modules under /vad/:
// the ONNX model, the VAD audio worklet, and the ONNX Runtime WebAssembly build.
// Everything comes from this machine; nothing is fetched from a CDN.

import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

export const VAD_ASSET_PREFIX = '/vad/'

const VAD_DIR = 'node_modules/@ricky0123/vad-web/dist'
const ORT_DIR = 'node_modules/onnxruntime-web/dist'

const ASSETS: Record<string, string> = {
  'silero_vad_v5.onnx': VAD_DIR,
  'vad.worklet.bundle.min.js': VAD_DIR,
  'ort-wasm-simd-threaded.mjs': ORT_DIR,
  'ort-wasm-simd-threaded.wasm': ORT_DIR,
}

const CONTENT_TYPES: Record<string, string> = {
  '.onnx': 'application/octet-stream',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
}

export function vadAssets(root: string): Plugin {
  const resolve = (name: string) => path.join(root, ASSETS[name]!, name)
  return {
    name: 'jarvis-vad-assets',
    configureServer(server) {
      // Registered directly (not via a returned hook) so it runs before Vite's
      // own transforms, which would otherwise rewrite the .mjs file.
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '', 'http://localhost').pathname
        if (!pathname.startsWith(VAD_ASSET_PREFIX)) return next()
        const name = pathname.slice(VAD_ASSET_PREFIX.length)
        if (!Object.hasOwn(ASSETS, name)) return next()
        const file = resolve(name)
        if (!fs.existsSync(file)) {
          res.statusCode = 404
          res.end(`Missing ${name}: run npm install in apps/client`)
          return
        }
        res.setHeader('Content-Type', CONTENT_TYPES[path.extname(name)] ?? 'application/octet-stream')
        fs.createReadStream(file)
          .on('error', () => res.destroy())
          .pipe(res)
      })
    },
    generateBundle() {
      for (const name of Object.keys(ASSETS)) {
        this.emitFile({ type: 'asset', fileName: `vad/${name}`, source: fs.readFileSync(resolve(name)) })
      }
    },
  }
}
