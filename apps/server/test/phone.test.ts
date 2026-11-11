import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bridge, type Leg } from '../src/phone/bridge.ts'
import { Downsampler, Upsampler, ulawDecode, ulawEncode } from '../src/phone/g711.ts'
import { display, NumberError, sameNumber, toE164 } from '../src/phone/numbers.ts'
import type { Phone } from '../src/phone/phone.ts'
import { DeviceLeg } from '../src/phone/phone.ts'
import { buildSdp, digestAuthorization, displayNameOf, header, parseSdp, parseSip, response, serialize, tagOf, userOf } from '../src/phone/sip.ts'
import { phoneTools } from '../src/phone/tools.ts'
import { formatTranscript, utterances } from '../src/phone/transcript.ts'

test('μ-law: decode∘encode stays within the codec\'s step size', () => {
  const samples = Int16Array.from({ length: 2000 }, (_, i) => Math.round(30000 * Math.sin(i / 7)))
  const back = ulawDecode(ulawEncode(samples))
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!
    assert.ok(Math.abs(back[i]! - s) <= Math.max(16, Math.abs(s) / 16), `${s} → ${back[i]}`)
  }
  // Silence is the codec's 0xFF.
  assert.equal(ulawEncode(new Int16Array([0]))[0], 0xff)
})

test('resampling: 8 kHz → 16 kHz → 8 kHz keeps a tone', () => {
  const tone8 = Int16Array.from({ length: 160 }, (_, i) => Math.round(10000 * Math.sin((2 * Math.PI * 400 * i) / 8000)))
  const up = new Upsampler().process(tone8)
  assert.equal(up.length, 320)
  const down = new Downsampler().process(up)
  assert.equal(down.length, 160)
  // The round trip delays by half a sample (inaudible); otherwise the tone is intact.
  for (let i = 4; i < 156; i++) assert.ok(Math.abs(down[i]! - 10000 * Math.sin((2 * Math.PI * 400 * (i - 0.5)) / 8000)) < 300, `sample ${i}`)
})

