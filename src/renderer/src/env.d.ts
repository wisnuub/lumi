/// <reference types="vite/client" />

interface Window {
  api: {
    getModelsDir: () => Promise<string>
    listLocalModels: () => Promise<Array<{ filename: string; path: string; size: number }>>
    deleteModel: (filename: string) => Promise<boolean>
    downloadModel: (url: string, filename: string) => void
    onDownloadProgress: (cb: (data: { filename: string; progress: number; received: number; total: number }) => void) => () => void
    onDownloadDone: (cb: (data: { filename: string }) => void) => () => void
    onDownloadError: (cb: (data: { filename: string; error: string }) => void) => () => void
    loadModel: (filename: string) => Promise<{ ok: boolean; error?: string }>
    sendMessage: (message: string) => void
    onChatToken: (cb: (token: string) => void) => () => void
    onChatDone: (cb: () => void) => () => void
    onChatError: (cb: (e: string) => void) => () => void
    readFile: (path: string) => Promise<{ ok: boolean; content: string; error?: string }>
    writeFile: (path: string, content: string) => Promise<{ ok: boolean; error?: string }>
    runShell: (command: string, cwd: string) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number; error?: string }>
    listDir: (path: string) => Promise<{ ok: boolean; entries: Array<{ name: string; isDir: boolean; size: number }>; error?: string }>
    openFolder:      () => Promise<string | null>
    connectorSearch: (connectors: string[], query: string) => Promise<Record<string, Array<{ title: string; url?: string; snippet: string; source: string }>>>
  }
}
