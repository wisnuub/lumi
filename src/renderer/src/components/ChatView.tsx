import { useState, useEffect, useRef, useCallback } from 'react'
import { ModelDef, ChatMessage, ToolCall, ToolName } from '../types'

interface Props {
  model: ModelDef
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

// System prompt instructing model to emit tool calls in a parseable format
const AGENT_SYSTEM = `You are a local AI coding agent (like VSCode with AI). You can use tools to read/write files, run shell commands, and help with any coding task.

When you need to use a tool, output EXACTLY this format (nothing else on those lines):

THOUGHT: <your reasoning>
ACTION: <tool_name>
ARGS: {"key": "value"}

Available tools:
- read_file: {"path": "..."}
- write_file: {"path": "...", "content": "..."}
- patch_file: {"path": "...", "old": "...", "new": "..."}
- list_dir: {"path": "..."}
- run_shell: {"command": "..."}

After tool results you will see OBSERVATION: <result>. Continue reasoning until done, then output FINAL: <answer>.
For simple questions with no file operations, just reply directly (no THOUGHT/ACTION needed).`

let msgIdCounter = 0
const uid = () => `msg-${++msgIdCounter}-${Math.random().toString(36).slice(2, 7)}`

// Parse ACTION + ARGS from model output
function parseToolCall(text: string): { tool: ToolName; args: Record<string, string> } | null {
  const actionMatch = text.match(/ACTION:\s*(\w+)/)
  if (!actionMatch) return null
  const tool = actionMatch[1] as ToolName
  if (!TOOL_ICONS[tool]) return null

  const argsMatch = text.match(/ARGS:\s*(\{[\s\S]*?\})/)
  let args: Record<string, string> = {}
  if (argsMatch) {
    try {
      args = JSON.parse(argsMatch[1])
    } catch {
      const pairs = [...argsMatch[1].matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
      for (const [, k, v] of pairs) args[k] = v.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    }
  }
  return { tool, args }
}

export default function ChatView({ model, workspace }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([{
    id: uid(),
    role: 'assistant',
    content: `Hi! I'm running **${model.name}** locally.\n\nI can read/write files, run shell and git commands, and help with any coding task. What would you like to work on?`,
  }])
  const [input, setInput] = useState('')
  const [generating, setGenerating] = useState(false)
  const [pendingTool, setPendingTool] = useState<{ msgId: string; tool: ToolCall } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ─── Token streaming ──────────────────────────────────────────────────────

  const appendToken = useCallback((token: string) => {
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, content: last.content + token }]
      }
      return prev
    })
  }, [])

  // ─── Tool execution ───────────────────────────────────────────────────────

  const executeTool = async (tool: ToolName, args: Record<string, string>): Promise<string> => {
    const cwd = workspace === '~' ? (await window.api.getModelsDir()).replace(/\/models$/, '') : workspace

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
        // patch_file: read → replace → write
        const rf = await window.api.readFile(args.path || '')
        if (!rf.ok) return `Error: ${rf.error}`
        if (!rf.content.includes(args.old || '')) return `Error: snippet not found in ${args.path}`
        const newContent = rf.content.replace(args.old, args.new || '')
        const wf = await window.api.writeFile(args.path || '', newContent)
        return wf.ok ? `Patched: ${args.path}` : `Error: ${wf.error}`
      }
      case 'list_dir': {
        const r = await window.api.listDir(args.path || cwd)
        if (!r.ok) return `Error: ${r.error}`
        return r.entries.map((e: any) => `${e.isDir ? '📁' : '📄'}  ${e.name}${e.isDir ? '/' : `  (${formatSize(e.size)})`}`).join('\n')
      }
      case 'run_shell': {
        const r = await window.api.runShell(args.command || '', cwd)
        return r.ok
          ? [r.stdout, r.stderr].filter(Boolean).join('\n') || '(no output)'
          : `Error: ${r.error}`
      }
      default:
        return `Unknown tool: ${tool}`
    }
  }

  // ─── Permission prompt ────────────────────────────────────────────────────

  const requestPermission = (msgId: string, toolCall: ToolCall): Promise<boolean> => {
    return new Promise(resolve => {
      setPendingTool({ msgId, tool: toolCall })
      // result resolved by Allow/Deny buttons via handlePermission
      ;(window as any).__permissionResolve = resolve
    })
  }

  const handlePermission = (allowed: boolean) => {
    const resolve = (window as any).__permissionResolve
    setPendingTool(null)
    resolve?.(allowed)
  }

  // ─── Agent turn ───────────────────────────────────────────────────────────

  const runAgentTurn = useCallback(async (userText: string) => {
    setGenerating(true)

    // Add streaming assistant message
    const aId = uid()
    setMessages(prev => [...prev, { id: aId, role: 'assistant', content: '', streaming: true }])

    // Collect full streamed text
    let fullText = ''

    await new Promise<void>(resolve => {
      const offToken = window.api.onChatToken(t => {
        fullText += t
        appendToken(t)
      })
      const offDone = window.api.onChatDone(() => { offToken(); offDone(); resolve() })
      const offErr  = window.api.onChatError(e => {
        offToken(); offErr()
        setMessages(prev => {
          const last = prev[prev.length - 1]
          if (last?.id === aId) {
            return [...prev.slice(0, -1), { ...last, content: `Error: ${e}`, streaming: false }]
          }
          return prev
        })
        resolve()
      })
      window.api.sendMessage(userText)
    })

    // Stop streaming indicator
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.id === aId) return [...prev.slice(0, -1), { ...last, streaming: false }]
      return prev
    })

    // ── Parse tool call from model output ──
    const parsed = parseToolCall(fullText)
    if (!parsed) {
      setGenerating(false)
      return
    }

    const { tool, args } = parsed
    const isDestructive = DESTRUCTIVE.includes(tool)

    const toolCallObj: ToolCall = {
      id: uid(),
      tool,
      args,
      status: isDestructive ? 'pending-permission' : 'running',
    }

    // Add tool call card to the assistant message
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.id === aId) {
        return [...prev.slice(0, -1), { ...last, toolCalls: [toolCallObj] }]
      }
      return prev
    })

    let allowed = true
    if (isDestructive) {
      allowed = await requestPermission(aId, toolCallObj)
    }

    // Update tool status
    const updateTool = (status: ToolCall['status'], result?: string, error?: string) => {
      setMessages(prev => prev.map(m => {
        if (m.id !== aId) return m
        return {
          ...m,
          toolCalls: m.toolCalls?.map(tc =>
            tc.id === toolCallObj.id ? { ...tc, status, result, error } : tc
          )
        }
      }))
    }

    if (!allowed) {
      updateTool('denied')
      setGenerating(false)
      return
    }

    updateTool('running')
    const result = await executeTool(tool, args)
    updateTool('done', result)

    // Feed observation back and continue agent loop (up to 8 steps)
    const observation = `OBSERVATION:\n${result}`
    window.api.sendMessage(observation)
    // (for full multi-step agent, recursion would continue; simplified here to one loop)

    setGenerating(false)
    inputRef.current?.focus()
  }, [appendToken, workspace])

  // ─── Submit ───────────────────────────────────────────────────────────────

  const submit = () => {
    const text = input.trim()
    if (!text || generating) return
    setInput('')
    const userMsg: ChatMessage = { id: uid(), role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    runAgentTurn(text)
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="chat">
      {/* Permission overlay (VSCode-style) */}
      {pendingTool && (
        <div className="permission-overlay">
          <div className="permission-dialog">
            <div className="permission-header">
              <span className="permission-icon">🔐</span>
              <span className="permission-title">Permission Required</span>
            </div>
            <p className="permission-body">
              The AI wants to use <strong>{TOOL_ICONS[pendingTool.tool.tool]} {pendingTool.tool.tool}</strong>
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

      {/* Message list */}
      <div className="chat-messages">
        {messages.map(msg => (
          <div key={msg.id} className={`message message--${msg.role}`}>
            <div className="message-avatar">
              {msg.role === 'user' ? '👤' : '🤖'}
            </div>
            <div className="message-body">
              <MarkdownText text={msg.content} streaming={msg.streaming} />

              {/* Tool call cards */}
              {msg.toolCalls?.map(tc => (
                <ToolCard key={tc.id} tc={tc} />
              ))}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="chat-input-wrap">
        <div className="chat-input-box">
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder={generating ? 'AI is thinking…' : 'Message the AI  (Shift+Enter for newline)'}
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
  // Basic markdown: code blocks, inline code, bold, italic
  const rendered = text
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
      `<pre class="code-block" data-lang="${lang}"><code>${escHtml(code.trim())}</code></pre>`
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

function escHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
