// The gate (docs/services.md): a service's only way out of its sandbox. Two
// Unix sockets per run, in a private temporary folder bound into the sandbox
// at /run/jarvis:
//
//   tunnel.sock  The service writes "host:port\n", then its own bytes. If the
//                approved manifest lists host:port and it resolves to a
//                public address, the bytes are piped there; otherwise the
//                connection is closed and the refusal logged.
//   api.sock     HTTP: GET /secret/<name>, POST /emit {event, payload}.
//
// The temporary folder's path is short on purpose: Unix socket paths are
// limited to 108 bytes, and DATA_DIR may be longer.

import dns from 'node:dns'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export interface GateOptions {
  /** "host:port" the service may reach. */
  hosts: string[]
  /** "host:port" that may resolve to a private address (SERVICES_LOCAL_HOSTS). */
  localHosts?: string[]
  /** A secret's value, if the service may read it and it's set: undefined (not allowed), null (not set). */
  secret: (name: string) => string | null | undefined
  /** An event; returns an HTTP status (202 taken, 403 not in the manifest, 429 over a limit). */
  emit: (event: string, payload: unknown) => { status: number; message: string }
  log: (line: string) => void
  /** Resolves a host (tests). */
  lookup?: (host: string) => Promise<string[]>
}

export interface GateStats {
  connections: number
  refused: number
  bytesOut: number
  bytesIn: number
  secretsRead: string[]
  events: number
}

const MAX_CONNECTIONS = 200
const MAX_PAYLOAD = 32 * 1024

const PRIVATE = new net.BlockList()
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) PRIVATE.addSubnet(a, p, 'ipv4')
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(a, p, 'ipv6')

/** Loopback, LAN, link-local and other non-public addresses. Not an IP: true. */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) return PRIVATE.check(ip, 'ipv4')
  if (family === 6) return PRIVATE.check(ip, 'ipv6')
  return true
}

const systemLookup = async (host: string) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address)

export class Gate {
  /** The folder to bind at /run/jarvis. */
  readonly dir: string
  readonly stats: GateStats = { connections: 0, refused: 0, bytesOut: 0, bytesIn: 0, secretsRead: [], events: 0 }
  private readonly o: GateOptions
  private readonly tunnel: net.Server
  private readonly api: http.Server
  private readonly sockets = new Set<net.Socket>()

  private constructor(o: GateOptions, dir: string) {
    this.o = o
    this.dir = dir
    this.tunnel = net.createServer((c) => this.onTunnel(c))
    this.api = http.createServer((req, res) => void this.onApi(req, res))
  }

  static async open(o: GateOptions): Promise<Gate> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-'))
    fs.chmodSync(dir, 0o700)
    const gate = new Gate(o, dir)
    await Promise.all([listen(gate.tunnel, path.join(dir, 'tunnel.sock')), listen(gate.api, path.join(dir, 'api.sock'))])
    return gate
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    this.api.closeAllConnections()
    await Promise.all([new Promise((r) => this.tunnel.close(r)), new Promise((r) => this.api.close(r))])
    fs.rmSync(this.dir, { recursive: true, force: true })
  }

  private onTunnel(client: net.Socket): void {
    this.track(client)
    let head = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const nl = head.indexOf(10)
      if (nl === -1) {
        if (head.length > 300) client.destroy()
        return
      }
      client.off('data', onData)
      client.pause() // nothing is lost while the connection opens
      const target = head.subarray(0, nl).toString('utf8').trim().toLowerCase()
      void this.connect(client, target, head.subarray(nl + 1))
    }
    client.on('data', onData)
    client.on('error', () => client.destroy())
  }

  private async connect(client: net.Socket, target: string, early: Buffer): Promise<void> {
    const refuse = (why: string) => {
      this.stats.refused++
      this.o.log(`gate: refused a connection to ${target || '(nothing)'}: ${why}`)
      client.destroy()
    }
    const m = /^(.+):(\d{1,5})$/.exec(target)
    if (!m) return refuse('not host:port')
    if (!this.o.hosts.includes(target)) return refuse("it isn't in the manifest's hosts")
    if (this.stats.connections >= MAX_CONNECTIONS) return refuse(`more than ${MAX_CONNECTIONS} connections in one run`)
    const host = m[1]!
    const port = Number(m[2])
    let addresses: string[]
    try {
      addresses = net.isIP(host) ? [host] : await (this.o.lookup ?? systemLookup)(host)
    } catch (err) {
      return refuse(`couldn't look up ${host} (${(err as Error).message})`)
    }
    const local = this.o.localHosts?.includes(target) ?? false
    const allowed = local ? addresses : addresses.filter((a) => !isPrivateAddress(a))
    if (!allowed.length) return refuse(`${host} is a private address (${addresses.join(', ')}); add it to SERVICES_LOCAL_HOSTS to allow it`)
    this.stats.connections++
    const upstream = net.connect({ host: allowed[0]!, port })
    this.track(upstream)
    upstream.once('connect', () => {
      if (early.length) {
        this.stats.bytesOut += early.length
        upstream.write(early)
      }
      client.on('data', (d: Buffer) => (this.stats.bytesOut += d.length))
      upstream.on('data', (d: Buffer) => (this.stats.bytesIn += d.length))
      client.pipe(upstream)
      upstream.pipe(client)
      client.resume()
    })
    upstream.on('error', (err) => {
      this.o.log(`gate: ${target}: ${err.message}`)
      client.destroy()
    })
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  }

  private async onApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: string): void => void res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(body)
    const url = new URL(req.url ?? '/', 'http://gate')
    const secret = /^\/secret\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && secret) {
      const name = decodeURIComponent(secret[1]!)
      const value = this.o.secret(name)
      if (value === undefined) {
        this.o.log(`gate: refused the secret "${name}": it isn't in the manifest's secrets`)
        return send(403, `This service may not read the secret "${name}" (not in its manifest's secrets).`)
      }
      if (value === null) return send(404, `The secret "${name}" hasn't been set yet: the owner types it in the Services tab.`)
      if (!this.stats.secretsRead.includes(name)) this.stats.secretsRead.push(name)
      return send(200, value)
    }
    if (req.method === 'POST' && url.pathname === '/emit') {
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > MAX_PAYLOAD) return send(413, `An event is at most ${MAX_PAYLOAD / 1024} KB.`)
        chunks.push(chunk)
      }
      let body: { event?: unknown; payload?: unknown }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      } catch {
        return send(400, 'Send JSON: {"event": "...", "payload": {...}}')
      }
      if (typeof body.event !== 'string' || !body.event) return send(400, 'The event needs a name.')
      this.stats.events++
      const result = this.o.emit(body.event, body.payload ?? null)
      return send(result.status, result.message)
    }
    send(404, 'Not here.')
  }

  private track(s: net.Socket): void {
    this.sockets.add(s)
    s.on('close', () => this.sockets.delete(s))
  }
}

function listen(server: net.Server, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(file, () => {
      fs.chmodSync(file, 0o600)
      resolve()
    })
  })
}
