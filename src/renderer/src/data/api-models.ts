export interface ApiModelDef {
  id:          string
  name:        string
  provider:    string
  modelId:     string
  baseUrl:     string
  keyUrl:      string
  free:        boolean
  description: string
  badge:       string
}

export interface ProviderDef {
  id:          string
  name:        string
  icon:        string
  description: string
  keyLabel:    string
  keyUrl:      string
  placeholder: string
  baseUrl:     string
  models:      { id: string; name: string; description: string }[]
}

// Truly free models — just need a free API key (no credit card)
export const FREE_MODELS: ApiModelDef[] = [
  {
    id: 'groq-llama-70b', name: 'Llama 3.3 70B', provider: 'groq',
    modelId: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com', free: true, badge: 'Free',
    description: 'Best free model for coding. Fast, smart, follows instructions perfectly.',
  },
  {
    id: 'groq-deepseek', name: 'DeepSeek R1', provider: 'groq',
    modelId: 'deepseek-r1-distill-llama-70b', baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com', free: true, badge: 'Free',
    description: 'Reasoning model — thinks step by step. Great for complex code edits.',
  },
  {
    id: 'groq-llama-8b', name: 'Llama 3.1 8B', provider: 'groq',
    modelId: 'llama-3.1-8b-instant', baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com', free: true, badge: 'Free',
    description: 'Near-instant responses. Best for quick edits and short tasks.',
  },
  {
    id: 'openrouter-llama', name: 'Llama 3.3 70B', provider: 'openrouter',
    modelId: 'meta-llama/llama-3.3-70b-instruct:free', baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai', free: true, badge: 'Free',
    description: 'Llama 70B via OpenRouter free tier. No credit card needed.',
  },
  {
    id: 'openrouter-deepseek', name: 'DeepSeek R1', provider: 'openrouter',
    modelId: 'deepseek/deepseek-r1:free', baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai', free: true, badge: 'Free',
    description: 'DeepSeek R1 full model via OpenRouter. Strong reasoning & coding.',
  },
  {
    id: 'openrouter-gemma', name: 'Gemma 3 27B', provider: 'openrouter',
    modelId: 'google/gemma-3-27b-it:free', baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai', free: true, badge: 'Free',
    description: "Google's Gemma 3 27B via OpenRouter free tier.",
  },
]

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'groq', name: 'Groq', icon: '⚡', description: 'Ultra-fast inference — free tier available',
    keyLabel: 'Groq API Key', keyUrl: 'https://console.groq.com', placeholder: 'gsk_...',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: [
      { id: 'llama-3.3-70b-versatile',             name: 'Llama 3.3 70B',      description: 'Best overall free model' },
      { id: 'deepseek-r1-distill-llama-70b',        name: 'DeepSeek R1 70B',    description: 'Reasoning + coding' },
      { id: 'llama-3.1-8b-instant',                 name: 'Llama 3.1 8B',       description: 'Fastest responses' },
      { id: 'gemma2-9b-it',                         name: 'Gemma 2 9B',         description: 'Google Gemma 2' },
    ],
  },
  {
    id: 'openrouter', name: 'OpenRouter', icon: '🔀', description: 'Access hundreds of models, many free',
    keyLabel: 'OpenRouter API Key', keyUrl: 'https://openrouter.ai', placeholder: 'sk-or-...',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B',   description: 'Free tier' },
      { id: 'deepseek/deepseek-r1:free',               name: 'DeepSeek R1',     description: 'Free tier' },
      { id: 'google/gemma-3-27b-it:free',              name: 'Gemma 3 27B',     description: 'Free tier' },
      { id: 'anthropic/claude-3.5-sonnet',             name: 'Claude 3.5 Sonnet', description: 'Paid' },
    ],
  },
  {
    id: 'anthropic', name: 'Anthropic', icon: 'A',  description: 'Direct access to Claude models',
    keyLabel: 'Anthropic API Key', keyUrl: 'https://console.anthropic.com', placeholder: 'sk-ant-...',
    baseUrl: 'https://api.anthropic.com/v1',
    models: [
      { id: 'claude-sonnet-4-5',   name: 'Claude Sonnet 4.5', description: 'Best balance' },
      { id: 'claude-opus-4-5',     name: 'Claude Opus 4.5',   description: 'Most capable' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', description: 'Fastest' },
    ],
  },
  {
    id: 'openai', name: 'OpenAI', icon: '◯', description: 'GPT-4o, o1, and more',
    keyLabel: 'OpenAI API Key', keyUrl: 'https://platform.openai.com', placeholder: 'sk-...',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o',       name: 'GPT-4o',       description: 'Best overall' },
      { id: 'gpt-4o-mini',  name: 'GPT-4o Mini',  description: 'Fast + cheap' },
      { id: 'o1-mini',      name: 'o1-mini',       description: 'Reasoning' },
    ],
  },
  {
    id: 'google', name: 'Google', icon: 'G', description: 'Gemini Pro and Flash',
    keyLabel: 'Google AI API Key', keyUrl: 'https://aistudio.google.com', placeholder: 'AIza...',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [
      { id: 'gemini-2.0-flash',  name: 'Gemini 2.0 Flash', description: 'Fast + capable' },
      { id: 'gemini-1.5-pro',    name: 'Gemini 1.5 Pro',   description: 'Long context' },
    ],
  },
]
