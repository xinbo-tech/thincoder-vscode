# Changelog

## [0.1.29] — 2026-08-16

### Fixed

- **Stop 卡顿（渲染积压）** — 思考中长按 Stop 停不下来：reasoning/token 每来一个 chunk 就全文 markdown 重渲染 + DOM 重建 + 强制布局，O(n²) 累积淹没 webview 主线程，Stop 点击事件排在积压渲染后。改为 rAF 节流——token 到达只做 O(1) 字符串追加，每帧最多渲染一次，主线程始终留有空闲响应 Stop；finish 时同步 flush 最后一帧不丢
- **advisor/subagent 滚动也纳入节流** — 活动流内容本就是增量追加，但每 chunk 的 scrollTop=scrollHeight 强制布局一并折入 rAF
- **consult/escalate effort 枚举钳制** — 越界 effort 改为丢弃（而非保留 preset 默认残留），对齐 CLI 0.12.32+；qwen3.8-max 等越界候选不再"起飞即死"

## [0.1.28] — 2026-08-16

### Fixed

- **escalate turn-cap continue (CLI 0.12.32 parity)** — 飞刀撞 turn 上限后经面板问题卡弹"继续?"（主 agent 同款），用户选 Continue 则从子 agent 自身 history 续跑（agent.mjs 新增子 agent history 传入/回传支持），预算重置，上限 2 次；放弃/headless 退回 partial work 报告
- **escalate wall-clock watchdog removed** — 固定墙钟误杀正常但慢的手术（实测两个 max-effort 顾问读文件即撞 10min 墙），改为完全依赖 turn 帽 + FETCH_TIMEOUT + 用户 Stop 直传
- **escalate effort enum clamp** — 池里 effort 不在模型 reasoningEffortEnum 时回退预设并标注（此前该候选每次 chat 必抛错，"起飞即死"）

## [0.1.27] — 2026-08-16

### New

- **Plan-mode toolbar toggle (PLAN button)** — parity with AUTO/ADVISOR/ENG quick switches. Plan mode is now session-level persistent (stored in the slot like autoApprove), not turn-scoped; the button and the model's own plan tool stay in sync across turns

### Prompt system

- **Attention optimization + cross-end consistency**: split over-long sentences in main.md / discipline.md / advisor-round1/2/3; fixed an escalate-timing contradiction (up-front ability judgment, not post-failure); unified Review discipline + advisor rounds across both ends — all 15 prompt files now byte-identical with the CLI
- consult_start + main.md carry the 会诊 Chinese alias (parity with the 飞刀 alias)

## [0.1.26] — 2026-08-16

### Fixed

- **Turn-cap exhaustion now offers Continue, not retry-only** — at the 100-turn limit the panel showed a generic error (retry from scratch) instead of the CLI's "Continue?" (resume from the current context). panel-chat now catches ContinueError and shows a native Continue / Stop prompt; Continue re-runs with resume=true from the same history with a fresh turn budget. CLI parity (2026-08-16 user report).

## [0.1.25] — 2026-08-16

### Terminology unification (user decision: one word for one thing)

- **"surgeon" removed — everything is "escalate"**: the tool name and the spawned sub-agent's role were two words for one thing (escalate / 飞刀 / surgeon), and models confused them — kimi's first real run looked for a "surgeon" tool (it was a role, not a tool) and fell back to ad-hoc code; a main agent imported the escalate module instead of calling it. Now: role "surgeon" → "escalate", report/panel labels unified, ESCALATE.md glossary rewritten (escalate = the only technical name; 飞刀 = Chinese alias)

### Fixed

- **Coder sub-agents (subagent + escalate) get verify + advisor** — their system prompt names both tools but the tool table only gave them to depth-0 and eng-coder; the escalate surgeon hit "unknown tool verify" and self-verified via bash node --check/npm test. Diagnosed by a real deepseek escalate run
- **Consult cards showed FAILED (red) after user Stop** — read as "stop didn't work". cleanupConsultSessions now marks stopped before aborting so children settle as TERMINATED (clean grey), not FAILED
- Escalate description + main.md: direct-call guard (call the tool, never script the module)

## [0.1.24] — 2026-08-16

### Cache-hit-rate fixes (user-reported low hit rate, both reports diagnosed via consultation)

