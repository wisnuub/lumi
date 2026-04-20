/**
 * OpenAI-compatible streaming inference for cloud API models.
 * Supports NVIDIA, Groq, OpenAI, and any compatible endpoint.
 */
import https from 'https'
import http from 'http'

export interface ApiModelConfig {
  provider: string
  baseUrl: string
  modelId: string
  apiKey: string
}

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

let apiConfig: ApiModelConfig | null = null
let apiHistory: ApiMessage[] = []
let systemPrompt = ''

export function setApiConfig(config: ApiModelConfig) {
  apiConfig = config
  apiHistory = []
}

export function setApiSystemPrompt(prompt: string) {
  systemPrompt = prompt
  apiHistory = []
}

export function resetApiHistory() {
  apiHistory = []
}

export function isApiMode(): boolean {
  return apiConfig !== null
}

export function clearApiMode() {
  apiConfig = null
  apiHistory = []
}

export function streamApiChat(
  userMessage: string,
  onToken: (t: string) => void,
  onDone: () => void,
  onError: (e: string) => void,
) {
  if (!apiConfig) { onError('No API config'); return }

  apiHistory.push({ role: 'user', content: userMessage })

  const messages: ApiMessage[] = [
    ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...apiHistory,
  ]

  const body = JSON.stringify({
    model: apiConfig.modelId,
    messages,
    stream: true,
    max_tokens: 4096,
    temperature: 0.6,
  })

  const url = new URL(`${apiConfig.baseUrl}/chat/completions`)
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiConfig.apiKey}`,
      'Accept': 'text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    },
  }

  const mod = url.protocol === 'https:' ? https : http
  let assistantText = ''

  const req = mod.request(options, (res) => {
    if (res.statusCode && res.statusCode >= 400) {
      let err = ''
      res.on('data', (d: Buffer) => { err += d.toString() })
      res.on('end', () => onError(`API error ${res.statusCode}: ${err.slice(0, 200)}`))
      return
    }

    let buf = ''
    res.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          const token = parsed.choices?.[0]?.delta?.content
          if (token) { assistantText += token; onToken(token) }
        } catch { /* partial JSON */ }
      }
    })

    res.on('end', () => {
      apiHistory.push({ role: 'assistant', content: assistantText })
      onDone()
    })
    res.on('error', (e: Error) => onError(e.message))
  })

  req.on('error', (e: Error) => onError(e.message))
  req.write(body)
  req.end()
}
