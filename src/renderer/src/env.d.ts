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
    chatInit:        (systemPrompt: string) => Promise<{ ok: boolean; error?: string }>
    chatSetApi:      (cfg: { provider: string; baseUrl: string; modelId: string; apiKey: string }) => Promise<{ ok: boolean }>
    chatClearApi:    () => Promise<{ ok: boolean }>
    chatResetHistory:() => Promise<{ ok: boolean }>
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

    imgCheckBin:      () => Promise<boolean>
    imgScanModels:    () => Promise<string[]>
    imgScanLoras:     () => Promise<string[]>
    imgCancel:        () => Promise<boolean>
    imgOpenLoraDir:   () => Promise<boolean>
    imgDownloadBin:   () => void
    imgDownloadModel: (url: string, filename: string) => void
    imgGenerate:      (params: any) => void

    onImgProgress:      (cb: (p: { step: number; total: number; percent: number }) => void) => () => void
    onImgDone:          (cb: (d: { path: string }) => void) => () => void
    onImgError:         (cb: (e: string) => void) => () => void
    onImgBinProgress:   (cb: (p: { progress: number }) => void) => () => void
    onImgBinDone:       (cb: () => void) => () => void
    onImgBinError:      (cb: (e: string) => void) => () => void
    onImgModelProgress: (cb: (p: { filename: string; received: number; total: number; progress: number }) => void) => () => void
    onImgModelDone:     (cb: (d: { filename: string }) => void) => () => void
    onImgModelError:    (cb: (d: { filename: string; error: string }) => void) => () => void
  }
}
