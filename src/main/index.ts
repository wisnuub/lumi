import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { existsSync, mkdirSync, createWriteStream, readdirSync, statSync, unlinkSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { execFile, spawn } from 'child_process'
import https from 'https'
import http from 'http'

// ─── Paths ────────────────────────────────────────────────────────────────────

const MODELS_DIR = join(app.getPath('userData'), 'models')
if (!existsSync(MODELS_DIR)) mkdirSync(MODELS_DIR, { recursive: true })

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f0f10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler((d) => {
    shell.openExternal(d.url)
    return { action: 'deny' }
  })

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

// ─── Model management ─────────────────────────────────────────────────────────

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

ipcMain.handle('models:dir', () => MODELS_DIR)

ipcMain.handle('models:list-local', () => {
  if (!existsSync(MODELS_DIR)) return []
  return readdirSync(MODELS_DIR)
    .filter(f => f.endsWith('.gguf'))
    .map(f => ({
      filename: f,
      path: join(MODELS_DIR, f),
      size: statSync(join(MODELS_DIR, f)).size
    }))
})

ipcMain.handle('models:delete', (_e, filename: string) => {
  const p = join(MODELS_DIR, filename)
  if (existsSync(p)) unlinkSync(p)
  return true
})

// Model download with progress
ipcMain.on('models:download', async (event, { url, filename }: { url: string; filename: string }) => {
  const dest = join(MODELS_DIR, filename)
  if (existsSync(dest)) {
    event.reply('models:download-done', { filename })
    return
  }

  const tmpDest = dest + '.tmp'
  const file = createWriteStream(tmpDest)

  const get = (u: string, redirects = 5) => {
    const mod = u.startsWith('https') ? https : http
    mod.get(u, { headers: { 'User-Agent': 'local-ai/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects > 0) get(res.headers.location, redirects - 1)
        else event.reply('models:download-error', { filename, error: 'Too many redirects' })
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let received = 0
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        file.write(chunk)
        if (total > 0) {
          event.reply('models:download-progress', { filename, progress: received / total, received, total })
        }
      })
      res.on('end', () => {
        file.end(() => {
          const { renameSync } = require('fs')
          renameSync(tmpDest, dest)
          event.reply('models:download-done', { filename })
        })
      })
      res.on('error', (e: Error) => {
        file.destroy()
        event.reply('models:download-error', { filename, error: e.message })
      })
    }).on('error', (e: Error) => {
      file.destroy()
      event.reply('models:download-error', { filename, error: e.message })
    })
  }

  get(url)
})

// Load model into memory
ipcMain.handle('models:load', async (_e, filename: string) => {
  try {
    const llama = await getLlama()
    const { LlamaModel, LlamaContext, LlamaChatSession } = await import('node-llama-cpp')
    currentModel = await llama.loadModel({ modelPath: join(MODELS_DIR, filename) })
    currentContext = await currentModel.createContext({ contextSize: 4096 })
    currentSession = new LlamaChatSession({ contextSequence: currentContext.getSequence() })
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

// Streaming chat inference
ipcMain.on('chat:send', async (event, { message }: { message: string }) => {
  if (!currentSession) {
    event.reply('chat:error', 'No model loaded. Load a model first.')
    return
  }
  try {
    await currentSession.prompt(message, {
      onToken(tokens: number[]) {
        const text = currentModel.detokenize(tokens)
        event.reply('chat:token', text)
      }
    })
    event.reply('chat:done')
  } catch (e: any) {
    event.reply('chat:error', e.message)
  }
})

// ─── Agent tools (VSCode-style with permission) ────────────────────────────────

ipcMain.handle('tool:read-file', async (_e, path: string) => {
  try {
    const content = await readFile(path, 'utf-8')
    return { ok: true, content }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('tool:write-file', async (event, { path, content }: { path: string; content: string }) => {
  // Permission prompt shown in renderer — main trusts the renderer has already asked
  try {
    const { mkdirSync, existsSync } = require('fs')
    const dir = require('path').dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    await writeFile(path, content, 'utf-8')
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('tool:run-shell', async (event, { command, cwd }: { command: string; cwd: string }) => {
  return new Promise((resolve) => {
    const proc = spawn(command, { shell: true, cwd, timeout: 30000 })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ ok: true, stdout, stderr, code }))
    proc.on('error', (e) => resolve({ ok: false, error: e.message }))
  })
})

ipcMain.handle('tool:list-dir', async (_e, path: string) => {
  try {
    const entries = readdirSync(path).map(name => {
      const full = join(path, name)
      const st = statSync(full)
      return { name, isDir: st.isDirectory(), size: st.size }
    })
    return { ok: true, entries }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

// Open folder picker
ipcMain.handle('dialog:open-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
  return res.filePaths[0] || null
})
