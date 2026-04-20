import { useState, useEffect, useRef } from 'react'
import {
  IMAGE_MODELS, IMG_GENRES, STYLE_PRESETS, FIX_OPTIONS,
  BASE_POSITIVE, BASE_NEGATIVE, ImageModelDef, StylePreset,
} from '../data/image-models'

const RESOLUTIONS = [
  { label: '512 × 512',   w: 512,  h: 512  },
  { label: '512 × 768',   w: 512,  h: 768  },
  { label: '768 × 512',   w: 768,  h: 512  },
  { label: '768 × 768',   w: 768,  h: 768  },
  { label: '768 × 1024',  w: 768,  h: 1024 },
  { label: '1024 × 768',  w: 1024, h: 768  },
  { label: '1024 × 1024', w: 1024, h: 1024 },
]

interface LoraEntry { file: string; weight: number }
interface HistoryItem { path: string; prompt: string; ts: number }

export default function ImageGen() {
  // ── State ─────────────────────────────────────────────────────────────────
  const [nsfwEnabled,   setNsfwEnabled]   = useState(false)
  const [genre,         setGenre]         = useState('all')
  const [selectedModel, setSelectedModel] = useState<ImageModelDef | null>(null)
  const [localModels,   setLocalModels]   = useState<string[]>([])
  const [loras,         setLoras]         = useState<string[]>([])
  const [activeLoras,   setActiveLoras]   = useState<LoraEntry[]>([])
  const [style,         setStyle]         = useState<StylePreset>(STYLE_PRESETS[0])
  const [fixes,         setFixes]         = useState<Set<string>>(new Set(['hands', 'face']))
  const [prompt,        setPrompt]        = useState('')
  const [negPrompt,     setNegPrompt]     = useState('')
  const [resolution,    setResolution]    = useState(RESOLUTIONS[0])
  const [steps,         setSteps]         = useState(20)
  const [cfg,           setCfg]           = useState(7)
  const [seed,          setSeed]          = useState(-1)
  const [generating,    setGenerating]    = useState(false)
  const [progress,      setProgress]      = useState<{ step: number; total: number; percent: number } | null>(null)
  const [currentImage,  setCurrentImage]  = useState<string | null>(null)
  const [history,       setHistory]       = useState<HistoryItem[]>([])
  const [binStatus,     setBinStatus]     = useState<'checking'|'ready'|'missing'|'downloading'>('checking')
  const [binProgress,   setBinProgress]   = useState(0)
  const [downloading,   setDownloading]   = useState<string | null>(null)
  const [dlProgress,    setDlProgress]    = useState(0)
  const [error,         setError]         = useState<string | null>(null)

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    window.api.imgCheckBin().then(ok => setBinStatus(ok ? 'ready' : 'missing'))
    window.api.imgScanModels().then(setLocalModels)
    window.api.imgScanLoras().then(setLoras)
    // progress events
    const off1 = window.api.onImgProgress((p: any) => setProgress(p))
    const off2 = window.api.onImgDone(({ path }: any) => {
      setCurrentImage(`file://${path}`)
      setHistory(h => [{ path, prompt: prompt.slice(0, 60), ts: Date.now() }, ...h].slice(0, 20))
      setGenerating(false)
      setProgress(null)
    })
    const off3 = window.api.onImgError((e: string) => { setError(e); setGenerating(false); setProgress(null) })
    const off4 = window.api.onImgBinProgress(({ progress: p }: any) => setBinProgress(p))
    const off5 = window.api.onImgBinDone(() => {
      setBinStatus('ready')
      setBinProgress(1)
    })
    const off6 = window.api.onImgBinError((e: string) => {
      setBinStatus('missing')
      setError(`Engine download failed: ${e}`)
    })
    return () => { off1(); off2(); off3(); off4(); off5(); off6() }
  }, [prompt])

  const refreshModels = () => {
    window.api.imgScanModels().then(setLocalModels)
    window.api.imgScanLoras().then(setLoras)
  }

  // ── Download model ────────────────────────────────────────────────────────
  const startModelDownload = (m: ImageModelDef) => {
    setDownloading(m.filename)
    setDlProgress(0)
    window.api.imgDownloadModel(m.url, m.filename)
  }

  useEffect(() => {
    const off1 = window.api.onImgModelProgress(({ filename, progress }: any) => {
      if (filename === downloading) setDlProgress(progress)
    })
    const off2 = window.api.onImgModelDone(({ filename }: any) => {
      if (filename === downloading) { setDownloading(null); refreshModels() }
    })
    return () => { off1(); off2() }
  }, [downloading])

  // ── Build final prompts ───────────────────────────────────────────────────
  const buildPrompts = () => {
    const posExtra: string[] = []
    const negExtra: string[] = []

    if (style.id !== 'none') { posExtra.push(style.positive); negExtra.push(style.negative) }
    for (const id of fixes) {
      const f = FIX_OPTIONS.find(o => o.id === id)
      if (f) { posExtra.push(f.addPositive); negExtra.push(f.addNegative) }
    }

    const finalPos = [BASE_POSITIVE, prompt, ...posExtra].filter(Boolean).join(', ')
    const finalNeg = [BASE_NEGATIVE, negPrompt, ...negExtra].filter(Boolean).join(', ')
    return { finalPos, finalNeg }
  }

  const handleGenerate = () => {
    if (!selectedModel) { setError('Select a model first'); return }
    if (!localModels.includes(selectedModel.filename)) { setError('Download the model first'); return }
    setError(null)
    setGenerating(true)
    const { finalPos, finalNeg } = buildPrompts()
    window.api.imgGenerate({
      modelFile:  selectedModel.filename,
      prompt:     finalPos,
      negPrompt:  finalNeg,
      width:      resolution.w,
      height:     resolution.h,
      steps,
      cfgScale:   cfg,
      seed,
      loras:      activeLoras,
    })
  }

  // ── LoRA helpers ──────────────────────────────────────────────────────────
  const addLora = (file: string) => {
    if (!activeLoras.find(l => l.file === file)) setActiveLoras(a => [...a, { file, weight: 0.8 }])
  }
  const removeLora = (file: string) => setActiveLoras(a => a.filter(l => l.file !== file))
  const setLoraWeight = (file: string, weight: number) =>
    setActiveLoras(a => a.map(l => l.file === file ? { ...l, weight } : l))

  // ── Filtered models ───────────────────────────────────────────────────────
  const filteredModels = IMAGE_MODELS.filter(m => {
    if (!nsfwEnabled && m.nsfw) return false
    if (genre !== 'all' && !m.genres.includes(genre)) return false
    return true
  })

  // ── Download binary ───────────────────────────────────────────────────────
  const downloadBin = () => {
    setBinStatus('downloading')
    window.api.imgDownloadBin()
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="imggen">
      {/* ── Left: controls ───────────────────────────────────────────────── */}
      <div className="imggen-left">
        {/* Binary status */}
        {binStatus === 'missing' && (
          <div className="imggen-alert">
            <p>⚠️ sd.cpp engine not downloaded yet.</p>
            <button className="btn btn-primary" onClick={downloadBin}>Download Engine (~30MB)</button>
          </div>
        )}
        {binStatus === 'downloading' && (
          <div className="imggen-alert">
            <p>Downloading engine… {Math.round(binProgress * 100)}%</p>
            <div className="progress-wrap"><div className="progress-bar" style={{ width: `${binProgress * 100}%` }} /></div>
          </div>
        )}

        {/* NSFW toggle */}
        <div className="imggen-row imggen-row--space">
          <span className="imggen-section-label">🔞 NSFW Models</span>
          <button
            className={`toggle-btn ${nsfwEnabled ? 'toggle-btn--on' : ''}`}
            onClick={() => setNsfwEnabled(e => !e)}
          >
            {nsfwEnabled ? 'ON' : 'OFF'}
          </button>
        </div>

        {/* Genre filter */}
        <div className="imggen-section">
          <p className="imggen-section-label">Genre</p>
          <div className="genre-chips">
            {IMG_GENRES.map(g => (
              <button key={g.id} className={`genre-chip ${genre === g.id ? 'genre-chip--active' : ''}`} onClick={() => setGenre(g.id)}>
                {g.icon} {g.label}
              </button>
            ))}
          </div>
        </div>

        {/* Model list */}
        <div className="imggen-section imggen-models">
          <p className="imggen-section-label">Model</p>
          <div className="img-model-list">
            {filteredModels.map(m => {
              const isLocal    = localModels.includes(m.filename)
              const isSelected = selectedModel?.id === m.id
              const isDl       = downloading === m.filename

              return (
                <div
                  key={m.id}
                  className={`img-model-row ${isSelected ? 'img-model-row--active' : ''}`}
                  onClick={() => isLocal && setSelectedModel(m)}
                >
                  <span className="img-model-preview">{m.preview ?? '🖼'}</span>
                  <div className="img-model-info">
                    <span className="img-model-name">{m.name}</span>
                    <span className="img-model-meta">{m.sizeGb}GB{m.nsfw ? ' · 🔞' : ''}</span>
                  </div>
                  <div className="img-model-action">
                    {isLocal ? (
                      <span className="img-model-badge">{isSelected ? '✓ Active' : 'Use'}</span>
                    ) : isDl ? (
                      <div className="img-dl-mini">
                        <div className="img-dl-mini-fill" style={{ width: `${dlProgress * 100}%` }} />
                        <span>{Math.round(dlProgress * 100)}%</span>
                      </div>
                    ) : (
                      <button className="btn-tiny" onClick={e => { e.stopPropagation(); startModelDownload(m) }}>
                        ↓ {m.sizeGb}GB
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* LoRA section */}
        <div className="imggen-section">
          <div className="imggen-row imggen-row--space">
            <p className="imggen-section-label">LoRA</p>
            <button className="btn-tiny" onClick={() => window.api.imgOpenLoraDir()}>Open folder</button>
          </div>
          {loras.length === 0
            ? <p className="imggen-empty">Drop .safetensors LoRA files into the LoRA folder</p>
            : loras.map(f => {
              const active = activeLoras.find(l => l.file === f)
              return (
                <div key={f} className="lora-row">
                  <button
                    className={`lora-toggle ${active ? 'lora-toggle--on' : ''}`}
                    onClick={() => active ? removeLora(f) : addLora(f)}
                  >
                    {active ? '✓' : '+'}
                  </button>
                  <span className="lora-name">{f.replace(/\.(safetensors|pt|ckpt)$/, '')}</span>
                  {active && (
                    <input
                      type="range" min="0" max="1.5" step="0.05"
                      value={active.weight}
                      className="lora-slider"
                      onChange={e => setLoraWeight(f, Number(e.target.value))}
                    />
                  )}
                  {active && <span className="lora-weight">{active.weight.toFixed(2)}</span>}
                </div>
              )
            })
          }
          <button className="btn-tiny" style={{ marginTop: 6 }} onClick={refreshModels}>↻ Refresh</button>
        </div>

        {/* Style presets */}
        <div className="imggen-section">
          <p className="imggen-section-label">Style</p>
          <div className="style-chips">
            {STYLE_PRESETS.map(s => (
              <button key={s.id} className={`style-chip ${style.id === s.id ? 'style-chip--active' : ''}`} onClick={() => setStyle(s)}>
                {s.icon} {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Fix options */}
        <div className="imggen-section">
          <p className="imggen-section-label">Fixes</p>
          <div className="fix-chips">
            {FIX_OPTIONS.map(f => (
              <button
                key={f.id}
                className={`fix-chip ${fixes.has(f.id) ? 'fix-chip--active' : ''}`}
                onClick={() => setFixes(prev => { const n = new Set(prev); n.has(f.id) ? n.delete(f.id) : n.add(f.id); return n })}
                title={f.addNegative}
              >
                {f.icon} {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Resolution + sliders */}
        <div className="imggen-section">
          <p className="imggen-section-label">Size</p>
          <select className="imggen-select" value={`${resolution.w}x${resolution.h}`} onChange={e => {
            const r = RESOLUTIONS.find(r => `${r.w}x${r.h}` === e.target.value)
            if (r) setResolution(r)
          }}>
            {RESOLUTIONS.map(r => <option key={r.label} value={`${r.w}x${r.h}`}>{r.label}</option>)}
          </select>
        </div>

        <div className="imggen-sliders">
          <label className="slider-label">
            <span>Steps <strong>{steps}</strong></span>
            <input type="range" min="1" max="50" value={steps} onChange={e => setSteps(Number(e.target.value))} />
          </label>
          <label className="slider-label">
            <span>CFG Scale <strong>{cfg}</strong></span>
            <input type="range" min="1" max="20" step="0.5" value={cfg} onChange={e => setCfg(Number(e.target.value))} />
          </label>
          <label className="slider-label">
            <span>Seed <strong>{seed === -1 ? 'Random' : seed}</strong></span>
            <div className="seed-row">
              <input type="range" min="-1" max="2147483647" value={seed} onChange={e => setSeed(Number(e.target.value))} />
              <button className="btn-tiny" onClick={() => setSeed(-1)}>🎲</button>
            </div>
          </label>
        </div>
      </div>

      {/* ── Right: prompt + output ───────────────────────────────────────── */}
      <div className="imggen-right">
        {/* Prompt */}
        <div className="imggen-prompts">
          <div className="prompt-block">
            <label className="prompt-label">✨ Prompt</label>
            <textarea
              className="prompt-input"
              placeholder="Describe what you want to generate…"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={3}
            />
          </div>
          <div className="prompt-block">
            <label className="prompt-label">🚫 Exclude (negative prompt)</label>
            <textarea
              className="prompt-input prompt-input--neg"
              placeholder="What to avoid…"
              value={negPrompt}
              onChange={e => setNegPrompt(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        {error && <div className="imggen-error">{error}</div>}

        {/* Generate button */}
        <div className="imggen-generate-row">
          <button
            className="btn-generate"
            onClick={handleGenerate}
            disabled={generating || binStatus !== 'ready' || !selectedModel}
          >
            {generating ? `Generating… ${progress?.percent ?? 0}%` : '🎨 Generate'}
          </button>
          {generating && (
            <button className="btn-tiny btn-cancel" onClick={() => window.api.imgCancel()}>✕ Cancel</button>
          )}
        </div>

        {/* Progress bar */}
        {generating && progress && (
          <div className="imggen-progress">
            <div className="progress-wrap" style={{ height: 6 }}>
              <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
            </div>
            <span className="imggen-progress-label">Step {progress.step} / {progress.total}</span>
          </div>
        )}

        {/* Output image */}
        <div className="imggen-canvas">
          {currentImage ? (
            <img src={currentImage} className="imggen-output" alt="Generated" />
          ) : (
            <div className="imggen-placeholder">
              <span className="imggen-placeholder-icon">🎨</span>
              <p>Your image will appear here</p>
              <p className="imggen-placeholder-sub">
                {!selectedModel ? 'Select and download a model to get started' : 'Hit Generate to create an image'}
              </p>
            </div>
          )}
        </div>

        {/* History strip */}
        {history.length > 0 && (
          <div className="imggen-history">
            {history.map(h => (
              <button key={h.ts} className="history-thumb" onClick={() => setCurrentImage(`file://${h.path}`)}>
                <img src={`file://${h.path}`} alt={h.prompt} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
