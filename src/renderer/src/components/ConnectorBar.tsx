interface ConnectorDef {
  id:    string
  label: string
  icon:  string
  color: string
  desc:  string
}

export const CONNECTORS: ConnectorDef[] = [
  { id: 'web',           label: 'Web',          icon: '🌐', color: '#6366f1', desc: 'DuckDuckGo search results' },
  { id: 'wikipedia',     label: 'Wikipedia',    icon: '📖', color: '#10b981', desc: 'Wikipedia articles' },
  { id: 'github',        label: 'GitHub',       icon: '🐙', color: '#e2e8f0', desc: 'GitHub repositories' },
  { id: 'npm',           label: 'npm',          icon: '📦', color: '#cb3837', desc: 'npm package registry' },
  { id: 'stackoverflow', label: 'Stack Overflow', icon: '💬', color: '#f48024', desc: 'Stack Overflow Q&A' },
  { id: 'huggingface',   label: 'HuggingFace',  icon: '🤗', color: '#ff9d00', desc: 'Models & papers' },
]

interface Props {
  active:   Set<string>
  onChange: (active: Set<string>) => void
  busy:     Set<string>          // connectors currently fetching
}

export default function ConnectorBar({ active, onChange, busy }: Props) {
  const toggle = (id: string) => {
    const next = new Set(active)
    next.has(id) ? next.delete(id) : next.add(id)
    onChange(next)
  }

  return (
    <div className="connector-bar">
      <span className="connector-label">Sources</span>
      <div className="connector-chips">
        {CONNECTORS.map(c => {
          const isActive = active.has(c.id)
          const isBusy   = busy.has(c.id)
          return (
            <button
              key={c.id}
              className={`connector-chip ${isActive ? 'connector-chip--active' : ''}`}
              style={isActive ? { '--chip-color': c.color } as any : {}}
              onClick={() => toggle(c.id)}
              title={c.desc}
              disabled={isBusy}
            >
              <span className="chip-icon">{isBusy ? '⟳' : c.icon}</span>
              <span className="chip-label">{c.label}</span>
              {isActive && !isBusy && <span className="chip-check">✓</span>}
              {isBusy && <span className="chip-spinner" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
