import { useState, useEffect, useRef, useCallback } from 'react'
import { ChatMessage, ToolCall, ToolName, TodoItem, DiffFile } from '../types'
import ConnectorBar, { CONNECTORS } from './ConnectorBar'

interface Props {
  modelName:         string
  modelType:         'local' | 'api' | 'duo'
  workspace:         string
  duoReasonerName?:  string
  chatMode:          ChatMode
  onChatModeChange:  (m: ChatMode) => void
}

type ChatMode   = 'chat' | 'agent'
type Layout     = 'combined' | 'split'

interface SessionStats {
  sessionStart:      Date
  lastActivity:      Date
  userMessages:      number
  assistantMessages: number
  totalTokens:       number
  inputTokens:       number
  outputTokens:      number
  reasoningTokens:   number
  cacheRead:         number
  totalCostUsd:      number
  contextLimit:      number
}

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'llama-3.3-70b-versatile':                     128_000,
  'meta-llama/llama-4-scout-17b-16e-instruct':   131_072,
  'qwen/qwen3-32b':                               32_768,
  'openai/gpt-oss-120b':                         128_000,
  'openai/gpt-oss-20b':                          128_000,
  'llama-3.1-8b-instant':                        131_072,
  'nvidia/llama-3.3-nemotron-super-49b-v1':      204_800,
  'nvidia/llama-3.1-nemotron-nano-8b-v1':        128_000,
  'meta-llama/llama-3.3-70b-instruct:free':      131_072,
  'deepseek/deepseek-r1:free':                   163_840,
  'google/gemma-3-27b-it:free':                  131_072,
  'nvidia/llama-3.3-nemotron-super-49b-v1:free': 204_800,
  'minimax-m2':                                  204_800,
  'qwen-turbo':                                  1_000_000,
  'qwen-plus':                                   131_072,
  'qwen-max':                                    32_768,
  'qwen2.5':                                     131_072,
  'qwen3':                                       131_072,
  'mistral-large':                               131_072,
  'mistral-small':                               32_768,
  'codestral':                                   262_144,
  'mistral-nemo':                                131_072,
  'mixtral-8x22b':                               65_536,
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'llama-3.3-70b-versatile':       { input: 0.59,  output: 0.79  },
  'llama-3.1-8b-instant':          { input: 0.05,  output: 0.08  },
  'gpt-4o':                        { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':                   { input: 0.15,  output: 0.60  },
  'claude-sonnet-4-5':             { input: 3.00,  output: 15.00 },
  'claude-opus-4-5':               { input: 15.00, output: 75.00 },
  'claude-haiku-4-5-20251001':     { input: 0.80,  output: 4.00  },
  'gemini-2.0-flash':              { input: 0.10,  output: 0.40  },
  'gemini-1.5-pro':                { input: 1.25,  output: 5.00  },
}

function getContextLimit(modelName: string): number {
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (modelName.toLowerCase().includes(key.toLowerCase())) return limit
  }
  return 4_096
}

function computeCost(modelName: string, usage: { prompt: number; completion: number }): number {
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (modelName.toLowerCase().includes(key.toLowerCase())) {
      return (usage.prompt / 1_000_000) * price.input + (usage.completion / 1_000_000) * price.output
    }
  }
  return 0
}

function friendlyError(raw: string): string {
  if (raw.includes('401') || raw.includes('Unauthorized') || raw.includes('invalid_api_key')) return 'Invalid API key — check your key in the model selector'
  if (raw.includes('429') || raw.includes('rate_limit') || raw.includes('Too Many Requests')) return 'Rate limited — wait a moment and try again'
  if (raw.includes('503') || raw.includes('502') || raw.includes('500')) return 'Server error — the API is having issues, try again shortly'
  if (raw.includes('ECONNREFUSED') || raw.includes('ENOTFOUND') || raw.includes('network')) return 'Connection failed — check your internet connection'
  if (raw.includes('timed out')) return raw
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw
}

const TOOL_ICONS: Record<ToolName, string> = {
  read_file:  '📄', write_file: '✏️', patch_file: '🔧', run_shell: '⚡', list_dir: '📁',
}
const TOOL_LABELS: Record<ToolName, string> = {
  read_file: 'Read', write_file: 'Write', patch_file: 'Edit', run_shell: 'Shell', list_dir: 'Explore',
}
const DESTRUCTIVE: ToolName[] = ['write_file', 'patch_file', 'run_shell']
const MUTATING: ToolName[]    = ['write_file', 'patch_file']
const MAX_STEPS = 12
const TURN_TIMEOUT_MS = 30_000

function makeChatSystemPrompt() {
  return 'You are a helpful assistant. Answer clearly and concisely.'
}

function makeAgentSystemPrompt(workspace: string) {
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

// ─── Reasoner model detection ─────────────────────────────────────────────────

const REASONER_PATTERNS = ['nemotron', 'deepseek-r1', 'deepseek/deepseek-r1', 'o1', 'o3']
function isReasonerModel(name: string) {
  const n = name.toLowerCase()
  return REASONER_PATTERNS.some(p => n.includes(p))
}

// ─── Component ────────────────────────────────────────────────────────────────

interface StoredSession {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
}

function sessionTitle(msgs: ChatMessage[]): string {
  const first = msgs.find(m => m.role === 'user')
  return first ? first.content.slice(0, 48) : 'New chat'
}

function fmtSessionDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const diff = (now.getTime() - d.getTime()) / 1000
  if (diff < 60)   return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toLocaleDateString()
}

