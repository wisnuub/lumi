import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { existsSync, mkdirSync, createWriteStream, readdirSync, statSync, unlinkSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import https from 'https'
import http from 'http'
import type { IncomingMessage, ClientRequest } from 'http'
import { runConnectors } from './connectors'
import { setApiConfig, setApiSystemPrompt, streamApiChat, isApiMode, clearApiMode, resetApiHistory } from './api-inference'
import {
  isBinReady, downloadBinary, scanLoras, scanImageModels,
  generate, cancelGeneration, IMG_MODEL_DIR, LORA_DIR, IMG_OUT_DIR,
} from './image-gen'

const MODELS_DIR = join(app.getPath('userData'), 'models')
if (!existsSync(MODELS_DIR)) mkdirSync(MODELS_DIR, { recursive: true })

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    show: false, autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f0f10',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler((d) => { shell.openExternal(d.url); return { action: 'deny' } })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.localai.app')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ─── Download manager ─────────────────────────────────────────────────────────

interface ActiveDownload {
  req: ClientRequest
  res: IncomingMessage
  writeStream: ReturnType<typeof createWriteStream>
  tmpPath: string
  destPath: string
  received: number
  total: number
  paused: boolean
  speedSamples: { bytes: number; time: number }[]
}

const activeDownloads = new Map<string, ActiveDownload>()

function calcSpeed(samples: { bytes: number; time: number }[]): number {
  if (samples.length < 2) return 0
  const oldest = samples[0]
  const newest = samples[samples.length - 1]
  const dt = (newest.time - oldest.time) / 1000
  if (dt <= 0) return 0
  return (newest.bytes - oldest.bytes) / dt
}

ipcMain.handle('models:dir', () => MODELS_DIR)

ipcMain.handle('models:list-local', () => {
  if (!existsSync(MODELS_DIR)) return []
  return readdirSync(MODELS_DIR)
    .filter(f => f.endsWith('.gguf'))
    .map(f => ({ filename: f, path: join(MODELS_DIR, f), size: statSync(join(MODELS_DIR, f)).size }))
})

ipcMain.handle('models:delete', (_e, filename: string) => {
  const p = join(MODELS_DIR, filename)
  if (existsSync(p)) unlinkSync(p)
  return true
})

ipcMain.on('models:download', (event, { url, filename }: { url: string; filename: string }) => {
  const dest = join(MODELS_DIR, filename)
  if (existsSync(dest)) { event.reply('models:download-done', { filename }); return }
  if (activeDownloads.has(filename)) return   // already in progress

  const tmpPath = dest + '.tmp'
  const file = createWriteStream(tmpPath, { flags: 'a' })
  let received = existsSync(tmpPath) ? statSync(tmpPath).size : 0
  const speedSamples: { bytes: number; time: number }[] = []

  const startRequest = (u: string, redirects = 5) => {
    const mod = u.startsWith('https') ? https : http
    const headers: Record<string, string> = { 'User-Agent': 'local-ai/1.0' }
    if (received > 0) headers['Range'] = `bytes=${received}-`

    const req = mod.get(u, { headers }, (res: IncomingMessage) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects > 0) startRequest(res.headers.location, redirects - 1)
        else event.reply('models:download-error', { filename, error: 'Too many redirects' })
        return
      }

      const rangeTotal = res.headers['content-range']
        ? Number(res.headers['content-range'].split('/')[1])
        : Number(res.headers['content-length'] || 0)
      const total = rangeTotal || Number(res.headers['content-length'] || 0)

      const dl: ActiveDownload = { req, res, writeStream: file, tmpPath, destPath: dest, received, total, paused: false, speedSamples }
      activeDownloads.set(filename, dl)

      res.on('data', (chunk: Buffer) => {
        dl.received += chunk.length
        file.write(chunk)
        const now = Date.now()
        dl.speedSamples.push({ bytes: dl.received, time: now })
        if (dl.speedSamples.length > 20) dl.speedSamples.shift()
        event.reply('models:download-progress', {
          filename,
          received: dl.received,
          total: dl.total,
          speed: calcSpeed(dl.speedSamples),
          progress: dl.total > 0 ? dl.received / dl.total : 0,
        })
      })

      res.on('end', () => {
        activeDownloads.delete(filename)
        file.end(() => {
          const { renameSync } = require('fs')
          renameSync(tmpPath, dest)
          event.reply('models:download-done', { filename })
        })
      })

      res.on('error', (e: Error) => {
        activeDownloads.delete(filename)
        event.reply('models:download-error', { filename, error: e.message })
      })
    })

    req.on('error', (e: Error) => {
      activeDownloads.delete(filename)
      event.reply('models:download-error', { filename, error: e.message })
    })
  }

  startRequest(url)
})

