import { useState, useEffect, useRef } from 'react'
import { MODELS, CATEGORIES } from '../data/models'
import { ModelDef, LocalModel, DownloadState } from '../types'

interface Props {
  localModels: LocalModel[]
  onRefreshLocal: () => void
  onUseModel: (m: ModelDef) => void
  loadingModel: boolean
  activeModel: ModelDef | null
}

export default function ModelBrowser({ localModels, onRefreshLocal, onUseModel, loadingModel, activeModel }: Props) {
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({})
  const [hfSearch, setHfSearch] = useState('')
  const [hfResults, setHfResults] = useState<any[]>([])
  const [hfLoading, setHfLoading] = useState(false)

  // Attach download event listeners once
  useEffect(() => {
    const off1 = window.api.onDownloadProgress(({ filename, progress }) => {
      setDownloads(prev => ({ ...prev, [filename]: { status: 'downloading', progress } }))
    })
    const off2 = window.api.onDownloadDone(({ filename }) => {
      setDownloads(prev => ({ ...prev, [filename]: { status: 'done', progress: 1 } }))
      onRefreshLocal()
    })
    const off3 = window.api.onDownloadError(({ filename, error }) => {
      setDownloads(prev => ({ ...prev, [filename]: { status: 'error', progress: 0, error } }))
    })
    return () => { off1(); off2(); off3() }
  }, [])

  const isDownloaded = (m: ModelDef) => localModels.some(l => l.filename === m.filename)
  const isDownloading = (m: ModelDef) => downloads[m.filename]?.status === 'downloading'

  const handleDownload = (m: ModelDef) => {
    setDownloads(prev => ({ ...prev, [m.filename]: { status: 'downloading', progress: 0 } }))
    window.api.downloadModel(m.url, m.filename)
  }

  const filtered = MODELS.filter(m => {
    const matchCat = category === 'all' || m.categories.includes(category)
    const q = search.toLowerCase()
    const matchSearch = !q || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q) || m.tags.some(t => t.includes(q))
    return matchCat && matchSearch
  })

  // HuggingFace live search
  const hfTimer = useRef<any>(null)
  const searchHF = (q: string) => {
    setHfSearch(q)
    clearTimeout(hfTimer.current)
    if (!q.trim()) { setHfResults([]); return }
    hfTimer.current = setTimeout(async () => {
      setHfLoading(true)
      try {
        const res = await fetch(
          `https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&limit=12`
        )
        const data = await res.json()
        setHfResults(data)
      } catch { setHfResults([]) }
      setHfLoading(false)
    }, 500)
  }

  return (
    <div className="browser">
      {/* Sidebar */}
      <aside className="browser-sidebar">
        <div className="sidebar-section">
          <p className="sidebar-label">CATEGORY</p>
          {CATEGORIES.map(c => (
            <button
              key={c.id}
              className={`sidebar-item ${category === c.id ? 'active' : ''}`}
              onClick={() => setCategory(c.id)}
            >
              <span className="sidebar-icon">{c.icon}</span>
              {c.label}
            </button>
          ))}
        </div>

        <div className="sidebar-section sidebar-bottom">
          <p className="sidebar-label">DOWNLOADED</p>
          {localModels.length === 0
            ? <p className="sidebar-empty">None yet</p>
            : localModels.map(l => (
              <div key={l.filename} className="sidebar-local">
                <span className="sidebar-local-dot" />
                <span className="sidebar-local-name">{l.filename.replace(/\.gguf$/, '').slice(0, 22)}</span>
              </div>
            ))
          }
        </div>
      </aside>

      {/* Main panel */}
      <div className="browser-main">
        {/* Search bar */}
        <div className="browser-search-row">
          <div className="search-wrap">
            <span className="search-icon">🔍</span>
            <input
              className="search-input"
              placeholder="Filter models…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="hf-search-wrap">
            <span className="search-icon">🤗</span>
            <input
              className="search-input"
              placeholder="Browse HuggingFace…"
              value={hfSearch}
              onChange={e => searchHF(e.target.value)}
            />
          </div>
        </div>

        {/* HuggingFace live results */}
        {(hfSearch || hfLoading) && (
          <div className="hf-results">
            <p className="section-title">
              {hfLoading ? 'Searching HuggingFace…' : `HuggingFace results for "${hfSearch}"`}
            </p>
            <div className="model-grid">
              {hfResults.map(r => (
                <div key={r.id} className="model-card hf-card">
                  <div className="card-header">
                    <span className="card-name">{r.id}</span>
                    <span className="card-stat">↓ {(r.downloads / 1000).toFixed(0)}K</span>
                  </div>
                  <p className="card-desc">{r.cardData?.language?.join(', ') || 'No description'}</p>
                  <div className="card-tags">
                    {(r.tags || []).slice(0, 4).map((t: string) => (
                      <span key={t} className="tag">{t}</span>
                    ))}
                  </div>
                  <a
                    className="btn btn-outline"
                    href={`https://huggingface.co/${r.id}`}
                    target="_blank"
                    rel="noopener"
                  >
                    View on HuggingFace ↗
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Curated model grid */}
        {!hfSearch && (
          <>
            <p className="section-title">
              {category === 'all' ? 'All Models' : CATEGORIES.find(c => c.id === category)?.label}
              <span className="section-count">{filtered.length}</span>
            </p>
            <div className="model-grid">
              {filtered.map(m => {
                const dl = downloads[m.filename]
                const downloaded = isDownloaded(m)
                const downloading = isDownloading(m)
                const isActive = activeModel?.id === m.id

                return (
                  <div key={m.id} className={`model-card ${isActive ? 'model-card--active' : ''}`}>
                    <div className="card-header">
                      <span className="card-name">{m.name}</span>
                      {isActive && <span className="badge-active">Active</span>}
                    </div>

                    <div className="card-meta">
                      <span className="meta-pill">{m.params}</span>
                      <span className="meta-pill">{m.sizeGb} GB</span>
                      {m.categories.map(c => (
                        <span key={c} className={`meta-pill meta-pill--cat cat-${c}`}>{c}</span>
                      ))}
                    </div>

                    <p className="card-desc">{m.description}</p>

                    <div className="card-tags">
                      {m.tags.map(t => <span key={t} className="tag">{t}</span>)}
                    </div>

                    {/* Download progress bar */}
                    {downloading && (
                      <div className="progress-wrap">
                        <div className="progress-bar" style={{ width: `${(dl?.progress || 0) * 100}%` }} />
                        <span className="progress-label">
                          {Math.round((dl?.progress || 0) * 100)}%
                        </span>
                      </div>
                    )}

                    {dl?.status === 'error' && (
                      <p className="card-error">Error: {dl.error}</p>
                    )}

                    <div className="card-actions">
                      {downloaded ? (
                        <button
                          className="btn btn-primary"
                          onClick={() => onUseModel(m)}
                          disabled={loadingModel}
                        >
                          {isActive ? '✓ Active' : 'Use Model →'}
                        </button>
                      ) : downloading ? (
                        <button className="btn btn-ghost" disabled>Downloading…</button>
                      ) : (
                        <button className="btn btn-download" onClick={() => handleDownload(m)}>
                          ↓ Download {m.sizeGb} GB
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
