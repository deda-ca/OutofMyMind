// HTTPS for the server itself, when nothing sits in front of it (the release
// binary). Browsers only allow the microphone on secure pages, the session
// cookie is Secure, and the Android app only talks https://.
//
//   TLS_CERT + TLS_KEY   your own certificate (PEM files)
//   TLS=self-signed      one made once with openssl, kept in DATA_DIR/tls
//   TLS=off              plain HTTP
//
// A self-signed certificate is trusted once per device: the browser asks, and
// the Android app shows its SHA-256 fingerprint to pin (logged at start-up).

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface Tls {
  key: Buffer
  cert: Buffer
  /** SHA-256 of the certificate, AA:BB:… (what the Android app pins). */
  fingerprint: string
  /** Where it came from, for the log. */
  source: string
}

export interface TlsSettings {
  tls: string
  tlsCert: string | null
  tlsKey: string | null
  dataDir: string
}

export function loadTls(s: TlsSettings): Tls | null {
  if (s.tlsCert || s.tlsKey) {
    if (!s.tlsCert || !s.tlsKey) throw new Error('TLS_CERT and TLS_KEY go together')
    return read(s.tlsKey, s.tlsCert, s.tlsCert)
  }
  if (/^(0|off|false|no)$/i.test(s.tls)) return null
  if (s.tls !== 'self-signed') throw new Error(`TLS must be "off" or "self-signed" (or set TLS_CERT and TLS_KEY), not "${s.tls}"`)
  const dir = path.join(s.dataDir, 'tls')
  const key = path.join(dir, 'key.pem')
  const cert = path.join(dir, 'cert.pem')
  if (!fs.existsSync(key) || !fs.existsSync(cert)) selfSign(dir, key, cert)
  return read(key, cert, `self-signed, ${cert}`)
}

function read(keyFile: string, certFile: string, source: string): Tls {
  const cert = fs.readFileSync(certFile)
  return { key: fs.readFileSync(keyFile), cert, fingerprint: new crypto.X509Certificate(cert).fingerprint256, source }
}

/** A certificate for this machine's names and addresses (as they are now), valid 825 days (Apple's limit). */
function selfSign(dir: string, keyFile: string, certFile: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal && a.family === 'IPv4')
    .map((a) => `IP:${a!.address}`)
  const names = [...new Set(['DNS:localhost', `DNS:${os.hostname()}`, 'IP:127.0.0.1', ...addresses])]
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '825', '-subj', '/CN=Jarvis', '-addext', `subjectAltName=${names.join(',')}`, '-keyout', keyFile, '-out', certFile],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
  } catch (err) {
    fs.rmSync(keyFile, { force: true })
    fs.rmSync(certFile, { force: true })
    const why = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'openssl is not installed' : String((err as { stderr?: Buffer }).stderr ?? err).trim()
    throw new Error(`can't make a self-signed certificate (${why}): install openssl, set TLS_CERT and TLS_KEY, or TLS=off`)
  }
  fs.chmodSync(keyFile, 0o600)
}