ipcMain.handle('models:pause', (_e, filename: string) => {
  const dl = activeDownloads.get(filename)
  if (!dl || dl.paused) return false
  dl.res.pause()
  dl.paused = true
  return true
})

ipcMain.handle('models:resume', (_e, filename: string) => {
  const dl = activeDownloads.get(filename)
  if (!dl || !dl.paused) return false
  dl.res.resume()
  dl.paused = false
  return true
})

ipcMain.handle('models:cancel', (_e, filename: string) => {
  const dl = activeDownloads.get(filename)
  if (dl) {
    dl.req.destroy()
    dl.writeStream.destroy()
    activeDownloads.delete(filename)
    if (existsSync(dl.tmpPath)) unlinkSync(dl.tmpPath)
  }
  return true
})

// ─── Model inference ──────────────────────────────────────────────────────────

let llamaInstance: any = null
let currentModel: any = null
let currentContext: any = null
let currentSession: any = null

async function getLlama() {
  if (!llamaInstance) {
    const { getLlama: _getLlama } = await import('node-llama-cpp')
    llamaInstance = await _getLlama()
  }
  return llamaInstance
}

ipcMain.handle('models:load', async (_e, filename: string) => {
  try {
    const llama = await getLlama()
    const { LlamaChatSession } = await import('node-llama-cpp')
    currentModel = await llama.loadModel({ modelPath: join(MODELS_DIR, filename) })
    currentContext = await currentModel.createContext({ contextSize: 4096 })
    currentSession = new LlamaChatSession({ contextSequence: currentContext.getSequence() })
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('chat:init', async (_e, systemPrompt: string) => {
  if (isApiMode()) {
    setApiSystemPrompt(systemPrompt)
    return { ok: true }
  }
  try {
    if (!currentContext) return { ok: false, error: 'No model loaded' }
    const { LlamaChatSession } = await import('node-llama-cpp')
    currentSession = new LlamaChatSession({
      contextSequence: currentContext.getSequence(),
      systemPrompt,
    })
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('chat:set-api', (_e, config: { provider: string; baseUrl: string; modelId: string; apiKey: string }) => {
  setApiConfig(config)
  clearApiMode()   // will be re-enabled by setApiConfig
  setApiConfig(config)
  return { ok: true }
})

ipcMain.handle('chat:clear-api', () => {
  clearApiMode()
  return { ok: true }
})

ipcMain.handle('chat:reset-history', () => {
  resetApiHistory()
  return { ok: true }
})

ipcMain.on('chat:send', async (event, { message }: { message: string }) => {
  // Route to API or local inference
  if (isApiMode()) {
    streamApiChat(
      message,
      (token) => event.reply('chat:token', token),
      ()      => event.reply('chat:done'),
      (err)   => event.reply('chat:error', err),
    )
    return
  }
  if (!currentSession) { event.reply('chat:error', 'No model loaded.'); return }
  try {
    await currentSession.prompt(message, {
      onToken(tokens: number[]) { event.reply('chat:token', currentModel.detokenize(tokens)) }
    })
    event.reply('chat:done')
  } catch (e: any) {
    event.reply('chat:error', e.message)
  }
})

// ─── Agent tools ──────────────────────────────────────────────────────────────

ipcMain.handle('tool:read-file', async (_e, path: string) => {
  try { return { ok: true, content: await readFile(path, 'utf-8') } }
  catch (e: any) { return { ok: false, error: e.message } }
})

ipcMain.handle('tool:write-file', async (_e, { path, content }: { path: string; content: string }) => {
  try {
    const { mkdirSync, existsSync } = require('fs')
    const dir = require('path').dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    await writeFile(path, content, 'utf-8')
    return { ok: true }
  } catch (e: any) { return { ok: false, error: e.message } }
})

ipcMain.handle('tool:run-shell', (_, { command, cwd }: { command: string; cwd: string }) =>
  new Promise(resolve => {
    const proc = spawn(command, { shell: true, cwd, timeout: 30000 })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ ok: true, stdout, stderr, code }))
    proc.on('error', (e) => resolve({ ok: false, error: e.message }))
  })
)

ipcMain.handle('tool:list-dir', (_e, path: string) => {
  try {
    return {
      ok: true,
      entries: readdirSync(path).map(name => {
        const full = join(path, name)
        const st = statSync(full)
        return { name, isDir: st.isDirectory(), size: st.size }
      })
    }
  } catch (e: any) { return { ok: false, error: e.message } }
})

// ─── Connectors ───────────────────────────────────────────────────────────────

ipcMain.handle('connectors:search', async (_e, { connectors, query }: { connectors: string[]; query: string }) => {
  return runConnectors(connectors, query)
})

ipcMain.handle('dialog:open-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
  return res.filePaths[0] || null
})

// ─── Image generation ─────────────────────────────────────────────────────────

ipcMain.handle('img:check-bin', () => isBinReady())
ipcMain.handle('img:scan-models', () => scanImageModels())
ipcMain.handle('img:scan-loras', () => scanLoras())
ipcMain.handle('img:cancel', () => { cancelGeneration(); return true })

ipcMain.handle('img:open-lora-dir', async () => {
  const { mkdirSync, existsSync } = require('fs')
  if (!existsSync(LORA_DIR)) mkdirSync(LORA_DIR, { recursive: true })
  shell.openPath(LORA_DIR)
  return true
})

ipcMain.on('img:download-bin', async (event) => {
  try {
    await downloadBinary(p => event.reply('img:bin-progress', { progress: p }))
    event.reply('img:bin-done')
  } catch (e: any) {
    event.reply('img:bin-error', e.message)
  }
})

ipcMain.on('img:download-model', async (event, { url, filename }: { url: string; filename: string }) => {
  const dest = require('path').join(IMG_MODEL_DIR, filename)
  if (require('fs').existsSync(dest)) { event.reply('img:model-done', { filename }); return }

  const tmpPath = dest + '.tmp'
  const { createWriteStream: cws, existsSync: ex, statSync: ss } = require('fs')
  let received = ex(tmpPath) ? ss(tmpPath).size : 0
  const file = cws(tmpPath, { flags: 'a' })
  const total_ref = { val: 0 }

  const startReq = (u: string, redirects = 5) => {
    const mod = u.startsWith('https') ? https : http
    const headers: Record<string, string> = { 'User-Agent': 'local-ai/1.0' }
    if (received > 0) headers['Range'] = `bytes=${received}-`
    mod.get(u, { headers }, (res: IncomingMessage) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects > 0) startReq(res.headers.location, redirects - 1)
        else event.reply('img:model-error', { filename, error: 'Too many redirects' })
        return
      }
      const rangeTotal = res.headers['content-range'] ? Number(res.headers['content-range'].split('/')[1]) : 0
      total_ref.val = rangeTotal || Number(res.headers['content-length'] || 0)
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        file.write(chunk)
        event.reply('img:model-progress', { filename, received, total: total_ref.val, progress: total_ref.val > 0 ? received / total_ref.val : 0 })
      })
      res.on('end', () => {
        file.end(() => {
          require('fs').renameSync(tmpPath, dest)
          event.reply('img:model-done', { filename })
        })
      })
      res.on('error', (e: Error) => event.reply('img:model-error', { filename, error: e.message }))
    }).on('error', (e: Error) => event.reply('img:model-error', { filename, error: e.message }))
  }
  startReq(url)
})

ipcMain.on('img:generate', async (event, params: any) => {
  const { join: pjoin } = require('path')
  const { existsSync: ex, mkdirSync } = require('fs')
  if (!ex(IMG_OUT_DIR)) mkdirSync(IMG_OUT_DIR, { recursive: true })
  const outputFile = pjoin(IMG_OUT_DIR, `img_${Date.now()}.png`)
  try {
    const result = await generate({ ...params, outputFile }, (p) => event.reply('img:progress', p))
    event.reply('img:done', { path: result })
  } catch (e: any) {
    event.reply('img:error', e.message)
  }
})