export default function ChatView({ modelName, modelType, workspace, duoReasonerName, chatMode, onChatModeChange }: Props) {
  const isThinkingModel = modelName.toLowerCase().includes('qwen3') || modelName.toLowerCase().includes('deepseek-r1')
  const isReasoner      = modelType !== 'duo' && isReasonerModel(modelName)
  const [layout,       setLayout]       = useState<Layout>(() => (localStorage.getItem('chatLayout') as Layout) ?? 'combined')
  const [sidebarOpen,  setSidebarOpen]  = useState(false)
  const [sessions,     setSessions]     = useState<StoredSession[]>(() => {
    try { return JSON.parse(localStorage.getItem('lumiSessions') || '[]') } catch { return [] }
  })
  const [activeSessionId, setActiveSessionId] = useState<string>(() => uid())
  const [showContext,  setShowContext]   = useState(false)
  const [messages,     setMessages]     = useState<ChatMessage[]>([{
    id: uid(), role: 'assistant',
    content: modelType === 'duo'
      ? `Duo mode active. **${duoReasonerName}** will plan, then I'll execute with tools.\n\nTell me what to build or fix.`
      : isReasoner
        ? `Hi! I'm **${modelName}**.\n\nI'm a reasoning model — best at analysis, planning, and complex thinking. I'm in **Chat mode** (no tools).\n\nFor coding tasks with file access, use me as the **Planner in Duo Mode** paired with a fast Groq model.`
        : `Hi! I'm **${modelName}**${modelType === 'api' ? ' via cloud' : ' running locally'}.\n\nTell me what to do — I'll explore your workspace, read files, make changes, and track progress with a todo list.`,
  }])
  const [input,        setInput]        = useState('')
  const [generating,   setGenerating]   = useState(false)
  const [thinking,     setThinking]     = useState(false)
  const [thinkMode,    setThinkMode]    = useState(false)
  const [activeConns,  setActiveConns]  = useState<Set<string>>(new Set())
  const [busyConns,    setBusyConns]    = useState<Set<string>>(new Set())
  const [diffFiles,    setDiffFiles]    = useState<DiffFile[]>([])
  const [selectedFile, setSelectedFile] = useState<DiffFile | null>(null)
  const [todos,        setTodos]        = useState<TodoItem[]>([])
  const [permMode,     setPermMode]     = useState<'ask' | 'auto'>(() =>
    (localStorage.getItem('permMode') as any) ?? 'ask'
  )
  const [pendingTool,  setPendingTool]  = useState<{
    tool: ToolName; args: Record<string, any>; resolve: (allowed: boolean) => void
  } | null>(null)
  const [stats,        setStats]        = useState<SessionStats>({
    sessionStart:      new Date(),
    lastActivity:      new Date(),
    userMessages:      0,
    assistantMessages: 0,
    totalTokens:       0,
    inputTokens:       0,
    outputTokens:      0,
    reasoningTokens:   0,
    cacheRead:         0,
    totalCostUsd:      0,
    contextLimit:      getContextLimit(modelName),
  })

  // Push panel state
  const [branches,     setBranches]     = useState<string[]>([])
  const [curBranch,    setCurBranch]    = useState('main')
  const [pushMsg,      setPushMsg]      = useState('')
  const [pushLoading,  setPushLoading]  = useState(false)
  const [pushing,      setPushing]      = useState(false)

  const bottomRef     = useRef<HTMLDivElement>(null)
  const inputRef      = useRef<HTMLTextAreaElement>(null)
  const lastPromptRef = useRef<string>('')
  const tokenTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const permModeRef   = useRef(permMode)
  useEffect(() => { permModeRef.current = permMode }, [permMode])

  useEffect(() => {
    const sysPrompt = chatMode === 'chat' ? makeChatSystemPrompt() : makeAgentSystemPrompt(workspace)
    window.api.chatInit(sysPrompt)
  }, [workspace, chatMode])

  // Auto-save current session whenever messages change
  useEffect(() => {
    const userMsgs = messages.filter(m => m.role === 'user')
    if (userMsgs.length === 0) return
    const saved = messages.map(m => ({ ...m, streaming: false }))
    setSessions(prev => {
      const existing = prev.find(s => s.id === activeSessionId)
      if (existing) {
        return prev.map(s => s.id === activeSessionId
          ? { ...s, title: sessionTitle(saved), messages: saved }
          : s
        )
      }
      const next = [{ id: activeSessionId, title: sessionTitle(saved), messages: saved, createdAt: Date.now() }, ...prev]
      return next.slice(0, 30) // cap at 30 sessions
    })
  }, [messages, activeSessionId])

  // Persist sessions to localStorage
  useEffect(() => {
    localStorage.setItem('lumiSessions', JSON.stringify(sessions))
  }, [sessions])

  // Reset session stats whenever the active model changes
  useEffect(() => {
    setStats({
      sessionStart:      new Date(),
      lastActivity:      new Date(),
      userMessages:      0,
      assistantMessages: 0,
      totalTokens:       0,
      inputTokens:       0,
      outputTokens:      0,
      reasoningTokens:   0,
      cacheRead:         0,
      totalCostUsd:      0,
      contextLimit:      getContextLimit(modelName),
    })
  }, [modelName])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, thinking])

  const handleLayout = (l: Layout) => {
    setLayout(l)
    localStorage.setItem('chatLayout', l)
  }

  // ─── Git diff + branches ──────────────────────────────────────────────────

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

  const loadBranches = useCallback(async () => {
    if (workspace === '~') return
    const r = await window.api.runShell('git branch --format="%(refname:short)"', workspace)
    if (r.ok && r.stdout) {
      const bs = r.stdout.split('\n').map((s: string) => s.trim()).filter(Boolean)
      setBranches(bs)
    }
    const rb = await window.api.runShell('git rev-parse --abbrev-ref HEAD', workspace)
    if (rb.ok && rb.stdout) setCurBranch(rb.stdout.trim())
  }, [workspace])

  useEffect(() => { loadBranches() }, [loadBranches])

  // ─── Push panel handlers ──────────────────────────────────────────────────

  const generateCommitMsg = async () => {
    setPushLoading(true)
    try {
      const diffR = await window.api.runShell('git diff HEAD', workspace)
      const diff = diffR.ok ? diffR.stdout.slice(0, 3000) : ''
      const r = await window.api.chatQuick(
        `Write a concise git commit message (one line, under 72 chars, no quotes) for these changes:\n\n${diff || 'Various improvements'}`
      )
      if (r.ok) setPushMsg(r.text.trim().replace(/^["'`]|["'`]$/g, ''))
    } finally {
      setPushLoading(false)
    }
  }

  const confirmPush = async () => {
    if (!pushMsg.trim()) return
    setPushing(true)
    try {
      await window.api.runShell('git add -A', workspace)
      await window.api.runShell(`git commit -m ${JSON.stringify(pushMsg.trim())}`, workspace)
      await window.api.runShell(`git push origin ${curBranch}`, workspace)
      setPushMsg('')
      await refreshDiff()
    } finally {
      setPushing(false)
    }
  }

  // ─── Token streaming ──────────────────────────────────────────────────────

  const appendToken = useCallback((token: string, msgId: string) => {
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === msgId)
      if (idx === -1) return prev
      const msg = prev[idx]
      if (!msg.streaming) return prev
      const next = [...prev]
      next[idx] = { ...msg, content: msg.content + token }
      return next
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
        if (r.ok && MUTATING.some(() => args.command?.includes('git'))) setTimeout(refreshDiff, 500)
        return r.ok ? [r.stdout, r.stderr].filter(Boolean).join('\n') || '(no output)' : `Error: ${r.error}`
      }
      default: return `Unknown tool: ${tool}`
    }
  }

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

  const streamTurn = useCallback((execMsgId: string, prompt: string, plannerMsgId?: string): Promise<{ text: string; usage: any }> =>
    new Promise(resolve => {
      let full = '', thinkFull = '', firstToken = true

      const cleanup = () => { offT(); offD(); offTT(); offTD(); offE(); clearTimeout(tokenTimerRef.current) }

      const resetTimer = () => {
        clearTimeout(tokenTimerRef.current)
        tokenTimerRef.current = setTimeout(() => {
          cleanup()
          setMessages(prev => prev.map(m =>
            m.id === execMsgId ? { ...m, content: '', streaming: false, error: 'Request timed out after 30 seconds — try again' } : m
          ))
          if (plannerMsgId) {
            setMessages(prev => prev.map(m => m.id === plannerMsgId ? { ...m, streaming: false } : m))
          }
          setThinking(false)
          resolve({ text: '', usage: null })
        }, TURN_TIMEOUT_MS)
      }

      resetTimer()

      const offTT = window.api.onChatThinkToken((t: string) => {
        resetTimer()
        thinkFull += t
        if (plannerMsgId) {
          setMessages(prev => prev.map(m => m.id === plannerMsgId ? { ...m, content: thinkFull } : m))
        }
      })
      const offTD = window.api.onChatThinkDone(() => {
        if (plannerMsgId) {
          setMessages(prev => prev.map(m => m.id === plannerMsgId ? { ...m, streaming: false } : m))
        }
        setThinking(true)
      })

      const offT = window.api.onChatToken((t: string) => {
        resetTimer()
        if (firstToken) { firstToken = false; setThinking(false) }
        full += t
        appendToken(t, execMsgId)
      })
      const offD = window.api.onChatDone(({ usage }: { usage?: any }) => {
        cleanup()
        if (usage) {
          setStats(s => ({
            ...s,
            lastActivity:      new Date(),
            assistantMessages: s.assistantMessages + 1,
            totalTokens:       s.totalTokens + (usage.prompt ?? 0) + (usage.completion ?? 0),
            inputTokens:       s.inputTokens + (usage.prompt ?? 0),
            outputTokens:      s.outputTokens + (usage.completion ?? 0),
            reasoningTokens:   s.reasoningTokens + (usage.reasoning ?? 0),
            cacheRead:         s.cacheRead + (usage.cacheRead ?? 0),
            totalCostUsd:      s.totalCostUsd + computeCost(modelName, usage),
          }))
        }
        resolve({ text: full, usage: usage ?? null })
      })
      const offE = window.api.onChatError((e: string) => {
        cleanup()
        const friendly = friendlyError(e)
        setMessages(prev => prev.map(m =>
          m.id === execMsgId ? { ...m, content: '', streaming: false, error: friendly } : m
        ))
        if (plannerMsgId) {
          setMessages(prev => prev.map(m => m.id === plannerMsgId ? { ...m, streaming: false } : m))
        }
        setThinking(false)
        resolve({ text: '', usage: null })
      })

      window.api.sendMessage(prompt)
    })
  , [appendToken, modelName])

  // ─── Chat turn (no tools) ─────────────────────────────────────────────────

  const runChatTurn = useCallback(async (userText: string) => {
    const connCtx = await fetchCtx(userText)
    const prompt = connCtx ? `[Context]\n${connCtx}\n\n---\n${userText}` : userText
    lastPromptRef.current = prompt
    setGenerating(true); setThinking(true)

    let plannerMsgId: string | undefined
    if (modelType === 'duo') {
      plannerMsgId = uid()
      setMessages(prev => [...prev, { id: plannerMsgId!, role: 'planner', content: '', streaming: true }])
    }
    const aId = uid()
    const role = modelType === 'duo' ? 'executor' : 'assistant'
    setMessages(prev => [...prev, { id: aId, role, content: '', streaming: true }])

    await streamTurn(aId, prompt, plannerMsgId)
    setMessages(prev => prev.map(m => m.id === aId ? { ...m, streaming: false } : m))

    setThinking(false); setGenerating(false)
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [fetchCtx, streamTurn, modelType])

  // ─── Agent loop ───────────────────────────────────────────────────────────

  const runAgentTurn = useCallback(async (userText: string) => {
    const connCtx = await fetchCtx(userText)
    const firstPrompt = connCtx ? `[Context]\n${connCtx}\n\n---\n${userText}` : userText
    lastPromptRef.current = firstPrompt
    setGenerating(true)

    // Pre-plan: quick non-streaming call to show what the agent will do
    if (modelType !== 'local') {
      const planMsgId = uid()
      setMessages(prev => [...prev, { id: planMsgId, role: 'planner', content: '', streaming: true }])
      const planR = await window.api.chatQuick(
        `You are about to complete a task using file and shell tools. List 3–5 concrete steps you will take. Output ONLY the numbered list — no intro, no summary.\n\nTask: ${userText}`
      )
      const planText = planR?.ok ? planR.text?.trim() : ''
      if (planText) {
        setMessages(prev => prev.map(m => m.id === planMsgId ? { ...m, content: planText, streaming: false } : m))
      } else {
        setMessages(prev => prev.filter(m => m.id !== planMsgId))
      }
    }

    setThinking(true)

    let nextPrompt = firstPrompt
    let currentTodos: TodoItem[] = []

    for (let step = 0; step < MAX_STEPS; step++) {
      let plannerMsgId: string | undefined
      if (modelType === 'duo' && step === 0) {
        plannerMsgId = uid()
        setMessages(prev => [...prev, { id: plannerMsgId!, role: 'planner', content: '', streaming: true }])
      }

      const aId = uid()
      const role = modelType === 'duo' ? 'executor' : 'assistant'
      setMessages(prev => [...prev, { id: aId, role, content: '', streaming: true }])

      const { text: fullText } = await streamTurn(aId, nextPrompt, plannerMsgId)
      setMessages(prev => prev.map(m => m.id === aId ? { ...m, streaming: false } : m))

      if (!fullText) break // timeout or error

      const todosFromText = parseTodos(fullText)
      if (todosFromText) {
        currentTodos = todosFromText
        setTodos(todosFromText)
        setMessages(prev => prev.map(m => m.id === aId ? { ...m, todos: todosFromText } : m))
      }

      const doneTodo = parseDoneTodo(fullText)
      if (doneTodo && currentTodos.length) {
        currentTodos = currentTodos.map(t =>
          t.text.toLowerCase() === doneTodo.toLowerCase() ? { ...t, done: true } : t
        )
        setTodos([...currentTodos])
      }

      const parsed = parseToolCall(fullText)
      if (!parsed) break

      const { tool, args } = parsed
      const tc: ToolCall = { id: uid(), tool, args, status: 'running' }

      setMessages(prev => prev.map(m => m.id === aId ? { ...m, toolCalls: [...(m.toolCalls || []), tc] } : m))

      const updateTool = (status: ToolCall['status'], result?: string) =>
        setMessages(prev => prev.map(m =>
          m.id !== aId ? m : { ...m, toolCalls: m.toolCalls?.map(t => t.id === tc.id ? { ...t, status, result } : t) }
        ))

      // Permission gate for destructive tools
      if (DESTRUCTIVE.includes(tool) && permModeRef.current === 'ask') {
        const allowed = await new Promise<boolean>(resolve => setPendingTool({ tool, args, resolve }))
        setPendingTool(null)
        if (!allowed) {
          updateTool('done', 'Skipped — denied by user')
          nextPrompt = `OBSERVATION:\nUser denied permission to run ${tool}. Ask the user what to do next.`
          setThinking(true)
          continue
        }
      }

      const result = await executeTool(tool, args)
      updateTool('done', result)

      nextPrompt = `OBSERVATION:\n${result}`
      setThinking(true)
    }

    setThinking(false); setGenerating(false)
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [fetchCtx, streamTurn, modelType, workspace, refreshDiff])

  // ─── Retry ────────────────────────────────────────────────────────────────

  const retryLast = useCallback(() => {
    if (!lastPromptRef.current || generating) return
    // Remove last error message
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.error) return prev.slice(0, -1)
      return prev
    })
    const prompt = lastPromptRef.current
    if (chatMode === 'chat') runChatTurn(prompt)
    else runAgentTurn(prompt)
  }, [generating, chatMode, runChatTurn, runAgentTurn])

  // ─── Session helpers ──────────────────────────────────────────────────────

  const makeWelcome = useCallback(() =>
    modelType === 'duo'
      ? `Duo mode active. **${duoReasonerName}** will plan, then I'll execute with tools.\n\nTell me what to build or fix.`
      : isReasoner
        ? `Hi! I'm **${modelName}**.\n\nI'm a reasoning model — best at analysis, planning, and complex thinking. I'm in **Chat mode** (no tools).\n\nFor coding tasks with file access, use me as the **Planner in Duo Mode** paired with a fast Groq model.`
        : `Hi! I'm **${modelName}**${modelType === 'api' ? ' via cloud' : ' running locally'}.\n\nTell me what to do — I'll explore your workspace, read files, make changes, and track progress with a todo list.`
  , [modelName, modelType, isReasoner, duoReasonerName])

  const resetStats = useCallback(() => setStats({
    sessionStart: new Date(), lastActivity: new Date(),
    userMessages: 0, assistantMessages: 0,
    totalTokens: 0, inputTokens: 0, outputTokens: 0,
    reasoningTokens: 0, cacheRead: 0, totalCostUsd: 0,
    contextLimit: getContextLimit(modelName),
  }), [modelName])

  const newChat = useCallback(() => {
    window.api.chatResetHistory()
    setActiveSessionId(uid())
    setMessages([{ id: uid(), role: 'assistant', content: makeWelcome() }])
    setTodos([])
    resetStats()
    lastPromptRef.current = ''
  }, [makeWelcome, resetStats])

  const switchSession = useCallback((session: StoredSession) => {
    window.api.chatResetHistory()
    setActiveSessionId(session.id)
    setMessages(session.messages)
    setTodos([])
    resetStats()
    lastPromptRef.current = ''
  }, [resetStats])

  const deleteSession = useCallback((id: string) => {
    setSessions(prev => prev.filter(s => s.id !== id))
    if (id === activeSessionId) newChat()
  }, [activeSessionId, newChat])

  // ─── Submit ───────────────────────────────────────────────────────────────

  const submit = () => {
    const text = input.trim(); if (!text || generating) return
    setInput('')
    setTimeout(() => inputRef.current?.focus(), 0)
    setMessages(prev => [...prev, { id: uid(), role: 'user', content: text }])
    setStats(s => ({ ...s, userMessages: s.userMessages + 1, lastActivity: new Date() }))
    const prompt = thinkMode && isThinkingModel ? `/think\n${text}` : text
    if (chatMode === 'chat') runChatTurn(prompt)
    else runAgentTurn(prompt)
  }
  const handleKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }

  // ─── Render ───────────────────────────────────────────────────────────────

  const hasDiff     = diffFiles.length > 0
  const isDuo       = modelType === 'duo'
  const showSplit   = isDuo && layout === 'split'

  const plannerMsgs  = messages.filter(m => m.role === 'planner')
  const mainMsgs     = messages.filter(m => m.role !== 'planner')

  const topBar = (
    <div className="chat-topbar">
      <button
        className={`sidebar-toggle ${sidebarOpen ? 'sidebar-toggle--open' : ''}`}
        onClick={() => setSidebarOpen(v => !v)}
        title={sidebarOpen ? 'Close chat history' : 'Open chat history'}
      >≡</button>
      <div className="mode-pills">
        <button className={`mode-pill ${chatMode === 'chat' ? 'mode-pill--active' : ''}`} onClick={() => onChatModeChange('chat')}>💬 Chat</button>
        <button
          className={`mode-pill ${chatMode === 'agent' ? 'mode-pill--active' : ''} ${isReasoner ? 'mode-pill--disabled' : ''}`}
          onClick={() => !isReasoner && onChatModeChange('agent')}
          title={isReasoner ? 'Reasoning models don\'t follow tool-call format — use as Planner in Duo Mode instead' : undefined}
          disabled={isReasoner}
        >🤖 Agent</button>
        {isReasoner && <span className="reasoner-hint">Use as 🧠 Planner in Duo Mode for coding tasks</span>}
        {chatMode === 'agent' && !isReasoner && (
          <button
            className={`perm-mode-btn ${permMode === 'auto' ? 'perm-mode-btn--auto' : ''}`}
            onClick={() => {
              const next = permMode === 'ask' ? 'auto' : 'ask'
              setPermMode(next)
              localStorage.setItem('permMode', next)
            }}
            title={permMode === 'ask' ? 'Ask before writing/editing files — click to auto-approve all' : 'Auto-approving all tool calls — click to require permission'}
          >
            {permMode === 'ask' ? '🔐 Ask' : '⚡ Do all'}
          </button>
        )}
      </div>
      <div className="chat-topbar-right">
        <button className="new-chat-btn" onClick={newChat} title="Clear conversation and start fresh">＋ New chat</button>
        <button className={`ctx-btn ${showContext ? 'ctx-btn--active' : ''}`} onClick={() => setShowContext(v => !v)}>Context</button>
        {isDuo && (
          <button className="layout-btn" onClick={() => handleLayout(layout === 'combined' ? 'split' : 'combined')}
            title={layout === 'combined' ? 'Split into planner / executor columns' : 'Merge into a single group thread'}>
            {layout === 'split' ? '⊞ Group thread' : '⊟ Side by side'}
          </button>
        )}
      </div>
    </div>
  )

  const inputBar = (
    <>
      <ConnectorBar active={activeConns} onChange={setActiveConns} busy={busyConns} />
      <div className="chat-input-wrap">
        <div className="chat-input-box">
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder={
              generating ? 'Working…'
              : chatMode === 'agent' ? 'What do you want me to build or fix?'
              : 'Ask anything…'
            }
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
        <div className="chat-hint-row">
          <p className="chat-hint">
            {modelName} · {workspace !== '~' ? workspace.split('/').pop() : 'no workspace'} · {modelType === 'duo' ? 'duo mode' : modelType === 'api' ? 'cloud' : 'offline'}
            {stats.totalTokens > 0 && <span className="token-hint"> · ~{fmtTokens(stats.totalTokens)} tokens</span>}
          </p>
          {isThinkingModel && modelType !== 'duo' && (
            <button
              className={`think-toggle ${thinkMode ? 'think-toggle--on' : ''}`}
              onClick={() => setThinkMode(v => !v)}
              title="Toggle thinking mode"
            >
              🧠 {thinkMode ? 'Thinking on' : 'Thinking off'}
            </button>
          )}
        </div>
      </div>
    </>
  )

  const renderMessages = (msgs: ChatMessage[], filterRole?: string) => {
    const list = filterRole ? msgs.filter(m => m.role === filterRole || m.role === 'user') : msgs
    return list.map(msg => {
      const isUser    = msg.role === 'user'
      const isPlanner = msg.role === 'planner'
      const isExecutor = msg.role === 'executor'
      return (
        <div key={msg.id} className={`message message--${isUser ? 'user' : isPlanner ? 'planner' : isExecutor ? 'executor' : 'assistant'}`}>
          {!isUser && (
            <div className={`message-avatar ${isPlanner ? 'avatar--planner' : isExecutor ? 'avatar--executor' : ''}`}>
              {isPlanner ? '🧠' : isExecutor ? '🤖' : '🤖'}
            </div>
          )}
          <div className="message-body">
            {(isPlanner || isExecutor) && (
              <div className={`author-chip ${isPlanner ? 'author-chip--planner' : 'author-chip--executor'}`}>
                {isPlanner ? (duoReasonerName ?? 'Planner') : modelName}
              </div>
            )}
            {msg.todos && msg.todos.length > 0 && <TodoBlock todos={msg.todos} live={todos} />}
            {msg.toolCalls?.map(tc => <ToolStep key={tc.id} tc={tc} />)}
            {msg.content && <MarkdownText text={msg.content} streaming={msg.streaming} />}
            {msg.error && (
              <div className="msg-error">
                <span className="msg-error-icon">⚠</span>
                <span>{msg.error}</span>
                <button className="retry-btn" onClick={retryLast}>Retry ↺</button>
              </div>
            )}
          </div>
          {isUser && <div className="message-avatar">👤</div>}
        </div>
      )
    })
  }

  const thinkingIndicator = thinking && (
    <div className="message message--assistant">
      <div className="message-avatar">🤖</div>
      <div className="message-body">
        <div className="thinking-row">
          <span className="thinking-label">{modelType === 'duo' ? 'Executing' : 'Thinking'}</span>
          <span className="thinking-dots"><span /><span /><span /></span>
        </div>
      </div>
    </div>
  )

  return (
    <div className="chat-root">
      {/* Session sidebar */}
      <div className={`session-sidebar ${sidebarOpen ? 'session-sidebar--open' : ''}`}>
        <div className="session-sidebar-header">
          <span className="session-sidebar-title">Chats</span>
          <button className="session-new-btn" onClick={newChat} title="New chat">＋</button>
        </div>
        <div className="session-list">
          {sessions.length === 0 && (
            <p className="session-empty">No saved chats yet</p>
          )}
          {sessions.map(s => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeSessionId ? 'session-item--active' : ''}`}
              onClick={() => switchSession(s)}
            >
              <div className="session-item-body">
                <span className="session-item-title">{s.title}</span>
                <span className="session-item-date">{fmtSessionDate(s.createdAt)}</span>
              </div>
              <button
                className="session-del-btn"
                onClick={e => { e.stopPropagation(); deleteSession(s.id) }}
                title="Delete"
              >×</button>
            </div>
          ))}
        </div>
      </div>

      <div className="chat-root-main">
      {showContext && (
        <ContextPanel stats={stats} messages={messages} modelName={modelName} onClose={() => setShowContext(false)} />
      )}

      {/* Permission dialog */}
      {pendingTool && (
        <div className="perm-overlay">
          <div className="perm-dialog">
            <div className="perm-header">
              <span className="perm-icon">{TOOL_ICONS[pendingTool.tool]}</span>
              <span className="perm-title">Allow {TOOL_LABELS[pendingTool.tool]}?</span>
            </div>
            <p className="perm-detail">{toolDesc(pendingTool.tool, pendingTool.args)}</p>
            <div className="perm-actions">
              <button className="perm-deny-btn" onClick={() => { pendingTool.resolve(false); setPendingTool(null) }}>
                Deny
              </button>
              <button className="perm-allow-btn" onClick={() => { pendingTool.resolve(true); setPendingTool(null) }}>
                Allow once
              </button>
              <button className="perm-all-btn" onClick={() => {
                const next = 'auto'
                setPermMode(next)
                localStorage.setItem('permMode', next)
                pendingTool.resolve(true)
                setPendingTool(null)
              }}>
                ⚡ Allow all
              </button>
            </div>
          </div>
        </div>
      )}

      {showSplit ? (
        // ── Split layout ───────────────────────────────────────────────────
        <div className="chat-split">
          {/* Left: planner column */}
          <div className="chat-split-col chat-split-col--planner">
            <div className="split-col-header">
              <span className="author-chip author-chip--planner">{duoReasonerName ?? 'Planner'}</span>
            </div>
            <div className="chat-messages">
              {renderMessages(plannerMsgs)}
              <div ref={bottomRef} />
            </div>
          </div>

          {/* Right: executor + diff + push */}
          <div className="chat-split-col chat-split-col--executor">
            <div className="split-col-header">
              <span className="author-chip author-chip--executor">{modelName}</span>
            </div>
            <div className="chat-messages">
              {renderMessages(mainMsgs)}
              {thinkingIndicator}
              <div />
            </div>
            <DiffAndPush
              hasDiff={hasDiff} diffFiles={diffFiles} selectedFile={selectedFile}
              setSelectedFile={setSelectedFile} refreshDiff={refreshDiff}
              branches={branches} curBranch={curBranch} setCurBranch={setCurBranch}
              pushMsg={pushMsg} setPushMsg={setPushMsg}
              pushLoading={pushLoading} pushing={pushing}
              generateCommitMsg={generateCommitMsg} confirmPush={confirmPush}
              workspace={workspace}
            />
            {topBar}
            {inputBar}
          </div>
        </div>
      ) : (
        // ── Combined layout ────────────────────────────────────────────────
        <>
          <div className="chat">
            {topBar}
            <div className="chat-messages">
              {renderMessages(messages)}
              {thinkingIndicator}
              <div ref={bottomRef} />
            </div>
            {inputBar}
          </div>

          {/* Right: diff + push panel */}
          <div className={`diff-panel ${hasDiff ? 'diff-panel--open' : ''}`}>
            <DiffAndPush
              hasDiff={hasDiff} diffFiles={diffFiles} selectedFile={selectedFile}
              setSelectedFile={setSelectedFile} refreshDiff={refreshDiff}
              branches={branches} curBranch={curBranch} setCurBranch={setCurBranch}
              pushMsg={pushMsg} setPushMsg={setPushMsg}
              pushLoading={pushLoading} pushing={pushing}
              generateCommitMsg={generateCommitMsg} confirmPush={confirmPush}
              workspace={workspace}
            />
          </div>
        </>
      )}
      </div>{/* end chat-root-main */}
    </div>
  )
}

// ─── Diff + Push panel ────────────────────────────────────────────────────────

interface DiffPushProps {
  hasDiff: boolean; diffFiles: DiffFile[]; selectedFile: DiffFile | null
  setSelectedFile: (f: DiffFile | null) => void; refreshDiff: () => void
  branches: string[]; curBranch: string; setCurBranch: (b: string) => void
  pushMsg: string; setPushMsg: (m: string) => void
  pushLoading: boolean; pushing: boolean
  generateCommitMsg: () => void; confirmPush: () => void
  workspace: string
}

function DiffAndPush({ hasDiff, diffFiles, selectedFile, setSelectedFile, refreshDiff, branches, curBranch, setCurBranch, pushMsg, setPushMsg, pushLoading, pushing, generateCommitMsg, confirmPush, workspace }: DiffPushProps) {
  return (
    <>
      <div className="diff-panel-header">
        <span className="diff-panel-title">Git changes</span>
        {hasDiff && <button className="btn-tiny" onClick={refreshDiff} title="Refresh diff">↻</button>}
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

      {/* Push section */}
      {workspace !== '~' && (
        <div className="push-panel">
          <div className="push-panel-header">
            <span className="push-panel-title">↑ Push changes</span>
            {branches.length > 0 && (
              <select className="branch-select" value={curBranch} onChange={e => setCurBranch(e.target.value)}>
                {branches.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
          </div>
          <div className="push-msg-row">
            <textarea
              className="push-msg-input"
              placeholder="Commit message…"
              value={pushMsg}
              onChange={e => setPushMsg(e.target.value)}
              rows={2}
            />
            <button className="push-gen-btn" onClick={generateCommitMsg} disabled={pushLoading} title="Generate commit message with AI">
              {pushLoading ? <span className="spin">◌</span> : '✨'}
            </button>
          </div>
          <button
            className="push-confirm-btn"
            disabled={!pushMsg.trim() || pushing}
            onClick={confirmPush}
          >
            {pushing ? <><span className="spin">◌</span> Pushing…</> : `↑ Push to ${curBranch}`}
          </button>
        </div>
      )}
    </>
  )
}

// ─── Context Panel ────────────────────────────────────────────────────────────

function ContextPanel({ stats, messages, modelName, onClose }: {
  stats: SessionStats; messages: ChatMessage[]; modelName: string; onClose: () => void
}) {
  const usagePct = stats.contextLimit > 0
    ? Math.min(100, Math.round((stats.inputTokens / stats.contextLimit) * 100)) : 0

  const userTokens      = messages.filter(m => m.role === 'user').reduce((a, m) => a + Math.ceil(m.content.length / 4), 0)
  const assistantTokens = messages.filter(m => m.role !== 'user' && m.role !== 'system').reduce((a, m) => a + Math.ceil(m.content.length / 4), 0)
  const toolTokens      = messages.reduce((a, m) => a + (m.toolCalls?.reduce((b, tc) => b + Math.ceil((tc.result?.length ?? 0) / 4), 0) ?? 0), 0)
  const totalEst        = Math.max(1, userTokens + assistantTokens + toolTokens)

  const [rawOpen, setRawOpen] = useState<Record<string, boolean>>({})

  return (
    <div className="context-panel">
      <div className="context-header">
        <span className="context-title">Context</span>
        <button className="context-close" onClick={onClose}>✕</button>
      </div>
      <div className="context-body">
        <div className="ctx-grid">
          <StatCell label="Session start"     value={fmtTime(stats.sessionStart)} />
          <StatCell label="Messages"          value={stats.userMessages + stats.assistantMessages} />
          <StatCell label="Model"             value={modelName} mono />
          <StatCell label="Context limit"     value={fmtNum(stats.contextLimit)} />
          <StatCell label="Total tokens"      value={fmtNum(stats.totalTokens)} />
          <StatCell label="Usage"             value={`${usagePct}%`} highlight={usagePct > 80} />
          <StatCell label="Input tokens"      value={fmtNum(stats.inputTokens)} />
          <StatCell label="Output tokens"     value={fmtNum(stats.outputTokens)} />
          <StatCell label="Reasoning tokens"  value={fmtNum(stats.reasoningTokens)} />
          <StatCell label="Cache read"        value={fmtNum(stats.cacheRead)} />
          <StatCell label="User messages"     value={stats.userMessages} />
          <StatCell label="AI messages"       value={stats.assistantMessages} />
          <StatCell label="Total cost"        value={`$${stats.totalCostUsd.toFixed(4)}`} />
          <StatCell label="Last activity"     value={fmtTime(stats.lastActivity)} />
        </div>

        <div className="ctx-breakdown">
          <p className="ctx-section-label">Context breakdown</p>
          <div className="ctx-bar-track">
            <div className="ctx-bar-fill ctx-bar-fill--user"    style={{ width: `${Math.round(userTokens / totalEst * 100)}%` }} />
            <div className="ctx-bar-fill ctx-bar-fill--asst"    style={{ width: `${Math.round(assistantTokens / totalEst * 100)}%` }} />
            <div className="ctx-bar-fill ctx-bar-fill--tool"    style={{ width: `${Math.round(toolTokens / totalEst * 100)}%` }} />
          </div>
          <div className="ctx-bar-labels">
            <span><span className="ctx-dot ctx-dot--user" />User {Math.round(userTokens / totalEst * 100)}%</span>
            <span><span className="ctx-dot ctx-dot--asst" />Assistant {Math.round(assistantTokens / totalEst * 100)}%</span>
            <span><span className="ctx-dot ctx-dot--tool" />Tools {Math.round(toolTokens / totalEst * 100)}%</span>
          </div>
        </div>

        <div className="ctx-raw">
          <p className="ctx-section-label">Raw messages</p>
          {messages.map(m => (
            <div key={m.id} className="raw-msg-row">
              <button className="raw-msg-toggle" onClick={() => setRawOpen(p => ({ ...p, [m.id]: !p[m.id] }))}>
                <span className={`raw-msg-role raw-msg-role--${m.role}`}>{m.role}</span>
                <span className="raw-msg-preview">{m.content.slice(0, 60).replace(/\n/g, ' ')}</span>
                <span className="raw-msg-len">~{Math.ceil(m.content.length / 4)} t</span>
                <span className="raw-msg-chevron">{rawOpen[m.id] ? '▲' : '▼'}</span>
              </button>
              {rawOpen[m.id] && <pre className="raw-msg-body">{m.content.slice(0, 2000)}</pre>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function StatCell({ label, value, mono, highlight }: { label: string; value: string | number; mono?: boolean; highlight?: boolean }) {
  return (
    <div className="ctx-cell">
      <span className="ctx-cell-label">{label}</span>
      <span className={`ctx-cell-value ${mono ? 'ctx-cell-mono' : ''} ${highlight ? 'ctx-cell-highlight' : ''}`}>{value}</span>
    </div>
  )
}

// ─── Think block ──────────────────────────────────────────────────────────────

// (kept for backward compat if needed)
function ThinkBlock({ content, reasonerName }: { content: string; reasonerName?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="think-block">
      <button className="think-block-header" onClick={() => setOpen(o => !o)}>
        <span className="think-block-icon">🧠</span>
        <span className="think-block-label">{reasonerName ?? 'Reasoner'} thought</span>
        <span className="think-block-chevron">{open ? '▲' : '▼'}</span>
      </button>
      {open && <pre className="think-block-body">{content}</pre>}
    </div>
  )
}
void ThinkBlock

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

// ─── Tool step ────────────────────────────────────────────────────────────────

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
function fmtNum(n: number) { return n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n/1_000).toFixed(1)}K` : String(n) }
function fmtTokens(n: number) { return n >= 1_000 ? `${(n/1_000).toFixed(1)}K` : String(n) }
function fmtTime(d: Date) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
