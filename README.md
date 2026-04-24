# Lumi

**Lumi** is a local-first AI desktop app — run powerful models offline, connect to cloud APIs, or combine both in Duo Mode. Built for developers who want a fast, private, and capable AI assistant on their own machine.

## Features

- **Local models** — download and run GGUF models (Llama, Qwen, Mistral, etc.) fully offline via llama.cpp
- **Cloud models** — plug in free API keys for Groq, OpenRouter, NVIDIA NIM, Anthropic, Google, Mistral, Qwen, MiniMax, and more
- **Agent mode** — autonomous coding agent with file read/write, shell, and git — works like Claude Code locally
- **Duo Mode** — pair a reasoning model (planner 🧠) with a fast executor (🤖) for complex tasks
- **Image generation** — built-in image gen via sd.cpp sidecar
- **Multi-session chat** — sidebar with persistent chat history, switch between tasks anytime
- **Context panel** — live token counts, cost estimates, context usage gauge, raw message view
- **Push panel** — AI-generated commit messages, branch selector, one-click push
- **Permission mode** — ask before each tool call, or "Do all" to auto-approve

## Download

Get the latest release from [GitHub Releases](../../releases).

- **macOS** — `.dmg`
- **Windows** — `.exe` (NSIS installer)

## Quick start

1. Download and install Lumi
2. Click **⚡ Models** to browse available models
3. Download a local model **or** click **Select model ▾** to use a free cloud API
4. Start chatting in **💬 Chat**

## Free cloud models (no GPU needed)

| Provider | Key URL | Notes |
|---|---|---|
| Groq | console.groq.com | Fastest free tier |
| OpenRouter | openrouter.ai | Access to many models |
| NVIDIA NIM | build.nvidia.com | Nemotron, Llama |
| Mistral | console.mistral.ai | Codestral for code |
| Qwen | dashscope.aliyuncs.com | Huge context windows |

## Tech stack

- **Electron** + **Vite** + **React** + **TypeScript**
- **node-llama-cpp** v3 for local GGUF inference
- OpenAI-compatible SSE streaming for all cloud providers
- Markdown rendering, syntax highlighting, diff viewer

## Development

```bash
npm install
npm run dev       # start in dev mode
npm run build     # production build
npm run dist:mac  # package DMG
npm run dist:win  # package Windows installer
```

## License

MIT
