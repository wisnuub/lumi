import { useState, useEffect, useRef, useCallback } from 'react'
import { ModelDef, ChatMessage, ToolCall, ToolName } from '../types'
import ConnectorBar, { CONNECTORS } from './ConnectorBar'

interface Props {
  model:     ModelDef
  workspace: string
}

const TOOL_ICONS: Record<ToolName, string> = {
  read_file:   '📄',
  write_file:  '✏️',
  patch_file:  '🔧',
  run_shell:   '⚡',
  list_dir:    '📁',
}

const DESTRUCTIVE: ToolName[] = ['write_file', 'patch_file', 'run_shell']
const MAX_STEPS = 8

function makeSystemPrompt(workspace: string) {
  return `You are a highly capable local AI coding agent. You work like Claude — confident, thorough, and autonomous. You complete tasks fully without asking for clarification. When you need more info, use your tools to find it yourself.

Workspace: ${workspace}

## Tool use
When you need a tool, output EXACTLY (on their own lines, no extra text):

THOUGHT: <brief reasoning>
ACTION: <tool_name>
ARGS: {"key": "value"}

You will receive: OBSERVATION: <result>
Keep using tools until the task is done, then output: FINAL: <your answer>

## Available tools
- list_dir:    {"path": "directory path"} — list files and folders
- read_file:   {"path": "file path"} — read file contents
- write_file:  {"path": "file path", "content": "full content"} — write/create file
- patch_file:  {"path": "file path", "old": "exact text", "new": "replacement"} — edit part of a file
- run_shell:   {"command": "shell command"} — run any shell/git command in the workspace

## Rules
- Never ask the user to run commands or provide file contents — do it yourself with tools
- If you don't know what files exist, start with list_dir on the workspace
- Always complete the full task. Don't stop partway through
- For simple questions that don't need files, reply directly (no THOUGHT/ACTION needed)`
}

let msgIdCounter = 0
const uid = () => `msg-${++msgIdCounter}-${Math.random().toString(36).slice(2, 7)}`

