# Changelog

All notable changes to ThinCoder VS Code are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.10] — 2026-08-13

### Fixed

- **SVG images bricked the whole session** (Kimi 400 "unsupported image format" on every subsequent request): a read_image on an .svg put an `image_url` part into history that raster-only vision APIs reject, and it was re-sent on every turn. Image parts are now sanitized per-format at send time — non-png/jpeg/gif/webp data URLs become text placeholders, history untouched, so already-poisoned sessions recover on the next send. (CLI 0.12.23 parity)

### Changed

- **read_image**: svg files return their text source instead of an image part (svg is markup — any model can read it, no vision support needed); bmp is rejected with a convert-to-PNG hint (no mainstream vision API accepts it).

## [0.1.9] — 2026-08-13

### Added

- **CLI keyboard parity**: Ctrl+C stops a running turn (a text selection still copies), Ctrl+I opens an interrupt-and-inject prompt (partial output committed, message injected, turn resumes on a rebuilt controller — full CLI interrupt semantics), Ctrl+F opens in-conversation search (live highlight + match counter + navigation), Ctrl+U clears the input line.

### Fixed

- **Stop actually stops**: bash long-running commands now kill the whole process tree on Stop (CLI killProcessTree parity), and tool-execution AbortErrors propagate out of the batch instead of being swallowed into "Error:" tool results — the "clicked stop, kept running, stopped a few turns later" bug.
- **Input-history ↑ never worked**: navigateInputHistory computed -1 + (-1) = -2 which clamped back to -1, so ArrowUp at the top could never recall a prior message. Fixed to CLI semantics (draft → newest, walk older).
- **Error banner**: shows a friendly first line with URLs stripped; full detail + provider/model folds into Details.

### Changed

- **Add-provider flow**: a custom provider's model is now PICKED from a /models-probed dropdown (validates baseURL+key — no more silent hand-typed typos); preset adds also verify the connection right after save and surface failures in the settings error banner.

## [0.1.8] — 2026-08-13

### Fixed

- **Tool output scroll follow**: `finishTool` auto-expanded the card's output but never scrolled the conversation, so long results sat below the fold. Now scrolls into view on completion.
- **Cache-hit % missing for non-DeepSeek providers**: Kimi/OpenAI report the cache hit as `prompt_tokens_details.cached_tokens` while the status bar read DeepSeek's `prompt_cache_hit_tokens`. Usage is now normalized so the cache-hit % renders for Kimi/OpenAI-style providers too (miss derived as prompt_tokens − hit).

### Changed

- **Bash output renders inline in the conversation tool card** — the side tool panel push was removed (it duplicated what `finishTool` already renders and lingered after completion); tool-result cap raised 2000→20000 chars (the card scrolls). The now-unused side tool panel (container + render logic + CSS) is removed.
- **Settings panel**: advisor provider/model and all subagent model overrides (global + explore/plan/coder/eng-coder) are dropdowns listing known providers/models instead of free-text. New **Web Search** card to configure the optional Tavily key.

## [0.1.7] — 2026-08-13

### Fixed

- **Settings panel layout collapse**: cards were shrinking into tiny clipped stubs — `.settings-card`'s `overflow: hidden` zeroed its flex min-height inside the `.panel-body` flex column, so tall content got compressed and truncated. Cards now keep their natural height (`flex-shrink: 0`) and the panel scrolls.
- **Session deletion confirmation**: deleting a session now asks for inline confirmation (native `window.confirm` is inert in the webview sandbox). Previously an irreversible whole-session delete fired with no guard.

### Security

- **SSRF guard for `fetch`** (CLI parity): the VS Code port shipped `fetch` without the private-host check the CLI has. Now blocks loopback / cloud-metadata / RFC1918 / IPv6-private targets, and refuses redirects (a 3xx could bounce a public URL into a private host via native fetch auto-follow).

### Added

- **Tavily structured search** (optional): set `websearch.apiKey` in the shared config.json and `websearch` returns clean JSON via the Tavily API instead of scraping Bing HTML. No key → silent Bing fallback.

## [0.1.6] — 2026-08-13

### Fixed

- **Repeated "❯ ThinCoder:" labels**: live streaming painted one label per LLM-response segment (every tool batch started a fresh block, each with its own label); history restore painted one per message. Both now render ONE label per turn — live via a turn-level guard, history via a `turnStart` flag computed in `historyWindow` from the raw predecessor (correct across lazy pages).

### Added

- **In-conversation advisor block**: advisor output now streams into a reasoning-style details block INSIDE the conversation flow — full content in a scrolling region, never truncated (was: hard-capped at 20k chars in the side tool panel), with the round number in the summary ("Advisor Review (Round N)").
- **Question cards always accept free-text answers**: cards with preset options now also show an input — users can supplement or correct the AI's choices instead of being forced to pick.

### Changed

- **Removed per-message action buttons** (copy / delete / edit) — never-requested over-engineering; historical messages are now clean label + content. Code-block copy buttons are kept.
- **Engineering-mode prompt**: open-ended questioning style (free-text by default, options only for finite enumerations, one question at a time) + five review fixes (requirements-first step, designToken via parameter only, advisor findings in sign-off, clarification done-criteria, 3-round advisor retry cap).

## [0.1.5] — 2026-08-13

### Fixed

