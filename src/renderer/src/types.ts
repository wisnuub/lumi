export interface ModelDef {
  id: string
  name: string
  description: string
  params: string
  sizeGb: number
  categories: string[]
  repo: string
  filename: string
  url: string
  tags: string[]
}

export interface LocalModel {
  filename: string
  path: string
  size: number
}

export type DownloadState = {
  status: 'idle' | 'downloading' | 'done' | 'error'
  progress: number
  error?: string
}

export type ToolName = 'read_file' | 'write_file' | 'run_shell' | 'list_dir' | 'patch_file'

export interface ToolCall {
  id: string
  tool: ToolName
  args: Record<string, string>
  status: 'pending-permission' | 'running' | 'done' | 'denied'
  result?: string
  error?: string
}

export type MessageRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  toolCalls?: ToolCall[]
  streaming?: boolean
}
