import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // Models
  getModelsDir: () => ipcRenderer.invoke('models:dir'),
  listLocalModels: () => ipcRenderer.invoke('models:list-local'),
  deleteModel: (filename: string) => ipcRenderer.invoke('models:delete', filename),
  downloadModel: (url: string, filename: string) => ipcRenderer.send('models:download', { url, filename }),
  onDownloadProgress: (cb: (data: any) => void) => {
    ipcRenderer.on('models:download-progress', (_e, d) => cb(d))
    return () => ipcRenderer.removeAllListeners('models:download-progress')
  },
  onDownloadDone: (cb: (data: any) => void) => {
    ipcRenderer.on('models:download-done', (_e, d) => cb(d))
    return () => ipcRenderer.removeAllListeners('models:download-done')
  },
  onDownloadError: (cb: (data: any) => void) => {
    ipcRenderer.on('models:download-error', (_e, d) => cb(d))
    return () => ipcRenderer.removeAllListeners('models:download-error')
  },
  loadModel: (filename: string) => ipcRenderer.invoke('models:load', filename),

  // Chat / inference
  sendMessage: (message: string) => ipcRenderer.send('chat:send', { message }),
  onChatToken: (cb: (token: string) => void) => {
    ipcRenderer.on('chat:token', (_e, t) => cb(t))
    return () => ipcRenderer.removeAllListeners('chat:token')
  },
  onChatDone: (cb: () => void) => {
    ipcRenderer.on('chat:done', cb)
    return () => ipcRenderer.removeAllListeners('chat:done')
  },
  onChatError: (cb: (e: string) => void) => {
    ipcRenderer.on('chat:error', (_e, err) => cb(err))
    return () => ipcRenderer.removeAllListeners('chat:error')
  },

  // Agent tools
  readFile: (path: string) => ipcRenderer.invoke('tool:read-file', path),
  writeFile: (path: string, content: string) => ipcRenderer.invoke('tool:write-file', { path, content }),
  runShell: (command: string, cwd: string) => ipcRenderer.invoke('tool:run-shell', { command, cwd }),
  listDir: (path: string) => ipcRenderer.invoke('tool:list-dir', path),

  // Dialog
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (e) {
    console.error(e)
  }
} else {
  ;(window as any).electron = electronAPI
  ;(window as any).api = api
}