function parseToolCall(text: string): { tool: ToolName; args: Record<string, any> } | null {
  const actionMatch = text.match(/ACTION:\s*(\w+)/)
  if (!actionMatch) return null
  const tool = actionMatch[1] as ToolName
  if (!TOOL_ICONS[tool]) return null
  const argsMatch = text.match(/ARGS:\s*(\{[\s\S]*?\})/)
  let args: Record<string, any> = {}
  if (argsMatch) {
    try { args = JSON.parse(argsMatch[1]) }
    catch {
      const pairs = [...argsMatch[1].matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
      for (const [, k, v] of pairs) args[k] = v.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    }
  }
  return { tool, args }
}

export default function ChatView({ model, workspace }: Props) {
  const [messages,    setMessages]    = useState<ChatMessage[]>([{
    id: uid(), role: 'assistant',
    content: `Hi! I'm running **${model.name}** locally.\n\nI can read/write files, run shell & git commands, and search the web. Just tell me what to do — I'll figure it out.`,
  }])
  const [input,       setInput]       = useState('')
  const [generating,  setGenerating]  = useState(false)
  const [thinking,    setThinking]    = useState(false)
  const [pendingTool, setPendingTool] = useState<{ msgId: string; tool: ToolCall } | null>(null)
  const [activeConns, setActiveConns] = useState<Set<string>>(new Set())
  const [busyConns,   setBusyConns]   = useState<Set<string>>(new Set())
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { window.api.chatInit(makeSystemPrompt(workspace)) }, [workspace])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, thinking])

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
        return r.ok ? `Written: ${args.path}` : `Error: ${r.error}`
      }
      case 'patch_file': {
        const rf = await window.api.readFile(args.path || '')
        if (!rf.ok) return `Error: ${rf.error}`
        if (!rf.content.includes(args.old || '')) return `Error: snippet not found in ${args.path}`
        const wf = await window.api.writeFile(args.path || '', rf.content.replace(args.old, args.new || ''))
        return wf.ok ? `Patched: ${args.path}` : `Error: ${wf.error}`
      }
      case 'list_dir': {
        const r = await window.api.listDir(args.path || cwd)
        if (!r.ok) return `Error: ${r.error}`
        return r.entries.map((e: any) =>
          `${e.isDir ? '📁' : '📄'}  ${e.name}${e.isDir ? '/' : `  (${fmtSize(e.size)})`}`
        ).join('\n')
      }
      case 'run_shell': {
        const r = await window.api.runShell(args.command || '', cwd)
        return r.ok
          ? [r.stdout, r.stderr].filter(Boolean).join('\n') || '(no output)'
          : `Error: ${r.error}`
      }
      default: return `Unknown tool: ${tool}`
    }
  }

  // ─── Permission prompt ────────────────────────────────────────────────────

  const requestPermission = (msgId: string, toolCall: ToolCall): Promise<boolean> =>
    new Promise(resolve => {
      setPendingTool({ msgId, tool: toolCall })
      ;(window as any).__permissionResolve = resolve
    })

  const handlePermission = (allowed: boolean) => {
    setPendingTool(null)
    ;(window as any).__permissionResolve?.(allowed)
  }

  // ─── Connector fetch ──────────────────────────────────────────────────────

  const fetchConnectorContext = useCallback(async (query: string): Promise<string> => {
    if (activeConns.size === 0) return ''
    const ids = [...activeConns]
    setBusyConns(new Set(ids))
    try {
      const results = await window.api.connectorSearch(ids, query)
      let ctx = ''
      for (const id of ids) {
        const items = results[id] || []
        if (!items.length) continue
        const def = CONNECTORS.find(c => c.id === id)
        ctx += `\n[${def?.icon ?? ''} ${def?.label ?? id} Results]\n`
        for (const r of items) {
          ctx += `• ${r.title}${r.url ? ` — ${r.url}` : ''}\n`
          if (r.snippet) ctx += `  ${r.snippet.slice(0, 280)}\n`
        }
      }
      return ctx.trim()
    } finally {
      setBusyConns(new Set())
    }
  }, [activeConns])

  // ─── Stream one model turn, return full text ──────────────────────────────

  const streamTurn = (msgId: string, prompt: string): Promise<string> =>
    new Promise(resolve => {
      let full = ''
      let firstToken = true
      const offToken = window.api.onChatToken(t => {
        if (firstToken) { firstToken = false; setThinking(false) }
        full += t
        appendToken(t)
      })
      const offDone = window.api.onChatDone(() => { offToken(); offDone(); resolve(full) })
      const offErr  = window.api.onChatError(e => {
        offToken(); offErr()
        setMessages(prev => prev.map(m =>
          m.id === msgId ? { ...m, content: m.content || `Error: ${e}`, streaming: false } : m
        ))
        resolve('')
      })
      window.api.sendMessage(prompt)
    })

  // ─── Main agent loop ──────────────────────────────────────────────────────

  const runAgentTurn = useCallback(async (userText: string) => {
    const connCtx = await fetchConnectorContext(userText)
    const firstPrompt = connCtx
      ? `[Context]\n${connCtx}\n\n---\n${userText}`
      : userText

    setGenerating(true)
    setThinking(true)

    let nextPrompt = firstPrompt

    for (let step = 0; step < MAX_STEPS; step++) {
      const aId = uid()
      setMessages(prev => [...prev, { id: aId, role: 'assistant', content: '', streaming: true }])

      const fullText = await streamTurn(aId, nextPrompt)

      setMessages(prev => prev.map(m => m.id === aId ? { ...m, streaming: false } : m))

      const parsed = parseToolCall(fullText)
      if (!parsed) break  // no tool call → done

      const { tool, args } = parsed
      const isDestructive = DESTRUCTIVE.includes(tool)
      const toolCallObj: ToolCall = {
        id: uid(), tool, args,
        status: isDestructive ? 'pending-permission' : 'running',
      }

      setMessages(prev => prev.map(m =>
        m.id === aId ? { ...m, toolCalls: [toolCallObj] } : m
      ))

      const updateTool = (status: ToolCall['status'], result?: string, error?: string) =>
        setMessages(prev => prev.map(m =>
          m.id !== aId ? m : {
            ...m,
            toolCalls: m.toolCalls?.map(tc =>
              tc.id === toolCallObj.id ? { ...tc, status, result, error } : tc
            )
          }
        ))

      if (isDestructive) {
        const allowed = await requestPermission(aId, toolCallObj)
        if (!allowed) { updateTool('denied'); break }
      }

      updateTool('running')
      const result = await executeTool(tool, args)
      updateTool('done', result)

      nextPrompt = `OBSERVATION:\n${result}`
      setThinking(true)
    }

    setThinking(false)
    setGenerating(false)
    inputRef.current?.focus()
  }, [appendToken, fetchConnectorContext, workspace])

  // ─── Submit ───────────────────────────────────────────────────────────────

  const submit = () => {
    const text = input.trim()
    if (!text || generating) return
    setInput('')
    setMessages(prev => [...prev, { id: uid(), role: 'user', content: text }])
    runAgentTurn(text)
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="chat">
      {pendingTool && (
        <div className="permission-overlay">
          <div className="permission-dialog">
            <div className="permission-header">
              <span className="permission-icon">🔐</span>
              <span className="permission-title">Permission Required</span>
            </div>
            <p className="permission-body">
              The AI wants to run <strong>{TOOL_ICONS[pendingTool.tool.tool]} {pendingTool.tool.tool}</strong>
            </p>
            <div className="permission-args">
              {Object.entries(pendingTool.tool.args).map(([k, v]) => (
                <div key={k} className="permission-arg">
                  <span className="permission-key">{k}</span>
                  <span className="permission-val">{String(v).slice(0, 200)}{String(v).length > 200 ? '…' : ''}</span>
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

      <div className="chat-messages">
        {messages.map(msg => (
          <div key={msg.id} className={`message message--${msg.role}`}>
            <div className="message-avatar">{msg.role === 'user' ? '👤' : '🤖'}</div>
            <div className="message-body">
              <MarkdownText text={msg.content} streaming={msg.streaming} />
              {msg.toolCalls?.map(tc => <ToolCard key={tc.id} tc={tc} />)}
            </div>
          </div>
        ))}

        {/* Thinking indicator — shown before first token of each turn */}
        {thinking && (
          <div className="message message--assistant">
            <div className="message-avatar">🤖</div>
            <div className="message-body">
              <div className="thinking-row">
                <span className="thinking-label">Thinking</span>
                <span className="thinking-dots">
                  <span /><span /><span />
                </span>
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
            placeholder={generating ? 'Working…' : 'What do you need? (Shift+Enter for newline)'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            rows={1}
            disabled={generating}
          />
          <button
            className={`send-btn ${generating ? 'sending' : ''}`}
            onClick={submit}
            disabled={generating || !input.trim()}
          >
            {generating ? <span className="spin">◌</span> : '↑'}
          </button>
        </div>
        <p className="chat-hint">
          {model.name} · {workspace !== '~' ? workspace.split('/').pop() : 'no workspace'} · offline
        </p>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToolCard({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const icon = TOOL_ICONS[tc.tool] || '⚙'
  const statusColor = {
    'pending-permission': '#f59e0b',
    'running':            '#6366f1',
    'done':               '#10b981',
    'denied':             '#ef4444',
  }[tc.status]

  return (
    <div className="tool-card" style={{ borderLeftColor: statusColor }}>
      <button className="tool-card-header" onClick={() => setExpanded(e => !e)}>
        <span>{icon} <strong>{tc.tool}</strong></span>
        <span className="tool-status" style={{ color: statusColor }}>
          {tc.status === 'pending-permission' && '⏳ waiting'}
          {tc.status === 'running'            && '⟳ running'}
          {tc.status === 'done'               && '✓ done'}
          {tc.status === 'denied'             && '✕ denied'}
        </span>
        <span className="tool-chevron">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="tool-card-body">
          <div className="tool-args">
            {Object.entries(tc.args).map(([k, v]) => (
              <div key={k} className="tool-arg-row">
                <span className="tool-arg-key">{k}:</span>
                <pre className="tool-arg-val">{String(v).slice(0, 500)}</pre>
              </div>
            ))}
          </div>
          {tc.result && (
            <pre className="tool-result">{tc.result.slice(0, 1000)}{tc.result.length > 1000 ? '\n…' : ''}</pre>
          )}
          {tc.error && <p className="tool-error">Error: {tc.error}</p>}
        </div>
      )}
    </div>
  )
}

function MarkdownText({ text, streaming }: { text: string; streaming?: boolean }) {
  const rendered = text
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
      `<pre class="code-block" data-lang="${lang}"><code>${esc(code.trim())}</code></pre>`
    )
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>')

  return (
    <div
      className={`md-text ${streaming ? 'streaming' : ''}`}
      dangerouslySetInnerHTML={{ __html: rendered + (streaming ? '<span class="cursor">▋</span>' : '') }}
    />
  )
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
