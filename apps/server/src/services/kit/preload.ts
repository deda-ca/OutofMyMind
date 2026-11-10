// Loaded before a service's code, inside its sandbox (node --import): routes
// Node's TCP and TLS connections through the gate's tunnel, so libraries
// (imapflow, the global fetch, http/https) work unchanged, and makes
// `import … from 'jarvis:service'` find the kit. The sandbox has no network
// of its own: this is for convenience and clear errors, not for security.

import { registerHooks, syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'

const TUNNEL = process.env.JARVIS_TUNNEL ?? '/run/jarvis/tunnel.sock'
const HOSTS = new Set((process.env.JARVIS_HOSTS ?? '').split(',').filter(Boolean))
const original = { connect: net.connect, tlsConnect: tls.connect }

type Options = { host?: string; port?: number | string; path?: string; socket?: unknown; servername?: string; [key: string]: unknown }

/** net.connect's many call shapes → options. */
function options(args: unknown[]): Options {
  const [a, b] = args
  if (typeof a === 'object' && a !== null) return a as Options
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) return { port: Number(a), host: typeof b === 'string' ? b : 'localhost' }
  return { path: String(a) }
}

/** A socket to host:port through the gate (or one that fails at once, saying why). */
export function tunnel(host: string, port: number): net.Socket {
  const target = `${host.toLowerCase()}:${port}`
  if (!HOSTS.has(target)) {
    const s = new net.Socket()
    const err = Object.assign(new Error(`This service may not connect to ${target}: add it to "hosts" in its service.md (the owner approves).`), { code: 'ECONNREFUSED' })
    process.nextTick(() => s.destroy(err))
    return s
  }
  const s = original.connect({ path: TUNNEL })
  s.write(`${target}\n`)
  return s
}

function patchedConnect(...args: unknown[]): net.Socket {
  const o = options(args)
  if (o.path) return (original.connect as (...a: unknown[]) => net.Socket)(...args)
  const callback = args.find((x) => typeof x === 'function') as (() => void) | undefined
  const s = tunnel(o.host ?? 'localhost', Number(o.port))
  if (callback) s.once('connect', callback)
  if (typeof o.timeout === 'number') s.setTimeout(o.timeout)
  return s
}

function patchedTlsConnect(...args: unknown[]): tls.TLSSocket {
  const o = options(args)
  const callback = args.find((x) => typeof x === 'function') as (() => void) | undefined
  if (o.socket || o.path) return (original.tlsConnect as (...a: unknown[]) => tls.TLSSocket)(...args)
  const host = o.host ?? 'localhost'
  const port = Number(o.port ?? 443)
  return original.tlsConnect({ ...(o as tls.ConnectionOptions), host, port, socket: tunnel(host, port), servername: o.servername ?? (net.isIP(host) ? undefined : host) }, callback)
}

net.connect = patchedConnect as typeof net.connect
net.createConnection = patchedConnect as typeof net.createConnection
tls.connect = patchedTlsConnect as typeof tls.connect
syncBuiltinESMExports()

const KIT = new URL('./service.ts', import.meta.url).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'jarvis:service') return { url: KIT, shortCircuit: true }
    return next(specifier, context)
  },
})
