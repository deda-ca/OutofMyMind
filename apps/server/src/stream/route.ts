// GET /api/stream (WebSocket): live transcription. Protocol in protocol.ts.

import type { FastifyInstance } from 'fastify'
import type { Archive } from '../archive/archive.ts'
import type { Speakers } from '../speaker/speakers.ts'
import { parseFrame, type ClientMessage, type ServerMessage } from './protocol.ts'
import { StreamSession } from './session.ts'

/** One 32 ms frame is ~1 KB; this leaves plenty of room. */
const MAX_MESSAGE_BYTES = 64 * 1024

/** Free-text device label from the client, kept short and printable. */
function deviceLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) : ''
  return label || 'unknown'
}

export async function streamRoute(app: FastifyInstance, options: { archive: Archive; speakers: Speakers }): Promise<void> {
  app.get('/api/stream', { websocket: true }, (socket, req) => {
    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
    }
    const fail = (message: string) => {
      send({ type: 'error', message })
      socket.close(1008, 'protocol error')
    }
    let session = new StreamSession(send)
    let started = false
    req.log.info('stream session opened')

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (data.length > MAX_MESSAGE_BYTES) return fail('Message too large')
      try {
        if (isBinary) {
          const frame = parseFrame(data)
          if (!frame) return fail('Malformed audio frame')
          session.frame(frame.probability, frame.pcm)
          return
        }
        const message = JSON.parse(data.toString()) as ClientMessage
        switch (message.type) {
          case 'start': {
            if (started) return fail('Session already started')
            started = true
            // The archive recorder needs the device label and mode, which arrive with "start".
            const mode = message.mode === 'enroll' ? 'enroll' : 'conversation'
            const recorder = options.archive.recorder(
              deviceLabel(message.device),
              req.headers['user-agent'],
              mode === 'enroll' ? 'enrollment' : 'conversation',
            )
            session = new StreamSession(send, {
              recorder,
              speakers: options.speakers,
              mode,
              log: (msg, err) => req.log.error({ err }, msg),
            })
            session.start(Number(message.sampleRate), String(message.language ?? ''), message.settings)
            break
          }
          case 'settings':
            session.updateSettings(message.settings)
            break
          case 'stop':
            void session.stop().then(() => socket.close(1000, 'stopped'))
            break
          default:
            fail(`Unknown message type: ${(message as { type?: unknown }).type}`)
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

    socket.on('close', () => {
      session.close()
      req.log.info('stream session closed')
    })
  })
}
