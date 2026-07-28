# ThinCoder for VS Code

**Full AI coding agent, inside your editor. Zero bloat.**

ThinCoder VS Code gives you the complete ThinCoder agent — multi-turn tool-calling, subagents, plan mode, task tracking — in a side panel. It reads your project, writes code, runs commands, searches the web, and explains its work as it goes.

Like the CLI, it's pure `.mjs`, zero npm dependencies, and connects directly to top-tier models via OpenAI-compatible APIs.

## Features

- **Full agent loop** — multi-turn reasoning, tool execution, context compaction
- **20+ built-in tools** — read, write, edit, bash, glob, grep, git (diff/status/log), websearch, fetch, checkpoint, question, syntax_check, and more
- **Subagents** — explore (codebase search) / plan (architecture design) / coder (implementation), dispatched concurrently
- **Plan Mode** — read-only exploration → design proposal → user approval → implement
- **Task tracking** — `task` tool breaks down multi-step work with pending/in_progress/done status
- **Verify guard** — file changes without verify get pushed back; syntax check + tests must pass before claiming completion
- **Context compaction** — automatically summarizes old messages when conversation grows too long
- **Repo outline** — scans project import/export dependencies so the agent understands your codebase structure
- **Multi-session** — save and switch between conversation sessions; LLM auto-generates session titles
- **6 providers** — DeepSeek, Kimi, GLM, Qwen, MiniMax, OpenAI + custom OpenAI-compatible endpoint
- **Model selection** — choose from all available models per provider, with reasoning effort control
- **Permission control** — `autoApprove` (off by default) lets you decide whether tools run automatically or require confirmation

## Requirements

- VS Code >= 1.85.0
- An API key for at least one supported provider

## Quick Start

1. Install the extension from VS Code Marketplace (or `vsce package` + sideload)
2. Press `Ctrl+Alt+T` (Mac: `Cmd+Alt+T`) to open the ThinCoder panel
3. On first open, the setup wizard will prompt you to add an API key
4. Start chatting — ThinCoder reads your workspace and responds

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `ThinCoder: Open Chat` | `Ctrl+Alt+T` | Open the chat panel |
| `ThinCoder: Send Message` | — | Quick input box → send message to chat |
| `ThinCoder: Setup Provider & API Key` | — | Add or change API keys |

## Configuration

All settings under `thincoder.*` in VS Code settings:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `thincoder.providers` | object | `{}` | API keys and custom provider config. Keys are provider names (`deepseek`, `kimi`, `glm`, `qwen`, `minimax`, `openai`, `custom`). Value is a key string (`"sk-xxx"`) or an object `{ key, baseURL, model }` for custom providers. |
| `thincoder.autoApprove` | boolean | `false` | When enabled, the agent auto-executes file-modifying tools without asking. **Off by default for safety — you must explicitly opt in.** |

### Supported Providers

| Provider | Default Model | API Endpoint |
|----------|--------------|-------------|
| DeepSeek | `deepseek-v4-pro` | `https://api.deepseek.com/v1` |
| Kimi (Moonshot) | `kimi-k3` | `https://api.moonshot.cn/v1` |
| GLM (Zhipu) | `glm-5.2` | `https://open.bigmodel.cn/api/paas/v4` |
| Qwen (Alibaba) | `qwen3.7-max` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| MiniMax | `MiniMax-M3` | `https://api.minimax.chat/v1` |
| OpenAI | `gpt-4o` | `https://api.openai.com/v1` |
| Custom | (user-specified) | User-configured |

## Architecture

```
┌──────────────────────────────────────────┐
│  VS Code Extension Host                  │
│  ┌────────────┐  ┌────────────────────┐  │
│  │ ChatPanel  │  │  Agent Loop        │  │
│  │ (session   │  │  (agent.mjs)       │  │
│  │  mgmt,     │  │  - tool execution  │  │
│  │  settings) │  │  - context compact │  │
│  └─────┬──────┘  │  - subagent spawn  │  │
│        │         └────────┬───────────┘  │
│   postMessage            │               │
│        │         ┌───────┴───────────┐   │
│        │         │  Provider         │   │
│        │         │  (fetch + SSE)    │   │
│        │         └───────────────────┘   │
│  ┌─────┴──────────────────────────────┐  │
│  │  Webview (iframe)                  │  │
│  │  - chat.js (orchestration)         │  │
│  │  - ui.js (DOM rendering)           │  │
│  │  - md.js (Markdown)                │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

- **Extension host** runs the agent loop, manages sessions, and talks to LLM providers
- **Webview** handles the chat UI — message display, model selector, session history, settings panel
- Communication is one-way message passing: webview sends `userMessage`/`abort`/`setup` etc., extension sends `token`/`toolCall`/`complete`/`error` etc.

## Development

```bash
# No build step — the extension runs directly from source
# Edit extension.mjs, src/*.mjs, webview/*.{js,css,html}

# Package for distribution
npx @vscode/vsce package
```

### Project Structure

```
thincoder-vscode/
├── extension.mjs         # VS Code entry point
├── package.json          # Extension manifest
├── AGENTS.md             # Developer guide
├── README.md             # This file
├── src/
│   ├── agent.mjs         # Agent main loop
│   ├── agent-tools.mjs   # Meta-tools (task, subagent, plan, goal, verify)
│   ├── tools.mjs         # File/system/git tools (20+)
│   ├── provider.mjs      # LLM provider with retry
│   ├── context.mjs       # Context compaction + repo outline
│   ├── config.mjs        # Model capability specs (self-contained)
│   ├── specs.mjs          # Re-export from config.mjs
│   └── prompts/          # System prompts
├── webview/
│   ├── chat.js           # Frontend orchestration
│   ├── ui.js             # DOM helpers
│   ├── md.js             # Markdown renderer
│   ├── index.html        # Webview shell
│   └── style.css         # Styles
└── docs/
    └── design/           # Design docs
```

## vs. ThinCoder CLI

| Feature | CLI (`thincoder`) | VS Code Extension |
|---------|-------------------|-------------------|
| Interface | Terminal TUI (ANSI) | VS Code side panel |
| Memory system | 3-layer FTS5 + vector | Not yet (planned) |
| Checkpoint | Git snapshot restore | Git diff/status/log only |
| MCP support | ✅ | Not yet (planned) |
| Session persistence | 5 archive slots | Filesystem (storageUri) — no size limit |
| Skill system | ✅ | ✅ |
| Plan mode | ✅ | ✅ |
| Subagents | ✅ | ✅ |
| Verify guard | ✅ | ✅ |
| Image input | `read_image` tool | Not yet (planned) |
