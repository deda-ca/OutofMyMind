// Streaming chat completions from an OpenAI-compatible server (llama.cpp's llama-server).

import { config } from '../config.ts'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class LlmError extends Error {}

/**
 * Streams a reply, calling `onDelta` with each piece of text as it arrives.
 * Returns the full reply. Thinking is switched off: for spoken conversation,
 * a fast short answer beats a slow considered one (0.3 s vs 1.3 s+ measured).
 */
export async function streamChat(messages: ChatMessage[], onDelta: (text: string) => void, signal?: AbortSignal): Promise<string> {
  let response: Response
  try {
    response = await fetch(new URL('/v1/chat/completions', config.llmUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.llmModel,
        messages,
        stream: true,
        max_tokens: 1024,
        temperature: 0.7,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal,
    })
  } catch (err) {
    throw new LlmError(`Could not reach the LLM at ${config.llmUrl}: ${(err as Error).message}`)
  }
  if (!response.ok || !response.body) {
    throw new LlmError(`LLM returned HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 300)}`)
  }

  let full = ''
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return full
      try {
        const delta = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content
        if (delta) {
          full += delta
          onDelta(delta)
        }
      } catch {
        // Ignore keep-alive or malformed lines.
      }
    }
  }
  return full
}
