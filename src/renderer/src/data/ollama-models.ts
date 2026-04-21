export interface SuggestedModel {
  name:        string   // ollama pull name
  label:       string
  description: string
  sizeGb:      number
  tags:        string[]
  recommended?: boolean
}

export const SUGGESTED_MODELS: SuggestedModel[] = [
  {
    name: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B', sizeGb: 4.7,
    tags: ['coding'],  recommended: true,
    description: 'Best coding model for most machines. Understands tools and follows instructions well.',
  },
  {
    name: 'qwen2.5-coder:14b', label: 'Qwen 2.5 Coder 14B', sizeGb: 9.0,
    tags: ['coding'],
    description: 'Stronger coding. Good on 16GB+ RAM machines.',
  },
  {
    name: 'llama3.2:3b', label: 'Llama 3.2 3B', sizeGb: 2.0,
    tags: ['fast', 'general'],
    description: 'Tiny and fast. Good for quick questions on any machine.',
  },
  {
    name: 'llama3.1:8b', label: 'Llama 3.1 8B', sizeGb: 4.7,
    tags: ['general'],
    description: 'Well-rounded general model. Good at coding and conversation.',
  },
  {
    name: 'deepseek-r1:7b', label: 'DeepSeek R1 7B', sizeGb: 4.7,
    tags: ['reasoning'],
    description: 'Shows its thinking process. Great for complex logic and debugging.',
  },
  {
    name: 'deepseek-r1:14b', label: 'DeepSeek R1 14B', sizeGb: 9.0,
    tags: ['reasoning'],
    description: 'Stronger reasoning. Needs 16GB+ RAM.',
  },
  {
    name: 'gemma3:4b', label: 'Gemma 3 4B', sizeGb: 3.3,
    tags: ['fast', 'general'],
    description: "Google's Gemma 3. Fast and efficient on Apple Silicon.",
  },
  {
    name: 'phi4:14b', label: 'Phi 4 14B', sizeGb: 9.1,
    tags: ['coding', 'reasoning'],
    description: "Microsoft's Phi 4. Punches above its size for coding tasks.",
  },
  {
    name: 'mistral:7b', label: 'Mistral 7B', sizeGb: 4.1,
    tags: ['general'],
    description: 'Fast European model. Great general-purpose assistant.',
  },
]

export const TAG_LABELS: Record<string, string> = {
  all:       'All',
  coding:    '💻 Coding',
  reasoning: '🧠 Reasoning',
  fast:      '⚡ Fast',
  general:   '💬 General',
}
