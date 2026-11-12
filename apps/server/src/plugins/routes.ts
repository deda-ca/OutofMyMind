// The plugin platform's HTTP side (docs/plugins.md):
//   GET  /api/plugins                       the self-contained plugins: name, description, running, tab
//   POST /api/plugins/:name/call/:tool      {args}: a plugin's tool, called by the owner from its tab (no
//                                           confirmation gate: pressing the button is their yes)
//   GET  /plugin-ui/:name/…                 a plugin's tab page and its files (static code only, no data:
//                                           outside /api, so a sandboxed frame can load it)
//   GET  /plugin-ui/kit/bridge.js, style.css   shared by every tab: the bridge to its tools, one look
//
// A tab runs in a sandboxed iframe (no same-origin): it can't read the
// owner's cookies or call the API itself. It asks the Jarvis page that hosts
// it (client: PluginTab.vue), which calls only that plugin's tools.

import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { harness } from '../harness/index.ts'
import { tabStatusOf } from './index.ts'

// The release binary unpacks the kit (JARVIS_PLATFORM_KIT); in development it's next to this file.
const KIT = process.env.JARVIS_PLATFORM_KIT?.trim() || path.join(import.meta.dirname, 'kit')
/** What a tab's files may be (the workspace viewer never serves HTML or scripts; a tab is made of them). */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}
/** What a tab page may load: its own files and the kit; no other site, no direct API calls (connect-src). */
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self'; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"

export async function pluginRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/plugins', async () => ({
    plugins: harness.manifests().map(({ manifest: m, connected }) => ({
      name: m.name,
      description: m.description,
      connected,
      // The tab's folder is served at /plugin-ui/<name>/, so the page is its file name there.
      tab: m.tab ? { title: m.tab.title, url: `/plugin-ui/${m.name}/${path.basename(m.tab.page)}`, ...(m.tab.icon ? { icon: m.tab.icon } : {}) } : null,
      status: tabStatusOf(m.name),
      events: Object.entries(m.events).map(([type, e]) => ({ type, description: e.description, trigger: Boolean(e.trigger) })),
    })),
  }))

  app.post<{ Params: { name: string; tool: string }; Body: { args?: unknown } }>('/api/plugins/:name/call/:tool', async (req, reply) => {
    const m = harness.manifests().find((x) => x.manifest.name === req.params.name)?.manifest
    if (!m) return reply.code(404).send({ error: `No plugin "${req.params.name}".` })
    const args = req.body?.args && typeof req.body.args === 'object' && !Array.isArray(req.body.args) ? (req.body.args as Record<string, unknown>) : {}
    return harness.callAsOwner(m.name, req.params.tool, args)
  })

  app.get<{ Params: { name: string; '*': string } }>('/plugin-ui/:name/*', async (req, reply) => {
    const rel = req.params['*'] || ''
    let root: string
    if (req.params.name === 'kit') root = KIT
    else {
      const m = harness.manifests().find((x) => x.manifest.name === req.params.name)?.manifest
      if (!m?.tab) return reply.code(404).send('No such tab.')
      root = path.join(m.dir, path.dirname(m.tab.page))
    }
    const file = path.resolve(root, rel)
    const type = TYPES[path.extname(file).toLowerCase()]
    if (!type || !file.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return reply.code(404).send('Not found.')
    return reply
      .header('Content-Type', type)
      .header('Content-Security-Policy', CSP)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-cache')
      .send(fs.createReadStream(file))
  })
}
