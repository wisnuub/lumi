import { useState, useEffect, useCallback } from 'react'
import ModelBrowser from './components/ModelBrowser'
import ChatView from './components/ChatView'
import DownloadManager from './components/DownloadManager'
import ImageGen from './components/ImageGen'
import ModelSelectModal from './components/ModelSelectModal'
import { ModelDef, LocalModel, DownloadEntry } from './types'
import { MODELS } from './data/models'
import { FREE_MODELS, ApiModelDef } from './data/api-models'

interface ActiveModel {
  name:     string
  type:     'local' | 'api'
  localDef?: ModelDef
  apiDef?:  ApiModelDef
}

type View = 'models' | 'chat' | 'images'

export default function App() {
  const [view,          setView]          = useState<View>('models')
  const [activeModel,   setActiveModel]   = useState<ActiveModel | null>(null)
  const [localModels,   setLocalModels]   = useState<LocalModel[]>([])
  const [loadingModel,  setLoadingModel]  = useState(false)
  const [workspace,     setWorkspace]     = useState('~')
  const [downloads,     setDownloads]     = useState<Record<string, DownloadEntry>>({})
  const [showSelector,  setShowSelector]  = useState(false)
  const [apiKeys,       setApiKeys]       = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('apiKeys') || '{}') } catch { return {} }
  })

  const refreshLocal = useCallback(async () => {
    setLocalModels(await window.api.listLocalModels())
  }, [])

  useEffect(() => {
    refreshLocal()
    const off1 = window.api.onDownloadProgress(({ filename, received, total, speed }) =>
      setDownloads(p => ({ ...p, [filename]: { ...p[filename], filename, modelName: p[filename]?.modelName ?? modelNameFor(filename), status: p[filename]?.status === 'paused' ? 'paused' : 'downloading', received, total, speed } }))
    )
    const off2 = window.api.onDownloadDone(({ filename }) => {
      setDownloads(p => ({ ...p, [filename]: { ...p[filename], status: 'done', speed: 0 } }))
      refreshLocal()
    })
    const off3 = window.api.onDownloadError(({ filename, error }) =>
      setDownloads(p => ({ ...p, [filename]: { ...p[filename], status: 'error', speed: 0, error } }))
    )
    return () => { off1(); off2(); off3() }
  }, [refreshLocal])

  const saveApiKey = (provider: string, key: string) => {
    const updated = { ...apiKeys, [provider]: key }
    setApiKeys(updated)
    localStorage.setItem('apiKeys', JSON.stringify(updated))
  }

  // ─── Model selection handlers ─────────────────────────────────────────────

  const selectLocalModel = async (model: ModelDef) => {
    setLoadingModel(true)
    await window.api.chatClearApi()
    const res = await window.api.loadModel(model.filename)
    setLoadingModel(false)
    if (!res.ok) { alert(`Failed to load: ${res.error}`); return }
    setActiveModel({ name: model.name, type: 'local', localDef: model })
    setShowSelector(false)
    setView('chat')
  }

  const selectApiModel = async (model: ApiModelDef, key: string) => {
    await window.api.chatSetApi({ provider: model.provider, baseUrl: model.baseUrl, modelId: model.modelId, apiKey: key })
    await window.api.chatResetHistory()
    setActiveModel({ name: model.name, type: 'api', apiDef: model })
    setShowSelector(false)
    setView('chat')
  }

  // ─── Download handlers ────────────────────────────────────────────────────

  const startDownload = useCallback((model: ModelDef) => {
    setDownloads(p => ({ ...p, [model.filename]: { filename: model.filename, modelName: model.name, status: 'downloading', received: 0, total: Math.round(model.sizeGb * 1024 ** 3), speed: 0 } }))
    window.api.downloadModel(model.url, model.filename)
  }, [])

  const handlePause  = useCallback(async (f: string) => { await window.api.pauseDownload(f);  setDownloads(p => p[f] ? { ...p, [f]: { ...p[f], status: 'paused',      speed: 0 } } : p) }, [])
  const handleResume = useCallback(async (f: string) => { await window.api.resumeDownload(f); setDownloads(p => p[f] ? { ...p, [f]: { ...p[f], status: 'downloading'       } } : p) }, [])
  const handleCancel = useCallback(async (f: string) => { await window.api.cancelDownload(f); setDownloads(p => { const n = { ...p }; delete n[f]; return n }) }, [])
  const handleDelete = useCallback(async (f: string) => { await window.api.deleteModel(f);    setDownloads(p => { const n = { ...p }; delete n[f]; return n }); refreshLocal() }, [refreshLocal])

  const handlePickWorkspace = async () => {
    const folder = await window.api.openFolder()
    if (folder) setWorkspace(folder)
  }

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-drag" />
        <nav className="titlebar-nav">
          <button className={`nav-btn ${view === 'models' ? 'active' : ''}`} onClick={() => setView('models')}>⚡ Models</button>
          <button className={`nav-btn ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')} disabled={!activeModel}>💬 Chat</button>
          <button className={`nav-btn ${view === 'images' ? 'active' : ''}`} onClick={() => setView('images')}>🎨 Images</button>
        </nav>
        <div className="titlebar-right">
          {/* Model selector button — always visible, opens modal */}
          <button className="model-select-btn" onClick={() => setShowSelector(true)}>
            {activeModel
              ? <><span className="model-select-dot" />{activeModel.name}</>
              : <>Select model ▾</>
            }
          </button>
          <button className="workspace-btn" onClick={handlePickWorkspace} title="Set workspace">
            📁 {workspace === '~' ? 'Workspace' : workspace.split('/').pop()}
          </button>
        </div>
      </header>

      <main className="main-content">
        {view === 'models' && (
          <ModelBrowser
            localModels={localModels}
            downloads={downloads}
            onDownload={startDownload}
            onUseModel={selectLocalModel}
            loadingModel={loadingModel}
            activeModel={activeModel?.localDef ?? null}
          />
        )}
        {view === 'chat' && activeModel && (
          <ChatView modelName={activeModel.name} modelType={activeModel.type} workspace={workspace} />
        )}
        {view === 'images' && <ImageGen />}
      </main>

      <DownloadManager downloads={downloads} onPause={handlePause} onResume={handleResume} onCancel={handleCancel} onDelete={handleDelete} />

      {showSelector && (
        <ModelSelectModal
          localModels={localModels}
          apiKeys={apiKeys}
          activeModel={activeModel}
          downloads={downloads}
          onSelectLocal={selectLocalModel}
          onSelectApi={selectApiModel}
          onSaveKey={saveApiKey}
          onDownload={startDownload}
          onClose={() => setShowSelector(false)}
        />
      )}

      {loadingModel && (
        <div className="loading-overlay">
          <div className="loading-box">
            <div className="spinner" />
            <p>Loading model…</p>
            <p className="loading-sub">May take a moment on first load</p>
          </div>
        </div>
      )}
    </div>
  )
}

function modelNameFor(f: string) {
  return MODELS.find(m => m.filename === f)?.name ?? f.replace(/\.gguf$/, '')
}