- **Time reminder moved to the END of the message sequence** (after the user input) — it was pushed before the input, and since the plugin reloads the machine line from disk each run (transient dropped on persist), its position drifted run-to-run → every run's first request had a different prefix → provider prefix caches never hit. Tail position can never disturb a prefix
- **Machine line keeps transient messages on persist** — reloading a slot / window reload / session switch must rebuild a byte-identical machine line or the whole prefix misses (same mechanism as the CLI report)
- The misplaced time push had also silently disabled the fresh-machine-line injections (context docs, MCP list, skills, AUTO/permission reminders) — restored

### Tool-call pairing 400 on strict providers (hit live during the first escalate run)

- Ported normalizeToolPairing: tool results reinserted right after their assistant, missing results filled with a placeholder, orphan tool messages dropped; compact gained reverse tail protection (assistant whose tool results were cut now pulls them back into the tail)

### Escalate (飞刀) gap batch (three-way review, flown to kimi-k3)

- Fresh code from a surgeon resets the parent's verify/advisor convergence budget (no more bypassing the gates); engineering mode fails closed pointing at eng-coder
- AbortError propagates (user Stop not swallowed); wall-clock watchdog; model-pick tolerates the " (effort)" suffix; no-API-key precheck
- Surgeon rows show the model name; reasoning + output stream into the panel; returns carry Touched files; ContinueError reads as partial work
- 飞刀 hook checkbox removed — every consult model is a surgeon candidate (fewer knobs); tool descriptions now list the current candidate pool so the model knows who it can pick

### Fixed

- Markdown tables: escaped pipe \| no longer splits the cell
- Design docs synced with implementation (status + current values)

## [0.1.23] — 2026-08-15

### Consultation panel shows the FULL process (consult-UI review)

- Reasoning streams live into each consultant's block as dimmed thinking text; output text streams as merged chunks — no more "tool calls only, where's the thinking?"
- Blocks auto-collapse when that consultant settles (answered / terminated / failed): the box folds to its title line, stays reopenable, content preserved
- Sub-blocks capped at 180px content height (advisor reviews stay 320px) with dimmer titles
- `onToken`'s depth gate now exempts `role === "consult"` (other subagents unchanged); a stale garbled comment from a bad merge cleaned

### Not done (consultation verdict, archived)

