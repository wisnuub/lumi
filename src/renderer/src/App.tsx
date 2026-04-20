import { useState, useEffect } from 'react'
import ModelBrowser from './components/ModelBrowser'
import ChatView from './components/ChatView'
import { ModelDef, LocalModel } from './types'

type View = 'models' | 'chat'

export default function App() {
  const [view, setView] = useState<View>('models')
  const [activeModel, setActiveModel] = useState<ModelDef | null>(null)
  const [localModels, setLocalModels] = useState<LocalModel[]>([])
  const [loadingModel, setLoadingModel] = useState(false)
  const [workspace, setWorkspace] = useState('~')

  const refreshLocal = async () => {
    const list = await window.api.listLocalModels()
    setLocalModels(list)
  }

  useEffect(() => { refreshLocal() }, [])

  const handleUseModel = async (model: ModelDef) => {
    setLoadingModel(true)
    const res = await window.api.loadModel(model.filename)
    setLoadingModel(false)
    if (res.ok) {
      setActiveModel(model)
      setView('chat')
    } else {
      alert(`Failed to load model: ${res.error}`)
    }
  }

  const handlePickWorkspace = async () => {
    const folder = await window.api.openFolder()
    if (folder) setWorkspace(folder)
  }

  return (
    <div className="app">
      {/* Titlebar */}
      <header className="titlebar">
        <div className="titlebar-drag" />
        <nav className="titlebar-nav">
          <button
            className={`nav-btn ${view === 'models' ? 'active' : ''}`}
            onClick={() => setView('models')}
          >
            ⚡ Models
          </button>
          <button
            className={`nav-btn ${view === 'chat' ? 'active' : ''}`}
            onClick={() => setView('chat')}
            disabled={!activeModel}
          >
            💬 Chat
          </button>
        </nav>
        <div className="titlebar-right">
          {activeModel && (
            <span className="active-model-badge" onClick={() => setView('chat')}>
              {activeModel.name}
            </span>
          )}
          <button className="workspace-btn" onClick={handlePickWorkspace} title="Set workspace folder">
            📁 {workspace === '~' ? 'Workspace' : workspace.split('/').pop()}
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="main-content">
        {view === 'models' ? (
          <ModelBrowser
            localModels={localModels}
            onRefreshLocal={refreshLocal}
            onUseModel={handleUseModel}
            loadingModel={loadingModel}
            activeModel={activeModel}
          />
        ) : (
          <ChatView
            model={activeModel!}
            workspace={workspace}
          />
        )}
      </main>

      {loadingModel && (
        <div className="loading-overlay">
          <div className="loading-box">
            <div className="spinner" />
            <p>Loading {activeModel?.name}…</p>
            <p className="loading-sub">Building context, may take a moment</p>
          </div>
        </div>
      )}
    </div>
  )
}
