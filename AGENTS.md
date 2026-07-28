# AGENTS.md — ThinCoder VS Code Extension Guide

## Project Overview

VS Code extension wrapping the ThinCoder AI coding agent. Provides a side-panel chat UI with full agent capabilities — multi-turn tool-calling loop, subagents, plan mode, task tracking — all inside the editor. Zero npm runtime dependencies (pure Node.js standard library + VS Code API).

Design docs in `docs/design/`. Independent product — no dependency on thincoder CLI.

## Hard Constraints

- **Zero npm runtime dependencies**: only `node:` standard library and VS Code Extension API (`vscode` module). No TypeScript, no build/bundling step.
- ESM (`.mjs`) throughout — `package.json` declares `"type": "module"`.
- LLM calls go through native `fetch` with SSE streaming, same as thincoder core.
- Tool implementations are adapted for VS Code context (workspace root = cwd, but directory confinement is relative to the first workspace folder).

## Key Conventions

- **Entry point**: `extension.mjs` — `activate()` registers commands and sets up the ChatPanel.
- **Webview separation**: the chat UI (`webview/`) runs in an isolated iframe, communicating with the extension host via `postMessage`. No shared state between extension and webview beyond the message protocol.
- **Session persistence**: workspaceState holds lightweight index `{ active, sessions: { name: { title, count, updated } } }`. Full message arrays stored as JSON files under `context.storageUri/sessions/` to avoid VS Code's ~10MB workspaceState limit. Index stays < 1KB regardless of usage volume.
- **Provider config**: stored in VS Code `configuration.get("thincoder.providers")`. Keys are plaintext in VS Code settings — a known trade-off (migration to `SecretStorage` planned).
- **Tool approval**: `thincoder.autoApprove` defaults to `false`. When off, the model runs in permission mode — it describes planned changes and waits for confirmation before executing file-modifying tools. When on, all tools execute automatically.
- **No legacy migration code**: project is pre-release — breaking changes are expected. When storage format changes, just change it. Migration boilerplate becomes dead code instantly.
- **Model specs**: self-contained `src/config.mjs` with MODEL_SPECS table. No runtime dependency on any external product.

## Key Modules

```
extension.mjs        Extension entry + ChatPanel class (session CRUD, settings, LLM title generation)
src/agent.mjs        Agent main loop — tool execution, context compaction, subagent spawning
src/agent-tools.mjs  Self-discipline tools: task, recent_changes, subagent, plan, goal, skill, verify
src/tools.mjs        VS Code-adapted tools (20+): file ops, bash, glob, grep, git, web, checkpoint
src/provider.mjs     LLM provider (fetch + SSE, rate-limit retry with backoff)
src/context.mjs      Context compaction + repo dependency outline builder
src/config.mjs        Model capability specs (self-contained copy — context window, thinking API, temp ranges)
src/specs.mjs         Re-export from config.mjs (kept for backward compat)
src/prompts/         System prompts (6 files): system.md, discipline.md, main.md, explore/coder/plan.md
webview/chat.js      Frontend orchestration: message handling, model selector, session history
webview/ui.js        DOM helpers: welcome banner, message bubbles, tool call rendering
webview/md.js        Lightweight Markdown → HTML renderer
webview/style.css    Chat panel styles
webview/index.html   Webview shell (referenced by ChatPanel._html())
```

## Webview ↔ Extension Message Protocol

| Direction | Message Type | Payload |
|-----------|-------------|---------|
| webview → extension | `userMessage` | `{ text, model?, reasoning?, provider? }` |
| webview → extension | `abort` | — |
| webview → extension | `newSession` / `switchSession` / `deleteSession` / `getSessions` | `{ name? }` |
| webview → extension | `selectModel` / `selectReasoning` | `{ model, provider? }` / `{ reasoning }` |
| extension → webview | `token` | `{ text }` |
| extension → webview | `toolCall` / `toolResult` | `{ name, args? / text }` |
| extension → webview | `complete` / `loading` / `aborted` / `error` | `{ text? }` |
| extension → webview | `providerInfo` | `{ text, keyOk, needsSetup?, settings? }` |
| extension → webview | `models` | `[{ id, label, provider, group, reasoning[] }]` |
| extension → webview | `sessions` | `{ sessions: [{ name, title, count, active, updated }], active }` |
| extension → webview | `userMessage` / `assistantMessage` | `{ text }` (history replay) |
| extension → webview | `clearMessages` | — |

## Agent Lifecycle

1. User sends message → `ChatPanel._chat()` called
2. Abort previous run via `AbortController`
3. Append user message to persisted history
4. Call `runAgent(provider, cwd, text, callbacks, signal, autoApprove)`
5. Agent loop runs (tool execution, context compaction, subagent spawning)
6. Each token → `onToken` callback → webview `token` message
7. Tool calls/results → `onToolCall`/`onToolResult` callbacks → webview messages
8. On complete → append assistant message to history, trigger title generation if first exchange
9. On abort → send `aborted` to webview
10. On error → send `error` with provider/model context

## Testing

- No test suite yet (planned). Manual smoke test: open a workspace, configure a provider, send a message, verify tool execution and response streaming.
- After modifying agent loop or tools: test with a simple file operation (read + write) and a multi-turn conversation.
