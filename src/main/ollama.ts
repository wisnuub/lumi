import http from 'http'

const BASE = 'http://localhost:11434'

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = ''
      res.on('data', (c: Buffer) => { data += c.toString() })
      res.on('end', () => resolve(data))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function httpPost(path: string, body: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const opts = {
      hostname: 'localhost', port: 11434, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }
    const req = http.request(opts, res => {
      let data = ''
      res.on('data', (c: Buffer) => { data += c.toString() })
      res.on('end', () => resolve(data))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

export interface OllamaModel {
  name:       string
  size:       number   // bytes
  modified_at: string
  details?:   { parameter_size?: string; family?: string }
}

export async function isOllamaRunning(): Promise<boolean> {
  try { await httpGet(`${BASE}/api/tags`); return true } catch { return false }
}

export async function listOllamaModels(): Promise<OllamaModel[]> {
  try {
    const raw = await httpGet(`${BASE}/api/tags`)
    const data = JSON.parse(raw)
    return (data.models || []) as OllamaModel[]
  } catch { return [] }
}

export async function deleteOllamaModel(name: string): Promise<void> {
  const payload = JSON.stringify({ name })
  await new Promise<void>((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port: 11434, path: '/api/delete', method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }
    const req = http.request(opts, res => { res.resume(); res.on('end', resolve) })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

export function pullOllamaModel(
  name: string,
  onProgress: (status: string, percent: number) => void,
  onDone: () => void,
  onError: (e: string) => void,
) {
  const payload = JSON.stringify({ name, stream: true })
  const opts = {
    hostname: 'localhost', port: 11434, path: '/api/pull', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }
  const req = http.request(opts, res => {
    let buf = ''
    res.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          const pct = obj.total > 0 ? Math.round((obj.completed / obj.total) * 100) : 0
          onProgress(obj.status || '', pct)
          if (obj.status === 'success') onDone()
        } catch { /* partial */ }
      }
    })
    res.on('end', onDone)
    res.on('error', (e: Error) => onError(e.message))
  })
  req.on('error', (e: Error) => onError(e.message))
  req.write(payload)
  req.end()
}
