import { useState } from 'react'
import { ModelDef, LocalModel, DownloadEntry } from '../types'
import { FREE_MODELS, PROVIDERS, ApiModelDef, ProviderDef } from '../data/api-models'
import { MODELS } from '../data/models'

interface Props {
  localModels:   LocalModel[]
  apiKeys:       Record<string, string>
  activeModel:   { name: string; type: string; apiDef?: ApiModelDef; localDef?: ModelDef } | null
  downloads:     Record<string, DownloadEntry>
  onSelectLocal: (m: ModelDef) => void
  onSelectApi:   (m: ApiModelDef, key: string) => void
  onSaveKey:     (provider: string, key: string) => void
  onDownload:    (m: ModelDef) => void
  onClose:       () => void
}

export default function ModelSelectModal({ localModels, apiKeys, activeModel, downloads, onSelectLocal, onSelectApi, onSaveKey, onDownload, onClose }: Props) {
  const [openProvider, setOpenProvider]   = useState<ProviderDef | null>(null)
  const [keyInput,     setKeyInput]       = useState('')
  const [pendingModel, setPendingModel]   = useState<ApiModelDef | null>(null)
  const [showLocal,    setShowLocal]      = useState(false)
  const [customModel,  setCustomModel]    = useState('')

  const handleFreeModel = (m: ApiModelDef) => {
    const key = apiKeys[m.provider]
    if (key) { onSelectApi(m, key); return }
    setPendingModel(m)
    setOpenProvider(PROVIDERS.find(p => p.id === m.provider) ?? null)
    setKeyInput('')
  }

  const handleProviderModel = (provider: ProviderDef, modelId: string) => {
    const key = apiKeys[provider.id]
    const apiModel: ApiModelDef = {
      id: `${provider.id}-${modelId}`, name: provider.models.find(m => m.id === modelId)?.name ?? modelId,
      provider: provider.id, modelId, baseUrl: provider.baseUrl,
      keyUrl: provider.keyUrl, free: false, badge: '', description: '',
    }
    if (key) { onSelectApi(apiModel, key); return }
    setPendingModel(apiModel)
    setOpenProvider(provider)
    setKeyInput('')
  }

  const handleKeySubmit = () => {
    if (!keyInput.trim() || !openProvider || !pendingModel) return
    onSaveKey(openProvider.id, keyInput.trim())
    onSelectApi(pendingModel, keyInput.trim())
    setOpenProvider(null)
    setPendingModel(null)
    setKeyInput('')
  }

  // Group free models by provider
  const groqFree = FREE_MODELS.filter(m => m.provider === 'groq')
  const orFree   = FREE_MODELS.filter(m => m.provider === 'openrouter')

  const isActiveApi  = (m: ApiModelDef) => activeModel?.type === 'api' && activeModel.apiDef?.id === m.id
  const isActiveLocal = (m: ModelDef)   => activeModel?.type === 'local' && activeModel.localDef?.id === m.id

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="model-modal" onClick={e => e.stopPropagation()}>
        <div className="model-modal-header">
          <span className="model-modal-title">Select model</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="model-modal-body">

          {/* ── Free models section ───────────────────────────────────── */}
          <p className="model-section-label">Free models — just add a free API key</p>

          <div className="free-model-group">
            <div className="free-model-group-label">
              <span>⚡ Groq</span>
              <a className="get-key-link" href="#" onClick={e => { e.preventDefault(); setOpenProvider(PROVIDERS.find(p => p.id === 'groq')!); setPendingModel(groqFree[0]); setKeyInput('') }}>
                {apiKeys['groq'] ? '✓ Key saved' : 'Get free key →'}
              </a>
            </div>
            {groqFree.map(m => (
              <button key={m.id} className={`free-model-row ${isActiveApi(m) ? 'free-model-row--active' : ''}`} onClick={() => handleFreeModel(m)}>
                <div className="free-model-info">
                  <span className="free-model-name">{m.name}</span>
                  <span className="free-model-desc">{m.description}</span>
                </div>
                <span className="free-badge">{m.badge}</span>
                {isActiveApi(m) && <span className="active-check">✓</span>}
              </button>
            ))}
          </div>

          <div className="free-model-group">
            <div className="free-model-group-label">
              <span>🔀 OpenRouter</span>
              <a className="get-key-link" href="#" onClick={e => { e.preventDefault(); setOpenProvider(PROVIDERS.find(p => p.id === 'openrouter')!); setPendingModel(orFree[0]); setKeyInput('') }}>
                {apiKeys['openrouter'] ? '✓ Key saved' : 'Get free key →'}
              </a>
            </div>
            {orFree.map(m => (
              <button key={m.id} className={`free-model-row ${isActiveApi(m) ? 'free-model-row--active' : ''}`} onClick={() => handleFreeModel(m)}>
                <div className="free-model-info">
                  <span className="free-model-name">{m.name}</span>
                  <span className="free-model-desc">{m.description}</span>
                </div>
                <span className="free-badge">{m.badge}</span>
                {isActiveApi(m) && <span className="active-check">✓</span>}
              </button>
            ))}
          </div>

          {/* ── Local downloaded models ───────────────────────────────── */}
          {localModels.length > 0 && (
            <div className="free-model-group">
              <div className="free-model-group-label"><span>💾 Local (downloaded)</span></div>
              {MODELS.filter(m => localModels.some(l => l.filename === m.filename)).map(m => (
                <button key={m.id} className={`free-model-row ${isActiveLocal(m) ? 'free-model-row--active' : ''}`} onClick={() => onSelectLocal(m)}>
                  <div className="free-model-info">
                    <span className="free-model-name">{m.name}</span>
                    <span className="free-model-desc">{m.params} · {m.sizeGb}GB · offline</span>
                  </div>
                  {isActiveLocal(m) && <span className="active-check">✓</span>}
                </button>
              ))}
            </div>
          )}

          {/* ── More providers ────────────────────────────────────────── */}
          <p className="model-section-label" style={{ marginTop: 16 }}>Add more models from popular providers</p>

          {PROVIDERS.map(p => (
            <button key={p.id} className="provider-row" onClick={() => { setOpenProvider(p); setPendingModel(null); setKeyInput(apiKeys[p.id] ?? '') }}>
              <span className="provider-icon">{p.icon}</span>
              <span className="provider-name">{p.name}</span>
              <span className="provider-desc">{p.description}</span>
              {apiKeys[p.id] ? <span className="provider-check">✓</span> : <span className="provider-add">+</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── API key / model picker sub-modal ──────────────────────────── */}
      {openProvider && (
        <div className="model-modal model-modal--sm" onClick={e => e.stopPropagation()}>
          <div className="model-modal-header">
            <button className="modal-back" onClick={() => { setOpenProvider(null); setPendingModel(null) }}>← Back</button>
            <span className="model-modal-title">{openProvider.icon} {openProvider.name}</span>
            <button className="modal-close" onClick={onClose}>✕</button>
          </div>
          <div className="model-modal-body">
            <p className="model-section-label">{openProvider.keyLabel}</p>
            <div className="key-input-row">
              <input
                className="api-key-input"
                type="password"
                placeholder={openProvider.placeholder}
                value={keyInput}
                onChange={e => setKeyInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleKeySubmit()}
                autoFocus
              />
              <button className="btn btn-primary key-save-btn" onClick={handleKeySubmit} disabled={!keyInput.trim()}>
                Save
              </button>
            </div>
            <a className="get-key-link-full" href="#" onClick={e => e.preventDefault()}>
              Get a free key at {openProvider.keyUrl}
            </a>

            <p className="model-section-label" style={{ marginTop: 16 }}>Models</p>
            {openProvider.models.map(m => (
              <button key={m.id} className="free-model-row" onClick={() => handleProviderModel(openProvider, m.id)}>
                <div className="free-model-info">
                  <span className="free-model-name">{m.name}</span>
                  <span className="free-model-desc">{m.description}</span>
                </div>
                {activeModel?.type === 'api' && (activeModel.apiDef as any)?.modelId === m.id && <span className="active-check">✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
