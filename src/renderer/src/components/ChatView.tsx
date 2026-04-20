import { useState, useEffect, useRef, useCallback } from 'react'
import { ChatMessage, ToolCall, ToolName, TodoItem, DiffFile } from '../types'
import ConnectorBar, { CONNECTORS } from './ConnectorBar'

interface Props { modelName: string; modelType: 'local' | 'api'; workspace: string }

const TOOL_ICONS: Record<ToolName, string> = {
  read_file:  '📄', write_file: '✏️', patch_file: '🔧', run_shell: '⚡', list_dir: '📁',
}
const TOOL_LABELS: Record<ToolName, string> = {
  read_file: 'Read', write_file: 'Write', patch_file: 'Edit', run_shell: 'Shell', list_dir: 'Explore',
}
const DESTRUCTIVE: ToolName[] = ['write_file', 'patch_file', 'run_shell']
const MUTATING: ToolName[]    = ['write_file', 'patch_file']
const MAX_STEPS = 12

function makeSystemPrompt(workspace: string) {
  return `You are a highly capable local AI coding agent. Work autonomously like Claude — never ask the user to run commands or provide file contents. Find everything yourself using tools.

Workspace: ${workspace}

## Task format
When starting a multi-step task, first output a todo list in this exact format:
TODOS:
- [ ] First task
- [ ] Second task
- [ ] Third task
END_TODOS

As you complete each todo, output: DONE_TODO: <exact todo text>

## Tool use (output on their own lines, nothing else on those lines):
THOUGHT: <brief reasoning>
ACTION: <tool_name>
ARGS: {"key": "value"}

You receive: OBSERVATION: <result>
When done: FINAL: <answer>

## Tools
- list_dir:   {"path": "dir"} — list directory
- read_file:  {"path": "file"} — read file
- write_file: {"path": "file", "content": "full content"} — write file
- patch_file: {"path": "file", "old": "exact text", "new": "replacement"} — edit file
- run_shell:  {"command": "cmd"} — run shell/git command

## Rules
- Start with list_dir if you don't know the structure
- Always complete the full task without stopping
- For simple questions, reply directly (no THOUGHT/ACTION needed)`
}

let counter = 0
const uid = () => `m${++counter}`

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseToolCall(text: string): { tool: ToolName; args: Record<string, any> } | null {
  const am = text.match(/ACTION:\s*(\w+)/); if (!am) return null
  const tool = am[1] as ToolName; if (!TOOL_ICONS[tool]) return null
  const rm = text.match(/ARGS:\s*(\{[\s\S]*?\})/)
  let args: Record<string, any> = {}
  if (rm) { try { args = JSON.parse(rm[1]) } catch { const p = [...rm[1].matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]; for (const [,k,v] of p) args[k] = v.replace(/\\n/g,'\n') } }
  return { tool, args }
}

function parseTodos(text: string): TodoItem[] | null {
  const m = text.match(/TODOS:\n([\s\S]*?)END_TODOS/)
  if (!m) return null
  return m[1].trim().split('\n').map((line, i) => {
    const done = line.includes('[x]')
    const itemText = line.replace(/^-\s*\[.?\]\s*/, '').trim()
    return { id: `todo-${i}`, text: itemText, done }
  }).filter(t => t.text)
}

function parseDoneTodo(text: string): string | null {
  const m = text.match(/DONE_TODO:\s*(.+)/)
  return m ? m[1].trim() : null
}

// ─── Diff parser ──────────────────────────────────────────────────────────────

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = []
  const sections = raw.split(/^diff --git /m).filter(Boolean)
  for (const sec of sections) {
    const pathM = sec.match(/a\/(.+?) b\//)
    if (!pathM) continue
    const path = pathM[1]
    let added = 0, removed = 0
    for (const line of sec.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++
      if (line.startsWith('-') && !line.startsWith('---')) removed++
    }
    files.push({ path, added, removed, hunks: sec })
  }
  return files
}

// ─── Tool description helper ──────────────────────────────────────────────────

