# Changelog

All notable changes to ThinCoder VS Code are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