- Responses API transport: verified support matrix first-hand (OpenAI official + Qwen bailian complete; DeepSeek stateless stub; Kimi no endpoint) and consulted — decided NOT to implement: zero user benefit (the three differentiating capabilities are exactly the ones we don't use or already have) against real dual-repo continuation-loop coupling. Archived as a ready-to-trigger contingency with restart signals.

## [0.1.22] — 2026-08-15

### Escalate (飞刀) — hand intractable work to a stronger model

- New `escalate(task, model?)` tool: a flown-in expert surgeon gets WRITE access and does the implementation itself (reads, edits, runs tests), returning a post-op report the main agent reviews
- **Surgeon hooks**: consult rows carry a 飞刀 checkbox — hooked models form the candidate pool; the status line shows "consult N · surgeon M"; empty pool → tool not registered
- Reuses the coder subagent path: permission gate, activity stream in the conversation panel, mutations merged into the parent's verify/advisor bookkeeping
- Free-discretion trigger: early or late, the model's own judgment (no hard gates — one expert run costs about the same as doing it itself); user can also fire it manually
- Depth guard (a surgeon cannot fly in another surgeon) via `ctx.depth`, now exposed to all tools

### Consult boundaries liberalized

- The first-failure / simple-error / in-context bans are gone: when to consult is the model's judgment; the clause describes what benefits from independent perspectives and states the cost for the model to weigh itself. Mechanized hooks (verify-exhaust/stall) stay as entrance hints for consult (judgment gaps); escalate deliberately has none — it is a PRIOR ability assessment

### Fixed

- Time injection moved out of the system prompt into a transient per-run user reminder — system prompts fully static again (provider prefix caches hit across hours, not minutes); local time + IANA zone at second precision, covers all agent depths

## [0.1.21] — 2026-08-15

### Subagent & consultation visibility (user-requested)

- **Children stream live**: subagents (explore/plan/coder) and consultants forward their tool calls/results to an in-conversation collapsible panel — the user watches WHAT each child reads/runs instead of a status dot
- Consultation progress counter in the subagent panel header (👥 X/Y answered)
- Consult cards linger 60s (were 3s — the reply preview is the consultation's output) and the preview is 8KB (was 2KB)
- Consultation budget on the panel: turn limit + timeout (minutes) in the Consult & Advisor card; both were dead config before (agent.mjs never assembled them — panel edits did nothing)

### Consultation hardening round 2 (live regression findings)

- Consultants run on a lean consult-base.md system prompt (no main-agent persona conflict, budget guidance with concrete numbers)
- `question` excluded from ALL subagents — a background child must never prompt the user and hang
- Watchdog timeouts settle as "timed out after Nmin" (was indistinguishable from a provider crash); default raised 5→10 min
- consult_check description warns against batching with dependent calls

### Fixed

- **Proxy settings silently deleted**: the 0.1.20 "binding fix" never landed (CRLF-missed replace) — `|| document` fallback survived and re-posted proxy from an empty field on ANY input blur. Now bound per-control
- adv-enabled/adv-guard stopped persisting after the 7→5 card reorg (fell outside the change-to-save binding)
- Shell card wiring, effort dropdowns missing on open (spec-enum fallback), subagent ✕ wiping the advisor effort dropdown — from the earlier consultation batch
- bash tool description is platform-aware: cmd.exe semantics for the isolated child, PowerShell 5.1 warning (no &&) for terminal modes — models trained on bash emitted broken commands for both
- Local time + timezone injected into every system prompt (main, subagents, consultants, advisor) on both extension and CLI

## [0.1.20] — 2026-08-15

### Settings panel reorganization (consultation-derived design)

- **7 cards → 5**: the Agent junk drawer split into Agent (run parameters + subagent model assignments) and Consult & Advisor; MCP/Web Search/Semantic Index merged into Tools & Services; Proxy+Shell merged into Environment
- Three copy-paste implementations consolidated into shared keyRowEdit / buildEffortSelect components
- Key-row cancel restores the row in place instead of rebuilding the whole panel — in-progress edits elsewhere survive
- Delete is single-click (the 2.5s two-step armed timer is gone); save feedback unified to one card-level badge

### Consultation hardening (the feature reviewed itself)

- consult_stop'd children settle as terminated and no longer flood the reply queue with fake-failure notes
- Wall-clock watchdog per consultant (`agent.consultTimeoutMs`, default 5 min) + turn budget cut to 15 (`agent.consultTurns`)
- Consultants run as their own `consult` role — consult.md overlay, no explore-persona conflict, read-only tools
- Stall detection no longer false-fires on consult_check loops; stall / verify-exhaustion reminders suggest consult_start when configured
- main_history hardened: base64 images omitted, assistant tool calls surfaced, 60KB byte budget
- Panel: consult cards show the model name; answered/terminated/failed get proper colors + localized labels (was: everything red + raw English)
- Effort default prefers the model's official default and falls back to the LOWEST tier (was: highest)

### Fixed (five live bugs found by the consultation)

- Shell card was dead — no change listeners, selections silently dropped
- Proxy binding fell through to `document` and bound autoSaveProxy to EVERY input in the panel
- Light settings push stripped the shell value and never carried providerStatus (per-provider proxy checkboxes reverted)
- Clearing a subagent slot also wiped the Advisor effort dropdown
- Consult/advisor effort dropdowns missing on panel open (the enum depended on network-probe timing)


All notable changes to ThinCoder VS Code are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
## [0.1.19] — 2026-08-15

### Added

- **Unified model picker** — every model selection (main panel, subagent slots, advisor, consult rows) now uses ONE two-level hover menu component, rebuilt on the overlay paradigm: full-screen fixed backdrop + viewport-rect positioning, up/left flips, zero style inheritance, no clipping possible.
- **Consultation + advisor effort levels** — per-model thinking-effort dropdown (spec-driven enums, official defaults preselected: DeepSeek high, GLM/Kimi max, qwen3.8 xhigh); persisted explicitly as {provider, model, effort} and injected into consult/advisor sub-requests.
- **MCP tools expander** — each server row has a Tools button that lists the server's exposed tools (name/description/params) inline; doubles as a connectivity test.
- **Follow-scroll pin** — scrolling up during streaming pauses auto-scroll (read history without fighting the stream); scrolling back to the bottom or the floating button re-pins.
- **qwen3.8-max effort enum** — xhigh (official default) / medium / low.

### Changed

- **Settings cards are change-to-save** — Agent/Consult, Proxy, and Shell cards save immediately on change (submit buttons removed); form-style dialogs (API keys, add-provider, MCP) keep their confirm buttons.
- **Settings panel rebuilds only on open** — the whole push-driven rebuild machinery (rebuildIfIdle, echo suppression, dirty windows, debounce) is deleted; saves write config.json and never repaint the panel under your hands.

### Fixed

- Consult models lost on window reload (the read path dropped the field).
- Consult rows vanishing after add/pick (preselect-created half-filled row blocked every save).
- Cleared subagent/advisor values resurrecting (undefined never survives postMessage; clears now send explicit null).
- Model picker: popup clipped by cards, flyout dying under a stationary pointer, flyout never reopening, backdrop wheel killing in-flyout scrolling, long provider descriptions blowing the menu width.
- Advisor pick not repainting the trigger; consult status line not updating after adding a model.

## [0.1.18] — 2026-08-14

### Fixed

- **Consult model settings UX rebuilt**: the model dropdown now always offers the provider entry's current model as an offline fallback (no more dead-end empty dropdown when the model-list probe failed); half-filled rows block the save flagged red with a status hint (never silently dropped); the sole configured provider is preselected in new rows; a status line shows whether consultation is active (N models) or off.

## [0.1.17] — 2026-08-14

### Fixed

- **Consult "Add consult model" produced an empty row** — dynamically added rows passed the full provider-status object where the providers map was expected, so the provider dropdown listed nothing (looked like a dead button). Binding also moved outside the save-button guard so upstream failures can no longer silently disable it, with console diagnostics.

## [0.1.16] — 2026-08-14

### Fixed

- Removed a stray empty file that slipped into the 0.1.15 package (shell-escaping artifact; no functional change).

## [0.1.15] — 2026-08-14

### Added

- **glm-code provider preset** — the Zhipu GLM Coding Plan endpoint (`https://open.bigmodel.cn/api/coding/paas/v4`, glm-5.2, same key as the standard GLM entry; note: that endpoint forces thinking server-side and ignores `thinking: disabled`).

### Fixed

- **GLM/Kimi never thought unless the provider entry said so** — thinking-capable models now default `thinking: {type: "enabled"}` when the entry omits the field (zhipu-plan entries are created without one). Explicit values, including the panel's off, always win.
- **The panel's reasoning "off" button never actually disabled thinking** — the UI sends `"none"` (the effort enum's lowest level) but the wiring only recognized the literal `"off"`; both now map to a true off. (Endpoints that force thinking server-side — e.g. the Zhipu coding plan — will still emit reasoning regardless.)
- **Model specs synced with official vendor docs (verified 2026-08)** — kimi-k3/k3 maxOutput 128K→131072 + cache auto; qwen3.x maxOutput→131072 (qwen-plus was 32K) and 3.7/3.8-max flagged thinking; DeepSeek v4-flash context 256K→1M and thinking→true, effort enum +low, cache auto.
- **Retired models dropped** — kimi-k2, moonshot v1, deepseek-chat, deepseek-reasoner (per vendor shutdown announcements; unknown IDs fall back to the 128K default spec).

### Changed

- Repository/homepage/bugs URLs → github.com/xinbo-tech/thincoder-vscode.

## [0.1.14] — 2026-08-14

### Added

- **Multi-model consultation (会诊)**: configure up to 5 models (new Settings UI: ⚙ → Agent card → Consultation models). When stuck, the agent — or you, via "发起会诊" — runs `consult_start` to analyze the problem across all models in parallel. Replies are read one at a time as they arrive (`consult_check`); you/the agent verify with your own tools; `consult_stop` aborts the rest early. Consultants are read-only and can pull the main session's failure trail via `main_history`. The mechanism does zero judging — that stays with the main agent.
- **Stop trace observability**: opt-in setting `thincoder.stopTrace` logs every abort hop (click → rate gate → request → stream → tool batches → unwind → UI released) with timestamps to the "ThinCoder Stop Trace" output channel, to diagnose "Stop during reasoning output does nothing".

### Fixed

- **Stop hung on question/permission cards**: aborting while the agent waited for an answer never resolved the promise — the UI stayed "running" until the (now irrelevant) card was answered. Both now release immediately (question → cancelled, permission → denied).
- **Retry backoff / rate-limit sleeps ignored Stop**: backoff (up to 60s) and rate-gate waits were bare sleeps; aborts now break them immediately.
- **edit failed on every CRLF file**: the model writes LF in old_string but files were read raw — EOL is now normalized on read and the file's original line-ending style preserved on write.
- **Reasoning output rendered as plain text**: thinking blocks now go through the markdown renderer (headers/code/bold), with scaled-down styles.

## [0.1.13] — 2026-08-14

### Added

- **Clickable file paths in tool cards**: workspace-real paths (fs-verified) in tool output become links that open in the editor at the referenced line.
- **Native diff viewer for large permission prompts**: diffs over 12 changed lines get a "View in editor" button opening vscode.diff (virtual documents; the real file is never touched).
- **Completion notification when unfocused**: a turn that finishes while the window is unfocused raises a system notification with a View action. Silent while focused.
- **Live bash output streaming**: long commands stream their output into the running tool card (opens while streaming, auto-collapses on success).

### Fixed

- **bash silent-output defect**: the exit-grace timer raced the exec callback and reported a hardcoded "(empty)", discarding real output. Incremental capture (CLI parity) with stream decoders (multi-byte UTF-8 chunk-safe, GBK fallback), ANSI sanitize, 2MB per-stream caps; abort and grace paths now return the collected partial output.
- **Collapsed bash card summary** no longer shows "→ (exit code 0)" — wrapper lines are skipped so the meaningful last line shows.
- **eng-coder design-token gate rejected valid approvals**: the token regex matched only the uuid segment while the advisor echoes the full signed token — the VS Code port carried a stale regex the CLI had already fixed.
- **edit tool corrupted files containing ## [0.1.12] — 2026-08-14/$1**: string-form replace interpolated JS replacement patterns into new_string; function replacers now (CLI parity).

## [0.1.12] — 2026-08-14

### Added

- **bash terminal modes**: `terminal: "visible"` runs a command in the user's own terminal via shell integration (inherits their shell state — cwd, activated venv/conda, env vars); `terminal: "inject"` fills the command for the user to review without executing. Stop/timeout send Ctrl+C; falls back to the isolated child process when shell integration is unavailable.

### Fixed

- **@ file references never worked**: the trigger read the character BEFORE the just-typed @ (off-by-one), so the autocomplete dropdown never activated. Works mid-line and at line start; whitespace closes it.
- **Restored tool cards showed "tool"** instead of the tool name: tool result messages were persisted without a name, so restored history had nothing to display. The name now rides on the tool message at write time.
- **Status bar / tool-error labels showed raw i18n keys** (status.currentTool / status.turns / status.elapsed / tool.error): the keys were referenced but missing from both locales. Added en+zh; also removed 20 dead locale entries and locked the contract with a completeness test.
- **First-run welcome silently failed to render**: showWelcomePanel touched four ctx fields that were never mapped, so it threw before displaying. Mapped them; the panel now actually shows.

### Changed

- **A send with no configured provider re-opens the welcome panel** (even after Skip) so the user lands on configuration instead of a dead-end error banner.
- **Agent edits refresh the Markdown preview**: writing a .md file now fires markdown.preview.refresh (the preview was caching stale content).
- **Session switching already preserved the input draft** (baseline claim was wrong); locked with a regression test.

## [0.1.11] — 2026-08-14

### Changed

- **Tool cards auto-collapse on completion**: a successful tool call folds to one line — name, elapsed time, and the → last-line summary in the header (CLI outputPanel parity). Errors stay expanded so failures are visible without a click. Session-restored cards already behaved this way; live and restored states now match.

## [0.1.10] — 2026-08-13

### Fixed

- **Editor dual-channel data loss**: file tools edited open documents via WorkspaceEdit but never saved, leaving the buffer dirty while disk stayed stale — the next edit self-locked on the isDirty guard and external writes raced the user's later save. Edits now save immediately after applying.
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