- **TUI/CLI session divergence** ("TUI shows far fewer messages"): the extension never updated the CLI's `display` WYSIWYG snapshot, so returning to the TUI resumed a STALE snapshot and hid every message added in VS Code. The extension now clears `display` on write — the CLI (deprecated the field entirely) rebuilds from history, and rebuilds lazily (latest 200 messages + PgUp pages).
- **Test-quality issues** (advisor-reviewed): an always-true assertion in advisor tests, a vacuous proxy assertion, smoke-provider preset drift (deepseek/minimax endpoints diverged from config-io), and a missing `format` propagation that sent claude/gemini through the OpenAI transport in the smoke tool.

### Added

- **First-run onboarding**: when no provider has a key, the panel opens a guided setup — pick a preset, paste the API key, Save & Start. Closes itself once a key lands; Skip defers; Full settings hands off to the complete settings panel.
- **Webview automated coverage** (happy-dom): message/tool rendering, settings-panel cards and switches, the save flow, diff-preview line classification, and the welcome panel — the webview went from zero coverage to DOM-level regression tests.

## [0.1.4] — 2026-08-13

### Fixed

- **i18n lost on Reload Window**: labels showed raw keys like "msg.user" after a window reload — the extension pushed i18n right after setting webview.html, but the webview loads asynchronously and the message was dropped. The webview now handshakes `webviewReady` and the extension re-pushes initial state.

### Changed

- **Settings panel redesign**: sections are now cards with titles, provider rows show a status dot + name + actions (model·url aligned below, proxy as a switch), all booleans are switch toggles, unified label style, removed dead CSS and hardcoded spacing.
- **execute tool — no fake sandbox**: `require()`/Node API access is now available (the bash tool already reached it, so blocking require only misled the model). Removed the dynamic-import block and SSRF private-host rejection; kept timeout, cwd confinement, and output caps as engineering guards.

## [0.1.3] — 2026-08-13

Repackaged release — 0.1.2 shipped with a stray temporary file in the vsix; `.vscodeignore` now excludes scratch files.

## [0.1.2] — 2026-08-13

### Fixed

- **Stop now actually stops** (the bug reported since 0.1.0): the SSE read loops never watched the abort signal — clicking Stop mid-response drained the whole stream, then tool calls kept running. All three transports now check the signal per chunk AND race an abort promise, so even a silent stream breaks. Verified end-to-end against a real HTTP server (~0.6s).
- **"object is not iterable" on send**: with an active editor inside the workspace, the editor-context injection (a single message object) was iterated as an array on EVERY message — sending always failed. Now accepts object or array.
- **Stop interrupts lint/verify runs**: `execSync` froze the extension-host event loop (the abort message could not even be delivered). lint and verify now run via an interruptible spawn that kills the child on Stop.
- **Settings panel feedback gaps**: add-provider errors were silently dropped (no webview handler), MCP save/delete never refreshed the list, index build left the panel stuck on "Building…". All fixed, plus two-step delete confirmation, save-button feedback, tooltips on advanced controls, form edits surviving status pushes, and full i18n.

### Added

- **ADVISOR / ENG toolbar switches** next to AUTO — quick toggles for advisor review and engineering mode, mirrored with the settings panel.
- **Status-bar run indicator**: ThinCoder status in the window status bar (idle / running / waiting for your input) — click to focus the panel.
- **apply_patch approval preview**: multi-file patches now render in the permission prompt with +/- coloring instead of blind approval.
- **Tool-panel output follows the stream** (no more output hidden below the fold) and a **scroll-to-bottom button** for lazy-loaded history.
- **Engineering debt**: CI runs the full test suite on Node 24, subagent questions render inline in the panel, the legacy `thincoder.mcpServers` setting and migration code removed.

## [0.1.1] — 2026-08-13

### Fixed

- **Repeated approval prompts**: clicking "Approve All" (or toggling AUTO) kept prompting for every later tool in the SAME turn. `autoApprove` is now session-level (stored in the shared slot file, CLI parity) and the agent loop reads it live — a mid-turn flip takes effect immediately.
- **"The operation was aborted due to timeout"**: the request ceiling was 2 minutes; reasoning models on long contexts legitimately think longer. Raised to 10 minutes (CLI parity).
- **Wrong context % in the status bar**: read a non-existent spec field and fell back to 128K — 1M-context models showed absurd values like 137%. Now divides by the real context window and warns in yellow at ≥80%.
- **Compaction parity**: `KEEP_HEAD=0` (earliest messages go into the summary — no stale-task anchoring), pure-estimation path now counts the tools-schema overhead, multimodal message text is extracted into the summary serialization.

### Added

- **Lazy history loading**: long sessions load only the last page on open; scrolling to the top loads earlier messages automatically (scroll position preserved).
- **Inline question prompts**: the `question` tool now renders inside the chat panel (option buttons / text input) instead of VS Code's native popup at the window top.

## [0.1.0] — 2026-08-13

- Initial public release.

### Features

- Side-panel chat UI (`ctrl+alt+t` / `cmd+alt+t`) with full agent loop — multi-turn tool calling, parallel tool batching, subagents, plan mode, task tracking, long-term memory
- Sessions shared on-disk with the ThinCoder CLI (`~/.thincoder/sessions/`) — both ends read/write the same slots
- Provider config shared with the CLI (`~/.thincoder/config.json`) + in-panel settings UI with proxy support
- Tool approval mode: file-modifying tools require confirmation unless `thincoder.autoApprove` is on
- 20+ tools: file ops, bash, glob, grep, git, web fetch/search, checkpoints, read_image
- MCP client (stdio + HTTP transports)
- Zero npm runtime dependencies — pure Node.js standard library + VS Code API, no build step
