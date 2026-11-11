// The built web client (apps/client/dist), served at / when SITE_DIR is set:
// the release binary serves it itself. In development Vite serves it instead.

import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

export function siteRoutes(app: FastifyInstance, dir: string): void {
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error(`SITE_DIR ${dir} has no index.html (build the client: npm --prefix apps/client run build)`)
  const root = fs.realpathSync(dir)

  /** The file for a URL path, or null; never outside root. */
  function find(urlPath: string): string | null {
    const file = path.join(root, path.normalize(`/${urlPath}`))
    try {
      const real = fs.realpathSync(file)
      return (real === root || real.startsWith(root + path.sep)) && fs.statSync(real).isFile() ? real : null
    } catch {
      return null
    }
  }

  app.get('/*', async (req, reply) => {
    const urlPath = (req.params as { '*': string })['*']
    if (urlPath === 'api' || urlPath.startsWith('api/')) return reply.code(404).send({ error: 'Not found' })
    // A path without an extension is a page of the app: index.html.
    const file = find(urlPath) ?? (path.extname(urlPath) ? null : path.join(root, 'index.html'))
    if (!file) return reply.code(404).type('text/plain').send('Not found')
    // Vite puts a content hash in every name under assets/: those never change.
    reply.header('Cache-Control', urlPath.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    return reply.type(TYPES[path.extname(file)] ?? 'application/octet-stream').send(fs.createReadStream(file))
  })
}