test('SIP: parses a response with compact and folded headers, and builds one back', () => {
  const text = [
    'SIP/2.0 401 Unauthorized',
    'v: SIP/2.0/UDP 10.0.0.2:5060;branch=z9hG4bKabc;rport=55591;received=172.20.0.5',
    'From: <sip:100_jarvis@toronto2.voip.ms>;tag=111',
    'To: <sip:100_jarvis@toronto2.voip.ms>;tag=222',
    'Call-ID: x@y',
    'CSeq: 1 REGISTER',
    'WWW-Authenticate: Digest algorithm=MD5, realm="voip.ms",',
    ' nonce="abc"',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n')
  const m = parseSip(text)!
  assert.equal(m.status, 401)
  assert.match(header(m, 'via'), /received=172\.20\.0\.5/)
  assert.equal(header(m, 'www-authenticate'), 'Digest algorithm=MD5, realm="voip.ms", nonce="abc"')
  assert.equal(tagOf(header(m, 'to')), '222')
  const again = parseSip(serialize(m))!
  assert.equal(header(again, 'call-id'), 'x@y')
})

test('SIP: an INVITE with SDP; a response copies the dialog headers and adds a To tag', () => {
  const sdp = buildSdp({ ip: '172.20.0.5', port: 12000, sessionId: '1' })
  const invite = [
    'INVITE sip:123456_jarvis@172.20.0.5:55591 SIP/2.0',
    'Via: SIP/2.0/UDP 208.100.60.51:5060;branch=z9hG4bK1',
    'From: "Dr Smith" <sip:6135550123@208.100.60.51>;tag=abc',
    'To: <sip:6135550100@toronto2.voip.ms>',
    'Call-ID: call-1',
    'CSeq: 102 INVITE',
    'Content-Type: application/sdp',
    `Content-Length: ${Buffer.byteLength(sdp)}`,
    '',
    sdp,
  ].join('\r\n')
  const m = parseSip(invite)!
  assert.equal(m.method, 'INVITE')
  assert.equal(userOf(header(m, 'from')), '6135550123')
  assert.equal(displayNameOf(header(m, 'from')), 'Dr Smith')
  const media = parseSdp(m.body)!
  assert.deepEqual(media, { ip: '172.20.0.5', port: 12000, pcmu: true, onHold: false, dtmfPayload: 101 })
  const ok = response(m, 200, 'OK', [], '', 'mytag')
  assert.equal(header(ok, 'to'), '<sip:6135550100@toronto2.voip.ms>;tag=mytag')
  assert.equal(header(ok, 'cseq'), '102 INVITE')
})

test('digest: the worked example of RFC 2617', () => {
  const auth = digestAuthorization({
    challenge: 'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    method: 'GET',
    uri: '/dir/index.html',
    username: 'Mufasa',
    password: 'Circle Of Life',
    cnonce: '0a4f113b',
  })
  assert.match(auth, /response="6629fae49393a05397450978507c4ef1"/)
  assert.match(auth, /qop=auth, nc=00000001, cnonce="0a4f113b"/)
})

test('SDP: hold is noticed', () => {
  assert.equal(parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 4000 RTP/AVP 0\r\na=sendonly\r\n')!.onHold, true)
  assert.equal(parseSdp('v=0\r\nc=IN IP4 0.0.0.0\r\nm=audio 4000 RTP/AVP 0\r\n')!.onHold, true)
  assert.equal(parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 4000 RTP/AVP 18\r\n')!.pcmu, false)
})

test('numbers: North American only, never 911, N11 or premium rate', () => {
  assert.equal(toE164('613-555-0123'), '16135550123')
  assert.equal(toE164('+1 (613) 555 0123'), '16135550123')
  assert.equal(toE164('1 613 555 0123'), '16135550123')
  for (const bad of ['911', '+1 911', '411', '613-911-1234', '900-555-1234', '+44 20 7946 0958', '011 44 20 7946 0958', '555-0123', '013-555-0123'])
    assert.throws(() => toE164(bad), NumberError, bad)
  assert.equal(display('16135550123'), '+1 613-555-0123')
  assert.ok(sameNumber('613-555-0123', '16135550123'))
})

test('bridge: each leg hears the others, never itself, and every leg is recorded', () => {
  const frame = (v: number) => new Int16Array(320).fill(v)
  const heard: Record<string, number[]> = { a: [], b: [], c: [] }
  const leg = (name: string, v: number): Leg => ({ name, read: () => frame(v), write: (f) => heard[name]!.push(f[0]!) })
  const a = leg('a', 100)
  const b = leg('b', 20)
  const c = leg('c', 3)
  const bridge = new Bridge()
  bridge.join(a)
  bridge.join(b)
  bridge.tick()
  bridge.join(c)
  bridge.tick()
  assert.deepEqual(heard, { a: [20, 23], b: [100, 103], c: [120] })
  bridge.mute(a, true)
  bridge.tick()
  assert.equal(heard.b.at(-1), 3)
  const rec = bridge.recordings()
  assert.deepEqual(rec.map((r) => [r.name, r.offsetMs, r.pcm.length]), [['a', 0, 960], ['b', 0, 960], ['c', 20, 640]])
})

test('device leg: cuts what arrives into 20 ms frames and waits for a little before playing', () => {
  const leg = new DeviceLeg('Owner', () => {})
  leg.push(new Int16Array(500).fill(1))
  assert.equal(leg.read(), null)
  leg.push(new Int16Array(500).fill(1))
  assert.equal(leg.read()?.length, 320)
})

test('transcript: speech is found against the leg\'s own noise floor, and legs interleave by time', () => {
  const pcm = new Int16Array(16000 * 5)
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round((Math.random() - 0.5) * 100)
  for (let i = 16000; i < 16000 * 2; i++) pcm[i] = Math.round(5000 * Math.sin(i / 5))
  for (let i = 16000 * 3; i < 16000 * 3.5; i++) pcm[i] = Math.round(5000 * Math.sin(i / 5))
  const found = utterances(pcm, 1000)
  assert.equal(found.length, 2)
  assert.ok(Math.abs(found[0]!.startMs - 2000) <= 200)
  assert.ok(Math.abs(found[1]!.startMs - 4000) <= 200)
  assert.equal(formatTranscript([{ atMs: 65_000, who: 'Owner', text: 'Thursday works.' }, { atMs: 3000, who: '+1 613-555-0123', text: 'Hello?' }]), '- [00:03] **+1 613-555-0123:** Hello?\n- [01:05] **Owner:** Thursday works.')
})

test('call tool: nothing is dialled without a code, and the code needs the owner to have spoken since', async () => {
  const dialled: string[] = []
  const fake = { dial: async (n: string) => (dialled.push(n), { display: display(n) }), view: () => null, recent: () => [] } as unknown as Phone
  let heard: number | null = null
  const [call] = phoneTools({ phone: fake, lastHeard: () => heard, kindOn: () => true })
  const first = await call!.run({ number: '613-555-0123', who: 'Dentist' })
  assert.equal(first.isError, false)
  assert.equal(dialled.length, 0)
  const code = /confirm "([0-9a-f]+)"/.exec(first.text)![1]!
  // Same reply, no answer from the owner yet: refused.
  assert.equal((await call!.run({ number: '6135550123', confirm: code })).isError, true)
  heard = Date.now() + 1
  assert.equal((await call!.run({ number: '6135550199', confirm: code })).isError, true, 'another number')
  const done = await call!.run({ number: '6135550123', confirm: code })
  assert.equal(done.isError, false)
  assert.deepEqual(dialled, ['16135550123'])
  assert.equal((await call!.run({ number: '6135550123', confirm: code })).isError, true, 'a code works once')
  assert.equal((await call!.run({ number: '911' })).isError, true)
})

test('texts: split at words, first poll learns what is there, new texts are reported once, sending goes in parts', async () => {
  const { split, Texts } = await import('../src/phone/texts.ts')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const long = 'word '.repeat(70).trim()
  const parts = split(long)
  assert.ok(parts.every((p) => p.length <= 160))
  assert.equal(parts.join(' '), long)

  let inbox = [{ id: '1', date: '2026-11-11 09:00:00', type: '1', did: '6135550100', contact: '6135550123', message: 'old' }]
  const sent: string[] = []
  const fakeFetch = (async (url: string) => {
    const q = new URL(url).searchParams
    const body = q.get('method') === 'getSMS' ? { status: 'success', sms: inbox } : q.get('method') === 'sendSMS' ? (sent.push(q.get('message')!), { status: 'success', sms: 99 }) : { status: 'invalid_method' }
    return { json: async () => body, status: 200 } as Response
  }) as typeof fetch
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-texts-'))
  const arrived: string[] = []
  const texts = new Texts({ apiUser: 'u', apiPassword: 'p', did: '6135550100', dataDir, pollSeconds: 3600, dailyLimit: 2, log: () => {}, onIncoming: (t) => arrived.push(t.message), fetch: fakeFetch })
  await texts.poll()
  texts.stop()
  assert.deepEqual(arrived, [], 'what was there before is not news')
  inbox = [...inbox, { id: '2', date: '2026-11-11 10:00:00', type: '1', did: '6135550100', contact: '6135550123', message: 'Running late' }]
  await texts.poll()
  await texts.poll()
  texts.stop()
  assert.deepEqual(arrived, ['Running late'])
  await texts.send('6135550123', long)
  assert.equal(sent.length, parts.length)
  assert.equal(texts.recent(1)[0]!.message, long)
  await texts.send('6135550123', 'second')
  await assert.rejects(texts.send('6135550123', 'third'), /used up/)

  const refused = new Texts({ apiUser: 'u', apiPassword: 'p', did: '1', dataDir, pollSeconds: 3600, dailyLimit: 0, log: () => {}, onIncoming: () => {}, fetch: (async () => ({ json: async () => ({ status: 'ip_not_enabled' }), status: 200 })) as unknown as typeof fetch })
  await refused.poll()
  refused.stop()
  assert.match(refused.error, /allowed IPs/)
})