function toolDesc(tool: ToolName, args: Record<string, any>): string {
  switch (tool) {
    case 'list_dir':   return `List ${args.path || '.'}`
    case 'read_file':  return args.path || ''
    case 'write_file': return args.path || ''
    case 'patch_file': return args.path || ''
    case 'run_shell':  return args.command || ''
    default:           return ''
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ChatView({ modelName, modelType, workspace }: Props) {
  const [messages,     setMessages]     = useState<ChatMessage[]>([{
    id: uid(), role: 'assistant',
    content: `Hi! I'm **${modelName}**${modelType === 'api' ? ' via cloud' : ' running locally'}.\n\nTell me what to do — I'll explore your workspace, read files, make changes, and track progress with a todo list.`,
  }])
  const [input,        setInput]        = useState('')
  const [generating,   setGenerating]   = useState(false)
  const [thinking,     setThinking]     = useState(false)
  const [pendingTool,  setPendingTool]  = useState<{ msgId: string; tool: ToolCall } | null>(null)
  const [activeConns,  setActiveConns]  = useState<Set<string>>(new Set())
  const [busyConns,    setBusyConns]    = useState<Set<string>>(new Set())
  const [diffFiles,    setDiffFiles]    = useState<DiffFile[]>([])
  const [selectedFile, setSelectedFile] = useState<DiffFile | null>(null)
  const [todos,        setTodos]        = useState<TodoItem[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { window.api.chatInit(makeSystemPrompt(workspace)) }, [workspace])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, thinking])

  // ─── Git diff refresh ─────────────────────────────────────────────────────

  const refreshDiff = useCallback(async () => {
    if (workspace === '~') return
    const r = await window.api.runShell('git diff', workspace)
    if (r.ok && r.stdout) {
      const files = parseDiff(r.stdout)
      setDiffFiles(files)
      if (files.length && !selectedFile) setSelectedFile(files[0])
    } else {
      setDiffFiles([])
    }
  }, [workspace, selectedFile])

  // ─── Token streaming ──────────────────────────────────────────────────────

  const appendToken = useCallback((token: string) => {
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.streaming)
        return [...prev.slice(0, -1), { ...last, content: last.content + token }]
      return prev
    })
  }, [])

  // ─── Tool execution ───────────────────────────────────────────────────────

  const executeTool = async (tool: ToolName, args: Record<string, any>): Promise<string> => {
    const cwd = workspace === '~'
      ? (await window.api.getModelsDir()).replace(/\/models$/, '')
      : workspace
    switch (tool) {
      case 'read_file': {
        const r = await window.api.readFile(args.path || '')
        return r.ok ? r.content : `Error: ${r.error}`
      }
      case 'write_file': {
        const r = await window.api.writeFile(args.path || '', args.content || '')
        if (r.ok) refreshDiff()
        return r.ok ? `Written: ${args.path}` : `Error: ${r.error}`
      }
      case 'patch_file': {
        const rf = await window.api.readFile(args.path || '')
        if (!rf.ok) return `Error: ${rf.error}`
        if (!rf.content.includes(args.old || '')) return `Error: old text not found in ${args.path}`
        const wf = await window.api.writeFile(args.path || '', rf.content.replace(args.old, args.new || ''))
        if (wf.ok) refreshDiff()
        return wf.ok ? `Patched: ${args.path}` : `Error: ${wf.error}`
      }
      case 'list_dir': {
        const r = await window.api.listDir(args.path || cwd)
        if (!r.ok) return `Error: ${r.error}`
        return r.entries.map((e: any) =>
          `${e.isDir ? '📁' : '📄'} ${e.name}${e.isDir ? '/' : `  (${fmtSize(e.size)})`}`
        ).join('\n')
      }
      case 'run_shell': {
        const r = await window.api.runShell(args.command || '', cwd)
        if (r.ok && MUTATING.some(t => args.command?.includes('git'))) setTimeout(refreshDiff, 500)
        return r.ok ? [r.stdout, r.stderr].filter(Boolean).join('\n') || '(no output)' : `Error: ${r.error}`
      }
      default: return `Unknown tool: ${tool}`
    }
  }

  // ─── Permission ───────────────────────────────────────────────────────────

  const requestPermission = (msgId: string, toolCall: ToolCall): Promise<boolean> =>
    new Promise(resolve => { setPendingTool({ msgId, tool: toolCall }); (window as any).__pr = resolve })
  const handlePermission = (ok: boolean) => { setPendingTool(null); (window as any).__pr?.(ok) }

  // ─── Connector fetch ──────────────────────────────────────────────────────

  const fetchCtx = useCallback(async (query: string): Promise<string> => {
    if (activeConns.size === 0) return ''
    const ids = [...activeConns]; setBusyConns(new Set(ids))
    try {
      const res = await window.api.connectorSearch(ids, query)
      let ctx = ''
      for (const id of ids) {
        const items = res[id] || []; if (!items.length) continue
        const def = CONNECTORS.find(c => c.id === id)
        ctx += `\n[${def?.icon ?? ''} ${def?.label ?? id}]\n`
        for (const r of items) { ctx += `• ${r.title}${r.url ? ` — ${r.url}` : ''}\n`; if (r.snippet) ctx += `  ${r.snippet.slice(0, 200)}\n` }
      }
      return ctx.trim()
    } finally { setBusyConns(new Set()) }
  }, [activeConns])

  // ─── Stream one turn ──────────────────────────────────────────────────────

  const streamTurn = (msgId: string, prompt: string): Promise<string> =>
    new Promise(resolve => {
      let full = '', first = true
      const offT = window.api.onChatToken(t => { if (first) { first = false; setThinking(false) } full += t; appendToken(t) })
      const offD = window.api.onChatDone(() => { offT(); offD(); resolve(full) })
      const offE = window.api.onChatError(e => {
        offT(); offE()
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, content: m.content || `Error: ${e}`, streaming: false } : m))
        resolve('')
      })
      window.api.sendMessage(prompt)
    })

  // ─── Agent loop ───────────────────────────────────────────────────────────

  const runAgentTurn = useCallback(async (userText: string) => {
    const connCtx = await fetchCtx(userText)
    const firstPrompt = connCtx ? `[Context]\n${connCtx}\n\n---\n${userText}` : userText
    setGenerating(true); setThinking(true)

    let nextPrompt = firstPrompt
    let currentTodos: TodoItem[] = []

    for (let step = 0; step < MAX_STEPS; step++) {
      const aId = uid()
      setMessages(prev => [...prev, { id: aId, role: 'assistant', content: '', streaming: true }])

      const fullText = await streamTurn(aId, nextPrompt)
      setMessages(prev => prev.map(m => m.id === aId ? { ...m, streaming: false } : m))

      // Parse todos from first response
      const todosFromText = parseTodos(fullText)
      if (todosFromText) {
        currentTodos = todosFromText
        setTodos(todosFromText)
        setMessages(prev => prev.map(m => m.id === aId ? { ...m, todos: todosFromText } : m))
      }

      // Mark a todo done
      const doneTodo = parseDoneTodo(fullText)
      if (doneTodo && currentTodos.length) {
        currentTodos = currentTodos.map(t =>
          t.text.toLowerCase() === doneTodo.toLowerCase() ? { ...t, done: true } : t
        )
        setTodos([...currentTodos])
      }

      // Tool call?
      const parsed = parseToolCall(fullText)
      if (!parsed) break

      const { tool, args } = parsed
      const isDestructive = DESTRUCTIVE.includes(tool)
      const tc: ToolCall = { id: uid(), tool, args, status: isDestructive ? 'pending-permission' : 'running' }

      setMessages(prev => prev.map(m => m.id === aId ? { ...m, toolCalls: [...(m.toolCalls || []), tc] } : m))

      const updateTool = (status: ToolCall['status'], result?: string) =>
        setMessages(prev => prev.map(m =>
          m.id !== aId ? m : { ...m, toolCalls: m.toolCalls?.map(t => t.id === tc.id ? { ...t, status, result } : t) }
        ))

      if (isDestructive) {
        const ok = await requestPermission(aId, tc)
        if (!ok) { updateTool('denied'); break }
      }

      updateTool('running')
      const result = await executeTool(tool, args)
      updateTool('done', result)

      nextPrompt = `OBSERVATION:\n${result}`
      setThinking(true)
    }

    setThinking(false); setGenerating(false)
    inputRef.current?.focus()
  }, [appendToken, fetchCtx, workspace, refreshDiff])

  // ─── Submit ───────────────────────────────────────────────────────────────

  const submit = () => {
    const text = input.trim(); if (!text || generating) return
    setInput('')
    setMessages(prev => [...prev, { id: uid(), role: 'user', content: text }])
    runAgentTurn(text)
  }
  const handleKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }

  // ─── Render ───────────────────────────────────────────────────────────────

  const hasDiff = diffFiles.length > 0

  return (
    <div className="chat-root">
      {/* Permission overlay */}
      {pendingTool && (
        <div className="permission-overlay">
          <div className="permission-dialog">
            <div className="permission-header">
              <span className="permission-icon">🔐</span>
              <span className="permission-title">Allow action?</span>
            </div>
            <p className="permission-body">
              The AI wants to run <strong>{TOOL_ICONS[pendingTool.tool.tool]} {pendingTool.tool.tool}</strong>
            </p>
            <div className="permission-args">
              {Object.entries(pendingTool.tool.args).map(([k, v]) => (
                <div key={k} className="permission-arg">
                  <span className="permission-key">{k}</span>
                  <span className="permission-val">{String(v).slice(0, 200)}</span>
                </div>
              ))}
            </div>
            <div className="permission-actions">
              <button className="btn btn-deny" onClick={() => handlePermission(false)}>✕ Deny</button>
              <button className="btn btn-allow" onClick={() => handlePermission(true)}>✓ Allow</button>
            </div>
          </div>
        </div>
      )}

      {/* Left: chat */}
      <div className="chat">
        <div className="chat-messages">
          {messages.map(msg => (
            <div key={msg.id} className={`message message--${msg.role}`}>
              {msg.role === 'assistant' && <div className="message-avatar">🤖</div>}
              <div className="message-body">
                {/* Todos block */}
                {msg.todos && msg.todos.length > 0 && (
                  <TodoBlock todos={msg.todos} live={todos} />
                )}
                {/* Compact tool steps */}
                {msg.toolCalls?.map(tc => <ToolStep key={tc.id} tc={tc} />)}
                {/* Text content */}
                {msg.content && <MarkdownText text={msg.content} streaming={msg.streaming} />}
              </div>
              {msg.role === 'user' && <div className="message-avatar">👤</div>}
            </div>
          ))}

          {thinking && (
            <div className="message message--assistant">
              <div className="message-avatar">🤖</div>
              <div className="message-body">
                <div className="thinking-row">
                  <span className="thinking-label">Thinking</span>
                  <span className="thinking-dots"><span /><span /><span /></span>
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <ConnectorBar active={activeConns} onChange={setActiveConns} busy={busyConns} />

        <div className="chat-input-wrap">
          <div className="chat-input-box">
            <textarea
              ref={inputRef}
              className="chat-input"
              placeholder={generating ? 'Working…' : 'Ask anything…'}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              rows={1}
              disabled={generating}
            />
            <button className={`send-btn ${generating ? 'sending' : ''}`} onClick={submit} disabled={generating || !input.trim()}>
              {generating ? <span className="spin">◌</span> : '↑'}
            </button>
          </div>
          <p className="chat-hint">{modelName} · {workspace !== '~' ? workspace.split('/').pop() : 'no workspace'} · {modelType === 'api' ? 'cloud' : 'offline'}</p>
        </div>
      </div>

      {/* Right: git diff panel */}
      <div className={`diff-panel ${hasDiff ? 'diff-panel--open' : ''}`}>
        <div className="diff-panel-header">
          <span className="diff-panel-title">Git changes</span>
          {hasDiff && (
            <button className="btn-tiny" onClick={refreshDiff} title="Refresh diff">↻</button>
          )}
        </div>

        {hasDiff ? (
          <>
            <div className="diff-file-list">
              {diffFiles.map(f => (
                <button
                  key={f.path}
                  className={`diff-file-row ${selectedFile?.path === f.path ? 'diff-file-row--active' : ''}`}
                  onClick={() => setSelectedFile(f)}
                >
                  <span className="diff-file-icon">📄</span>
                  <span className="diff-file-path">{f.path}</span>
                  <span className="diff-stat-add">+{f.added}</span>
                  <span className="diff-stat-rm">-{f.removed}</span>
                </button>
              ))}
            </div>
            {selectedFile && (
              <div className="diff-hunk-view">
                <DiffHunk raw={selectedFile.hunks} />
              </div>
            )}
          </>
        ) : (
          <div className="diff-empty">
            <span className="diff-empty-icon">📂</span>
            <p>No git changes yet</p>
            <p className="diff-empty-sub">Changes appear here after the AI edits files</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Todo block ───────────────────────────────────────────────────────────────

function TodoBlock({ todos, live }: { todos: TodoItem[]; live: TodoItem[] }) {
  const [open, setOpen] = useState(true)
  const merged = todos.map(t => ({ ...t, done: live.find(l => l.id === t.id)?.done ?? t.done }))
  const done = merged.filter(t => t.done).length

  return (
    <div className="todo-block">
      <button className="todo-header" onClick={() => setOpen(o => !o)}>
        <span className="todo-progress">{done} of {merged.length} todos completed</span>
        <span className="todo-chevron">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <ul className="todo-list">
          {merged.map(t => (
            <li key={t.id} className={`todo-item ${t.done ? 'todo-item--done' : ''}`}>
              <span className="todo-check">{t.done ? '✓' : '○'}</span>
              <span className="todo-text">{t.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Compact tool step (opencode-style) ───────────────────────────────────────

function ToolStep({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const label = TOOL_LABELS[tc.tool] || tc.tool
  const desc  = toolDesc(tc.tool, tc.args)
  const statusDot = {
    'pending-permission': 'dot--yellow',
    'running':            'dot--blue spin-dot',
    'done':               'dot--green',
    'denied':             'dot--red',
  }[tc.status]

  return (
    <div className="tool-step">
      <button className="tool-step-row" onClick={() => setExpanded(e => !e)}>
        <span className={`tool-step-dot ${statusDot}`} />
        <span className="tool-step-label">{label}</span>
        <span className="tool-step-desc">{desc}</span>
        {tc.result && <span className="tool-step-chevron">{expanded ? '▲' : '▼'}</span>}
      </button>
      {expanded && tc.result && (
        <pre className="tool-step-result">{tc.result.slice(0, 2000)}</pre>
      )}
    </div>
  )
}

// ─── Diff hunk renderer ───────────────────────────────────────────────────────

function DiffHunk({ raw }: { raw: string }) {
  const lines = raw.split('\n')
  return (
    <div className="diff-lines">
      {lines.map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add'
                  : line.startsWith('-') && !line.startsWith('---') ? 'diff-rm'
                  : line.startsWith('@@') ? 'diff-hunk'
                  : 'diff-ctx'
        return <div key={i} className={`diff-line ${cls}`}><pre>{line}</pre></div>
      })}
    </div>
  )
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

function MarkdownText({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = text
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_,l,c) => `<pre class="code-block" data-lang="${l}"><code>${esc(c.trim())}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n/g, '<br/>')
  return (
    <div
      className={`md-text ${streaming ? 'streaming' : ''}`}
      dangerouslySetInnerHTML={{ __html: html + (streaming ? '<span class="cursor">▋</span>' : '') }}
    />
  )
}

function esc(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function fmtSize(b: number) { return b < 1024 ? `${b}B` : b < 1048576 ? `${(b/1024).toFixed(0)}KB` : `${(b/1048576).toFixed(1)}MB` }
