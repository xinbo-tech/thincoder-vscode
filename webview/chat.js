/**
 * chat.js — main orchestration: state, events, token handling
 */
import { md } from "./md.js"
import { openModelMenu, closeModelMenu } from "./model-menu.js"
import { fmtK, patchLineType } from "./lib.js"
import { renderDiff, lineDiff } from "./diff.js"
import {
  showWelcome, showBanner, addUser, addAssistantHistory, newBlock,
  addTool, addToolHistory, finishTool, setLoading, showError, scrollDown, maybeScrollDown, initScrollFollow, escHtml,
  buildHistoryMessage, buildAdvisorBlock, appendAdvisorChunk,
} from "./ui.js"
import { setStrings, t } from "./i18n.js"
import { initAutocomplete } from "./autocomplete.js"
import { initSettings } from "./settings.js"

const vscode = acquireVsCodeApi()
window._vscode = vscode

const ctx = {
  vscode,
  messagesEl: document.getElementById("messages"),
  inputEl: document.getElementById("input"),
  sendBtn: document.getElementById("send-btn"),
  abortBtn: document.getElementById("abort-btn"),
  modelBtn: document.getElementById("model-btn"),
  reasoningBtn: document.getElementById("reasoning-btn"),
  dropdown: document.getElementById("model-dropdown"),
  reasoningDropdown: document.getElementById("reasoning-dropdown"),
  sessionSelector: document.getElementById("session-selector"),
  sessionTitle: document.getElementById("session-title"),
  sessionDropdown: document.getElementById("session-dropdown"),
  currentBubble: null, currentBlock: null, currentTools: [], currentRaw: "",
  currentReasoning: null, currentReasoningRaw: "",
  isRunning: false, hadToolResult: false,
  _toolRefs: {}, // tool id → ref, for O(1) finishTool lookup
  _models: [],
  selectedModel: "", selectedProvider: "", selectedReasoning: "max",
  _sessions: [], activeSession: 0,
  _pastedImages: [],
  _inputHistory: [], // sent inputs (memory, per panel session — CLI parity)
  _historyIdx: -1,   // -1 = showing the live draft
  _inputDraft: "",   // stashed in-progress text while navigating history
  // Turn-level assistant label guard (CLI ensureAssistantLabel parity): one
  // "❯ ThinCoder:" per TURN, not per LLM-response segment. onToken/onReasoning
  // start a fresh block after each tool batch; without this every segment
  // painted its own label.
  assistantLabeled: false,
  // First-run onboarding panel
  welcomePanel: document.getElementById("welcome-panel"),
  welcomeHeading: document.getElementById("welcome-heading"),
  welcomeText: document.getElementById("welcome-text"),
  welcomeProviderLabel: document.getElementById("welcome-provider-label"),
  welcomeProvider: document.getElementById("welcome-provider"),
  welcomeKeyLabel: document.getElementById("welcome-key-label"),
  welcomeKey: document.getElementById("welcome-key"),
  welcomeSaveBtn: document.getElementById("welcome-save-btn"),
  welcomeSkipBtn: document.getElementById("welcome-skip-btn"),
  welcomeSettingsBtn: document.getElementById("welcome-settings-btn"),
}

// ─── Shared mutable state (must be declared before setInterval / event handlers)

let _autoApprove = false
let _taskStatus = null
let _taskProgress = null
let _lastUsage = null
let _lastCtxPct = null
let _planActive = false
let _subagentMap = {}
let _goalInfo = null
// Current live-turn advisor block (in-conversation details element) — advisor
// output streams here like reasoning instead of the side tool panel.
let _advisorBlock = null
// Subagent/consultant activity-stream blocks (reset per turn together with _advisorBlock).
const _subBlocks = new Map()
// Lazy history loading: _hasOlder = more pages exist before the first rendered
// message; _loadingOlder guards against scroll-triggered double requests.
let _hasOlder = false
let _loadingOlder = false
// First-run onboarding: shown when no provider is configured; dismissed on skip
// (stays dismissed for the webview's lifetime, reappears after a reload).
let _welcomeDismissed = false
let _lastProviderStatus = {} // cached for re-opening the welcome panel on needsSetup errors
// Panel preview caps (PANEL_PREVIEW_CHARS / PANEL_BLOCK_MAX retired with the
// side tool panel — output now renders inline in the tool card / advisor block)
let _currentTool = null  // name of the tool currently executing (CLI status parity)
let _llmCalls = 0        // LLM calls this turn (CLI turn-count parity)
let _turnStart = null    // ms timestamp of the current turn (elapsed parity)
// Interrupt mode (Ctrl+I, CLI parity): the input box switches to "inject a
// message" — Enter aborts the turn and injects it, Esc cancels.
let _interruptMode = false

// ─── Init ──────────────────────────────────────

showWelcome(ctx)

ctx.sendBtn.addEventListener("click", send)
ctx.abortBtn.addEventListener("click", () => vscode.postMessage({ type: "abort" }))

// ─── Interrupt mode (Ctrl+I inject, CLI parity) ──
let _savedPlaceholder = ""
function enterInterruptMode() {
  _interruptMode = true
  _savedPlaceholder = ctx.inputEl.placeholder
  ctx.inputEl.placeholder = t("input.interruptPlaceholder")
  ctx.inputEl.classList.add("interrupt-mode")
  ctx.inputEl.focus()
}
function exitInterruptMode() {
  _interruptMode = false
  ctx.inputEl.placeholder = _savedPlaceholder
  ctx.inputEl.classList.remove("interrupt-mode")
  ctx.inputEl.value = ""
  ctx.inputEl.style.height = "auto"
}

// ─── In-conversation search (Ctrl+F, CLI parity) ──

let _searchMatches = []  // live mark.search-hit elements
let _searchIndex = 0

function clearSearchHighlights() {
  for (const mark of ctx.messagesEl.querySelectorAll("mark.search-hit")) {
    const parent = mark.parentNode
    parent.replaceChild(document.createTextNode(mark.textContent), mark)
    parent.normalize() // merge adjacent text nodes back
  }
  _searchMatches = []
}

function highlightTextNode(node, q) {
  const text = node.nodeValue
  const lower = text.toLowerCase()
  const frag = document.createDocumentFragment()
  let i = 0
  let idx
  while ((idx = lower.indexOf(q, i)) !== -1) {
    if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)))
    const mark = document.createElement("mark")
    mark.className = "search-hit"
    mark.textContent = text.slice(idx, idx + q.length)
    frag.appendChild(mark)
    i = idx + q.length
  }
  if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)))
  node.parentNode.replaceChild(frag, node)
}

function performSearch(query) {
  clearSearchHighlights()
  if (!query) { updateSearchCount(); return }
  const q = query.toLowerCase()
  const NF = window.NodeFilter
  const walker = document.createTreeWalker(ctx.messagesEl, NF.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node.parentElement?.closest("#search-bar")) return NF.FILTER_REJECT
      return node.nodeValue.toLowerCase().includes(q) ? NF.FILTER_ACCEPT : NF.FILTER_REJECT
    },
  })
  const nodes = []
  let n
  while ((n = walker.nextNode())) nodes.push(n)
  for (const node of nodes) highlightTextNode(node, q)
  _searchMatches = [...ctx.messagesEl.querySelectorAll("mark.search-hit")]
  _searchIndex = _searchMatches.length ? Math.min(_searchIndex, _searchMatches.length - 1) : 0
  updateSearchCount()
  if (_searchMatches.length) showCurrentMatch()
}

function showCurrentMatch() {
  _searchMatches.forEach((m, i) => m.classList.toggle("current", i === _searchIndex))
  _searchMatches[_searchIndex]?.scrollIntoView({ block: "center" })
}

function updateSearchCount() {
  const el = document.getElementById("search-count")
  if (el) el.textContent = _searchMatches.length ? `${_searchIndex + 1}/${_searchMatches.length}` : t("search.noMatch")
}

function jumpSearch(dir) {
  if (!_searchMatches.length) return
  _searchIndex = (_searchIndex + dir + _searchMatches.length) % _searchMatches.length
  showCurrentMatch()
  updateSearchCount()
}

function ensureSearchBar() {
  let bar = document.getElementById("search-bar")
  if (bar) return bar
  bar = document.createElement("div")
  bar.id = "search-bar"
  bar.style.display = "none"
  bar.innerHTML =
    `<input id="search-input" type="text" placeholder="${t("search.placeholder")}" aria-label="${t("search.placeholder")}">` +
    `<span id="search-count" role="status" aria-live="polite"></span>` +
    `<button id="search-prev" title="${t("search.prev")}" aria-label="${t("search.prev")}">↑</button>` +
    `<button id="search-next" title="${t("search.next")}" aria-label="${t("search.next")}">↓</button>` +
    `<button id="search-close" title="${t("search.close")}" aria-label="${t("search.close")}">✕</button>`
  const toolbar = document.getElementById("toolbar")
  toolbar.parentNode.insertBefore(bar, toolbar)
  const input = bar.querySelector("#search-input")
  input.addEventListener("input", () => performSearch(input.value.trim()))
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); jumpSearch(e.shiftKey ? -1 : 1) }
    else if (e.key === "Escape") closeSearch()
    else if (e.key === "ArrowDown") { e.preventDefault(); jumpSearch(1) }
    else if (e.key === "ArrowUp") { e.preventDefault(); jumpSearch(-1) }
  })
  bar.querySelector("#search-next").addEventListener("click", () => jumpSearch(1))
  bar.querySelector("#search-prev").addEventListener("click", () => jumpSearch(-1))
  bar.querySelector("#search-close").addEventListener("click", closeSearch)
  return bar
}

function openSearch() {
  const bar = ensureSearchBar()
  bar.style.display = "flex"
  bar.querySelector("#search-input").focus()
}

function closeSearch() {
  const bar = document.getElementById("search-bar")
  if (bar) bar.style.display = "none"
  clearSearchHighlights()
  ctx.inputEl.focus()
}

// Ctrl+F opens in-conversation search (webview's native find does nothing here).
document.addEventListener("keydown", (e) => {
  if (e.key === "f" && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault()
    openSearch()
  }
})

// Clickable file paths in tool cards — click / Enter opens the file in the editor.
ctx.messagesEl.addEventListener("click", (e) => {
  const link = e.target.closest(".file-link")
  if (link) vscode.postMessage({ type: "openFile", path: link.dataset.path, line: link.dataset.line ? Number(link.dataset.line) : undefined })
})
ctx.messagesEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return
  const link = e.target.closest(".file-link")
  if (link) { e.preventDefault(); link.click() }
})


ctx.inputEl.addEventListener("keydown", (e) => {
  // Interrupt mode swallows keys: Enter injects the message, Esc cancels.
  if (_interruptMode) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      const msg = ctx.inputEl.value.trim()
      exitInterruptMode()
      if (msg) vscode.postMessage({ type: "interrupt", message: msg })
    } else if (e.key === "Escape") {
      exitInterruptMode()
    }
    return
  }
  // Ctrl+C with NO selection while running → Stop (CLI parity). A selection
  // still copies (default browser behavior).
  if (e.key === "c" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
    const hasSelection = ctx.inputEl.selectionStart !== ctx.inputEl.selectionEnd
    if (!hasSelection && ctx.isRunning) {
      e.preventDefault()
      vscode.postMessage({ type: "abort" })
    }
    return
  }
  // Ctrl+I while running → interrupt + inject (CLI parity)
  if (e.key === "i" && e.ctrlKey && !e.altKey && !e.metaKey && ctx.isRunning) {
    e.preventDefault()
    enterInterruptMode()
    return
  }
  // Ctrl+U clears the input line (CLI parity)
  if (e.key === "u" && e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault()
    ctx.inputEl.value = ""
    ctx.inputEl.style.height = "auto"
    return
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() }
  // Input history navigation (CLI parity): ↑ on the first line recalls previous
  // inputs; ↓ walks back down; the in-progress draft is stashed and restored.
  else if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey &&
           ctx.inputEl.selectionStart === 0 && !isAtDropdownOpen()) {
    e.preventDefault()
    navigateInputHistory(-1)
  } else if (e.key === "ArrowDown" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey &&
           ctx.inputEl.selectionStart === ctx.inputEl.value.length && !isAtDropdownOpen()) {
    e.preventDefault()
    navigateInputHistory(1)
  }
})
ctx.inputEl.addEventListener("input", () => {
  ctx.inputEl.style.height = "auto"
  ctx.inputEl.style.height = Math.min(ctx.inputEl.scrollHeight, 150) + "px"
})

// ─── @-autocomplete & image paste ──────────────

const _ac = initAutocomplete({
  inputEl: ctx.inputEl,
  atDropdown: document.getElementById("at-dropdown"),
  vscode,
  pastedImages: ctx._pastedImages,
})
const { showAtDropdown } = _ac

// ─── Settings panel (init early so openSettings is available for toolbar binding) ──
const _settings = initSettings({ onClose: () => ctx.inputEl.focus(), getModels: () => ctx._models })
const { openSettings, closeSettings, renderMcpList, updateMcpTools, updateProviderStatus, updateIndexStatus, updateAgentSettings, updateWebsearchSettings, updateTestProviderResult, updateShellCandidates, updateProxySettings, updateProxyTestResult, showSettingsError } = _settings

// ─── Session bar ───────────────────────────────

// Auto-clean panel entries (done subagents after 3s, tool panels after 10s)
// Panel cleanup interval. The webview has no teardown path today (it lives for
// the panel's lifetime and dies with it), but the ID is captured so a future
// dispose/visibility-hidden handler can clear it.
const _panelTimer = setInterval(autoCleanPanels, 2000)
// Webview lifetime == panel lifetime, but clear on unload so a future
// teardown/dispose path cannot leak the interval.
window.addEventListener("unload", () => clearInterval(_panelTimer))

document.getElementById("new-session-btn").addEventListener("click", () => vscode.postMessage({ type: "newSession" }))

ctx.sessionSelector.addEventListener("click", (e) => {
  e.stopPropagation()
  const open = ctx.sessionDropdown.style.display !== "none"
  ctx.sessionDropdown.style.display = open ? "none" : "block"
  ctx.sessionSelector.setAttribute("aria-expanded", String(!open))
  if (!open) buildSessionDropdown()
})

ctx.sessionSelector.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    ctx.sessionSelector.click()
  }
})

ctx.sessionDropdown.addEventListener("click", (e) => {
  e.stopPropagation() // prevent closing when clicking inside dropdown
})

function buildSessionDropdown() {
  ctx.sessionDropdown.innerHTML = ""
  for (const s of ctx._sessions) {
    const item = document.createElement("div")
    item.className = "session-item"
    item.tabIndex = 0
    item.setAttribute("role", "option")
    item.setAttribute("aria-selected", String(!!s.active))
    if (s.active) item.classList.add("active")
    item.innerHTML = `<span class="session-item-title">${escHtml(s.title)}</span>
      <span class="session-item-meta">${s.provider ? escHtml(s.provider) + " · " : ""}${s.count}msgs${s.updated ? " · " + fmtDate(s.updated) : ""}</span>`
    if (ctx._sessions.length > 1) {
      item.innerHTML += `<button class="session-delete" title="${t("session.delete")}" aria-label="${t("session.delete")} ${escHtml(s.title)}">✕</button>`
    }
    item.addEventListener("click", (e) => {
      if (e.target.closest(".session-delete")) return
      vscode.postMessage({ type: "switchSession", slot: s.slot })
      ctx.sessionDropdown.style.display = "none"
    })
    const delBtn = item.querySelector(".session-delete")
    if (delBtn) delBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      // Deleting a whole session is irreversible — inline confirmation (a native
      // window.confirm does not work inside the webview sandbox).
      showSessionDeleteConfirm(s.slot, s.title)
    })
    ctx.sessionDropdown.appendChild(item)
  }
  if (ctx._sessions.length === 0) {
    const empty = document.createElement("div")
    empty.className = "session-item"
    empty.textContent = t("session.empty")
    empty.style.opacity = "0.5"
    ctx.sessionDropdown.appendChild(empty)
  }
}

/** Inline confirmation popover for session deletion (reuses the AUTO popover style). */
function showSessionDeleteConfirm(slot, title) {
  document.querySelector(".auto-confirm")?.remove()
  document.querySelector(".auto-backdrop")?.remove()

  const backdrop = document.createElement("div")
  backdrop.className = "auto-backdrop"
  backdrop.addEventListener("click", () => {
    backdrop.remove()
    document.querySelector(".auto-confirm")?.remove()
  })

  const popover = document.createElement("div")
  popover.className = "auto-confirm"
  popover.setAttribute("role", "alertdialog")
  popover.setAttribute("aria-label", t("session.delete"))
  // escHtml the title BEFORE interpolation — it lands inside innerHTML.
  popover.innerHTML = `<div class="auto-confirm-text">${t("session.deleteConfirm", { title: escHtml(title) })}</div>
    <div class="auto-confirm-actions">
      <button class="auto-confirm-yes" aria-label="${t("session.delete")}">${t("session.delete")}</button>
      <button class="auto-confirm-no" aria-label="${t("question.cancel")}">${t("question.cancel")}</button>
    </div>`

  document.body.appendChild(backdrop)
  document.body.appendChild(popover)
  setTimeout(() => popover.querySelector(".auto-confirm-no")?.focus(), 50) // safer default

  const close = () => { popover.remove(); backdrop.remove() }
  popover.querySelector(".auto-confirm-yes").addEventListener("click", () => {
    close()
    vscode.postMessage({ type: "deleteSession", slot })
  })
  popover.querySelector(".auto-confirm-no").addEventListener("click", close)
}

function updateSessionTitle() {
  const active = ctx._sessions.find((s) => s.active)
  ctx.sessionTitle.textContent = active ? active.title : t("session.title")
}

function fmtDate(ts) {
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

function renderTaskPanel() {
  const panel = document.getElementById("task-panel")
  if (!_taskProgress || !_taskProgress.items || _taskProgress.items.length === 0) {
    panel.style.display = "none"
    return
  }
  const allDone = _taskProgress.items.every((item) => item.status === "done")
  if (allDone && panel.style.display !== "block") {
    // Don't show — badge already says ✓N/N, no need for the panel
    return
  }
  const icons = { pending: "○", in_progress: "◉", done: "✓" }
  panel.innerHTML = `<div class="panel-desc">${t("panel.taskDesc") || "Tracks multi-step work — created and updated by the agent"}</div>` +
    _taskProgress.items.map((item) =>
    `<div class="task-item">
      <span class="task-mark">${icons[item.status] || " "}</span>
      <span class="task-title">${escHtml(item.title)}</span>
      <span class="task-status">${item.status === "in_progress" ? t("task.in_progress") : item.status}</span>
    </div>`
  ).join("")
  panel.style.display = "block"
}

function renderSubagentPanel() {
  const panel = document.getElementById("subagent-panel")
  const subs = Object.values(_subagentMap)
  if (subs.length === 0) { panel.style.display = "none"; return }
  const consults = subs.filter((s) => s.role === "consult")
  const consultProgress = consults.length > 0
    ? ` · 👥 ${consults.filter((s) => s.status === "answered").length}/${consults.length} ${t("consult.answered")}`
    : ""
  panel.innerHTML = `<div class="panel-desc">${t("panel.subDesc") || "Background sub-tasks — explore, plan, or implement independently"}${consultProgress}</div>` +
    subs.map((s) => {
    // Consult states get their own colors + labels (answered was rendering as red "error")
    const statusCls = s.status === "started" ? "started"
      : (s.status === "done" || s.status === "answered") ? "done"
      : s.status === "terminated" ? "terminated"
      : "error"
    const statusText = s.status === "started" ? t("sub.running")
      : s.status === "answered" ? t("consult.answered")
      : s.status === "terminated" ? t("consult.terminated")
      : s.status === "failed" ? t("consult.failed")
      : s.status
    // Rows with a model tag (consult, escalate) show it so parallel consultants and
    // the flown-in escalate are distinguishable (three-way review 2026-08-16 — surgeon
    // rows rendered as a bare "surgeon" even though the event carries the model).
    const label = s.model ? `${s.role} · ${s.model}` : s.role
    // answered consults carry a collapsible preview of the reply (review D10)
    const preview = s.role === "consult" && s.replyPreview
      ? `<details class="consult-reply"><summary>${t("consult.replyPreview") || "view reply"}</summary><pre>${escHtml(s.replyPreview)}</pre></details>`
      : ""
    return `<div class="sub-item">
      <span class="sub-role">${escHtml(label)}</span>
      <span class="sub-tool">${s.tool ? escHtml(s.tool) : ""}</span>
      <span class="sub-status ${statusCls}">${statusText}</span>
      ${preview}
    </div>`
  }).join("")
  panel.style.display = "block"
}

function renderGoalPanel() {
  const panel = document.getElementById("goal-panel")
  if (!_goalInfo) { panel.style.display = "none"; return }
  const g = _goalInfo
  const statusCls = g.status === "active" ? "active" : g.status === "done" ? "done" : "cancelled"
  panel.innerHTML = `<div class="panel-desc">${t("panel.goalDesc") || "Long-running objective — runs until complete or cancelled"}</div>
    <div class="goal-section">
    <div class="goal-label">${t("goal.objective")}</div>
    <div class="goal-value">${escHtml(g.objective || "")}</div>
  </div>
  <div class="goal-section">
    <div class="goal-label">${t("goal.criteria")}</div>
    <div class="goal-value">${escHtml(g.criteria || "—")}</div>
  </div>
  <span class="goal-status-badge ${statusCls}">${g.status}</span>`
  panel.style.display = "block"
}

function clearPanels() {
  _subagentMap = {}
  _goalInfo = null
  _taskProgress = null
  _taskStatus = null
  document.getElementById("subagent-panel").style.display = "none"
  document.getElementById("goal-panel").style.display = "none"
  document.getElementById("task-panel").style.display = "none"
}

function autoCleanPanels() {
  // Remove finished subagents/consultants after a short linger
  const now = Date.now()
  for (const [id, s] of Object.entries(_subagentMap)) {
    // consult cards linger 60s — the answered reply preview is the consultation's core
    // output; 3s (plain subagents) would delete it before the user looks up.
    const linger = s.role === "consult" ? 60000 : 3000
    const lingerErr = s.role === "consult" ? 60000 : 5000
    if ((s.status === "done" || s.status === "answered" || s.status === "terminated") && s.doneAt && now - s.doneAt > linger) delete _subagentMap[id]
    if ((s.status === "error" || s.status === "failed") && s.doneAt && now - s.doneAt > lingerErr) delete _subagentMap[id]
  }
  renderSubagentPanel()
  // Refresh elapsed seconds while a turn is running (CLI 1s ticker parity)
  if (_turnStart) renderStatusBar()
}

function renderStatusBar(m) {
  // m is optional — if not passed, uses cached state from _lastUsage
  const u = m ? (m.usage || {}) : (_lastUsage || {})
  const prompt = u.prompt_tokens ?? 0
  const completion = u.completion_tokens ?? 0
  const cacheHit = u.prompt_cache_hit_tokens ?? 0
  const cacheMiss = u.prompt_cache_miss_tokens ?? 0
  const cachePct = cacheHit + cacheMiss > 0 ? Math.round((cacheHit / (cacheHit + cacheMiss)) * 100) : null
  let parts = []
  if (_planActive) parts.push(`<span style="color:var(--accent)">${t("status.plan")}</span>`)
  if (_goalInfo?.status === "active") parts.push(`<span id="goal-badge" role="button" tabindex="0" aria-label="Goal panel" style="cursor:pointer">🎯</span>`)
  parts.push(`↑${fmtK(prompt)} ↓${fmtK(completion)}`)
  if (cachePct !== null) parts.push(`hit${cachePct}%`)
  const ctxPct = (m && m.ctxPct != null) ? m.ctxPct : _lastCtxPct
  if (ctxPct != null) {
    // CLI parity: context utilization ≥80% renders in warning color
    parts.push(ctxPct >= 80
      ? `<span style="color:var(--vscode-editorWarning-foreground, #cca700)">context ${ctxPct}%</span>`
      : `context ${ctxPct}%`)
  }
  // CLI status parity: current tool, turn count (LLM calls), elapsed seconds
  if (_currentTool) parts.push(`<span class="status-tool">${t("status.currentTool")}: ${escHtml(_currentTool)}</span>`)
  if (_llmCalls > 0) parts.push(`${t("status.turns")} ${_llmCalls}`)
  if (_turnStart) parts.push(`${t("status.elapsed")} ${Math.round((Date.now() - _turnStart) / 1000)}s`)
  const subCount = Object.keys(_subagentMap).length
  if (subCount > 0) parts.push(`<span id="sub-badge" role="button" tabindex="0" aria-label="${subCount} subagents" style="cursor:pointer">sub:${subCount}</span>`)
  if (_taskStatus) parts.push(`<span id="task-badge" role="button" tabindex="0" aria-label="Task progress" style="cursor:pointer">${_taskStatus}</span>`)
  document.getElementById("status-line").innerHTML = parts.join(` <span class="status-sep">|</span> `)
  // Wire click handlers for all three badges — `onclick` (not addEventListener):
  // the status line is rebuilt by innerHTML on every render, so old elements
  // (and their listeners) are discarded; onclick overwrites rather than stacks.
  const wire = (id, panelId) => {
    const el = document.getElementById(id)
    if (el) el.onclick = (e) => {
      e.stopPropagation()
      const p = document.getElementById(panelId)
      p.style.display = p.style.display === "none" ? "block" : "none"
    }
  }
  wire("task-badge", "task-panel")
  wire("sub-badge", "subagent-panel")
  wire("goal-badge", "goal-panel")
}

// ─── Toolbar buttons ───────────────────────────

document.getElementById("settings-btn").addEventListener("click", openSettings)

// ─── First-run onboarding panel ─────────────────

/** Show the onboarding panel, pre-filled with the unadded provider presets. */
function showWelcomePanel(status) {
  if (_welcomeDismissed) return
  const presets = (status?.presets || []).map((p) => ({ name: p.name, label: p.desc || p.name, model: p.model }))
  const sel = ctx.welcomeProvider
  sel.innerHTML = presets
    .map((p) => `<option value="${escHtml(p.name)}">${escHtml(p.label)} — ${escHtml(p.model)}</option>`)
    .join("") + `<option value="custom">${escHtml(t("settings.customChoice"))}</option>`
  ctx.welcomeHeading.textContent = t("welcome.heading")
  ctx.welcomeText.textContent = t("welcome.text")
  ctx.welcomeProviderLabel.textContent = t("settings.providersSection")
  ctx.welcomeKeyLabel.textContent = t("settings.providerKey")
  ctx.welcomeSaveBtn.textContent = t("welcome.save")
  ctx.welcomeSkipBtn.textContent = t("welcome.skip")
  ctx.welcomeSettingsBtn.textContent = t("welcome.fullSettings")
  ctx.welcomeKey.value = ""
  ctx.welcomePanel.style.display = "flex"
  ctx.welcomePanel.setAttribute("aria-hidden", "false")
}

function hideWelcomePanel() {
  ctx.welcomePanel.style.display = "none"
  ctx.welcomePanel.setAttribute("aria-hidden", "true")
}

/** providerStatus-driven: show onboarding when NOTHING is configured; close it once a key lands. */
function maybeShowWelcome(status, keyOk) {
  if (keyOk) {
    hideWelcomePanel()
    return
  }
  showWelcomePanel(status)
}

ctx.welcomeSaveBtn.addEventListener("click", () => {
  const name = ctx.welcomeProvider.value
  const key = ctx.welcomeKey.value.trim()
  if (!key) { ctx.welcomeKey.focus(); return }
  if (name === "custom") {
    // Custom providers need more fields — hand off to the settings panel's add form.
    hideWelcomePanel()
    openSettings()
    window._toggleAddForm?.(true)
    return
  }
  vscode.postMessage({ type: "addProvider", preset: name, key })
  // The panel closes itself when the refreshed providerStatus reports keyOk=true.
})

ctx.welcomeSkipBtn.addEventListener("click", () => {
  _welcomeDismissed = true
  hideWelcomePanel()
})

ctx.welcomeSettingsBtn.addEventListener("click", () => {
  hideWelcomePanel()
  openSettings()
})

ctx.welcomeKey.addEventListener("keydown", (e) => {
  if (e.key === "Enter") ctx.welcomeSaveBtn.click()
})

// Advisor / Engineering / Plan mode toggles (session-bar quick switches; the settings
// panel has the full advisor configuration — these mirror config.json fields).
let _advisorOn = false
let _engOn = false

const advisorBtn = document.getElementById("advisor-btn")
const engBtn = document.getElementById("eng-btn")
const planBtn = document.getElementById("plan-btn")

function applyModeButtons() {
  advisorBtn.classList.toggle("active", _advisorOn)
  advisorBtn.classList.toggle("warning", _advisorOn)
  engBtn.classList.toggle("active", _engOn)
  engBtn.classList.toggle("warning", _engOn)
  planBtn.classList.toggle("active", _planActive)
  planBtn.classList.toggle("warning", _planActive)
}

advisorBtn.addEventListener("click", () => {
  _advisorOn = !_advisorOn
  applyModeButtons()
  vscode.postMessage({ type: "setAdvisorEnabled", value: _advisorOn })
})
engBtn.addEventListener("click", () => {
  _engOn = !_engOn
  applyModeButtons()
  vscode.postMessage({ type: "setEngineeringEnabled", value: _engOn })
})
planBtn.addEventListener("click", () => {
  _planActive = !_planActive
  applyModeButtons()
  vscode.postMessage({ type: "setPlanMode", value: _planActive })
})

const autoBtn = document.getElementById("auto-btn")
autoBtn.addEventListener("click", () => {
  if (!_autoApprove) {
    // Show inline confirmation instead of blocked confirm()
    showAutoConfirm()
    return
  }
  // Turning OFF — no confirmation needed
  _autoApprove = false
  autoBtn.classList.remove("active", "warning")
  autoBtn.textContent = "AUTO"
  vscode.postMessage({ type: "setAutoApprove", value: false })
})

function showAutoConfirm() {
  const existing = document.querySelector(".auto-confirm")
  if (existing) existing.remove()
  // A stale backdrop from a previous invocation would block clicks on the UI.
  document.querySelector(".auto-backdrop")?.remove()

  const backdrop = document.createElement("div")
  backdrop.className = "auto-backdrop"
  backdrop.addEventListener("click", () => {
    backdrop.remove()
    document.querySelector(".auto-confirm")?.remove()
    ctx.inputEl.focus()
  })

  const popover = document.createElement("div")
  popover.className = "auto-confirm"
  popover.setAttribute("role", "alertdialog")
  popover.setAttribute("aria-label", t("toolbar.autoApprove"))
  popover.innerHTML = `<div class="auto-confirm-text">${t("auto.confirmText")}</div>
    <div class="auto-confirm-actions">
      <button class="auto-confirm-yes" aria-label="${t("auto.enable")}">${t("auto.enable")}</button>
      <button class="auto-confirm-no" aria-label="${t("auto.cancel")}">${t("auto.cancel")}</button>
    </div>`

  document.body.appendChild(backdrop)
  document.body.appendChild(popover)
  // Focus the cancel button (safer default)
  setTimeout(() => popover.querySelector(".auto-confirm-no")?.focus(), 50)

  const close = () => { popover.remove(); backdrop.remove(); ctx.inputEl.focus() }
  popover.querySelector(".auto-confirm-yes").addEventListener("click", () => {
    close()
    _autoApprove = true
    autoBtn.classList.add("active", "warning")
    autoBtn.textContent = "⚠ AUTO"
    vscode.postMessage({ type: "setAutoApprove", value: true })
  })
  popover.querySelector(".auto-confirm-no").addEventListener("click", close)
}
ctx.modelBtn.addEventListener("click", (e) => {
    e.stopPropagation()
    openModelMenu({
      anchorEl: ctx.modelBtn,
      models: ctx._models,
      value: { provider: ctx.selectedProvider, model: ctx.selectedModel },
      onPick: ({ provider, model }) => {
        const m = ctx._models.find((x) => x.id === model && (x.provider || "") === provider)
        if (m) selectModel(m)
      },
      footer: [
        { label: t("model.addProvider"), onClick: () => vscode.postMessage({ type: "addProvider" }) },
        { label: t("model.removeProvider"), onClick: () => vscode.postMessage({ type: "removeProvider" }) },
        { label: t("model.setKey"), onClick: () => vscode.postMessage({ type: "setKey" }) },
      ],
      up: true,
    })
  })
ctx.reasoningBtn.addEventListener("click", () => toggleDropdown(ctx.reasoningDropdown, () => buildReasoningDropdown()))

// ─── Model selector ────────────────────────────

function buildReasoningDropdown() {
  ctx.reasoningDropdown.innerHTML = ""
  const model = ctx._models.find((m) => m.id === ctx.selectedModel)
  const levels = model?.reasoning || []
  if (levels.length === 0) {
    ctx.reasoningDropdown.appendChild(sectionEl(t("model.noReasoning")))
    const item = document.createElement("div")
    item.className = "dropdown-item"
    item.innerHTML = "<span>" + t("model.noReasoningDesc") + "</span>"
    item.style.opacity = "0.5"
    ctx.reasoningDropdown.appendChild(item)
    return
  }
  ctx.reasoningDropdown.appendChild(sectionEl(t("model.reasoning")))
  for (const level of levels) {
    const item = document.createElement("div")
    item.className = "dropdown-item"
    item.tabIndex = 0
    item.setAttribute("role", "option")
    item.setAttribute("aria-selected", String(level === ctx.selectedReasoning))
    const label = reasoningLabel(level)
    item.innerHTML = `<span>${label}</span>${level === ctx.selectedReasoning ? '<span class="check">✓</span>' : ""}`
    item.addEventListener("click", () => {
      ctx.selectedReasoning = level
      ctx.reasoningBtn.textContent = level === "none" ? "off" : label
      ctx.reasoningBtn.classList.toggle("active", level !== "none")
      ctx.reasoningDropdown.style.display = "none"
      vscode.postMessage({ type: "selectReasoning", reasoning: level })
    })
    ctx.reasoningDropdown.appendChild(item)
  }
}

function sectionEl(text) {
  const s = document.createElement("div")
  s.className = "dropdown-section"
  s.textContent = text
  return s
}

function selectModel(m) {
  ctx.selectedModel = m.id; ctx.selectedProvider = m.provider || ""
  ctx.modelBtn.textContent = m.id; closeModelMenu()
  vscode.postMessage({ type: "selectModel", model: m.id, provider: m.provider || "" })
  const levels = m.reasoning || []
  if (levels.length > 0 && !levels.includes(ctx.selectedReasoning)) ctx.selectedReasoning = levels[0]
  const visible = levels.length > 0 ? ctx.selectedReasoning : "off"
  ctx.reasoningBtn.textContent = visible === "none" ? "off" : (reasoningLabel(visible))
  ctx.reasoningBtn.classList.toggle("active", levels.length > 0 && visible !== "off")
}

function toggleDropdown(el, build) {
  const open = el.style.display !== "none"
  // Close all dropdowns first
  closeModelMenu()
  ctx.reasoningDropdown.style.display = "none"
  ctx.sessionDropdown.style.display = "none"
  if (ctx.sessionSelector) ctx.sessionSelector.setAttribute("aria-expanded", "false")
  el.style.display = open ? "none" : "block"
  if (!open) build()
  // Update aria-expanded on the trigger button
  if (el === ctx.reasoningDropdown) ctx.reasoningBtn.setAttribute("aria-expanded", String(!open))
}

// Close all dropdowns on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeModelMenu()
    ctx.reasoningDropdown.style.display = "none"
    ctx.sessionDropdown.style.display = "none"
    if (ctx.sessionSelector) ctx.sessionSelector.setAttribute("aria-expanded", "false")
    if (document.getElementById("settings-panel").style.display !== "none") {
      closeSettings()
      ctx.inputEl.focus()
    }
    const autoConfirm = document.querySelector(".auto-confirm")
    if (autoConfirm) { autoConfirm.remove(); document.querySelector(".auto-backdrop")?.remove(); ctx.inputEl.focus() }
  }
})

// Enter/Space activates focused custom elements
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT" || e.target.tagName === "BUTTON") return
  if (e.target.closest("#input")) return
  e.preventDefault()
  e.target.click()
})

document.addEventListener("click", (e) => {
  // model menu is overlay-managed (self-closing); no legacy dropdown containment needed
  if (!ctx.reasoningDropdown.contains(e.target) && e.target !== ctx.reasoningBtn) ctx.reasoningDropdown.style.display = "none"
  if (!ctx.sessionDropdown.contains(e.target) && !ctx.sessionSelector.contains(e.target)) {
    ctx.sessionDropdown.style.display = "none"
    ctx.sessionSelector.setAttribute("aria-expanded", "false")
  }
})

// ─── apply_patch approval preview ────────────────

/**
 * Render a raw unified diff (apply_patch approval preview) with +/- coloring.
 * Hunk headers (@@, diff --git, ---/+++) stay neutral; only content lines colored.
 */
function renderPatch(patch) {
  const lines = String(patch || "").split("\n").map((l) => ({ type: patchLineType(l), text: l }))
  return renderDiff(lines)
}

// ─── Scroll-to-bottom button ─────────────────────
// Lazy history made scrolling back a long trip — a floating button returns to
// the latest message in one click. Positioned just above the toolbar.

initScrollFollow(ctx)

const scrollBottomBtn = document.createElement("button")
scrollBottomBtn.id = "scroll-bottom-btn"
scrollBottomBtn.className = "scroll-bottom-btn"
scrollBottomBtn.type = "button"
scrollBottomBtn.title = t("msg.scrollBottom")
scrollBottomBtn.textContent = "↓"
scrollBottomBtn.addEventListener("click", () => scrollDown(ctx))
document.getElementById("chat-container").appendChild(scrollBottomBtn)

function positionScrollBottomBtn() {
  const tb = document.getElementById("toolbar")
  scrollBottomBtn.style.bottom = (tb ? tb.offsetHeight : 150) + 10 + "px"
}
positionScrollBottomBtn()
window.addEventListener("resize", positionScrollBottomBtn)

function updateScrollBottomVisibility() {
  const el = ctx.messagesEl
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  const scrollable = el.scrollHeight > el.clientHeight + 40
  scrollBottomBtn.classList.toggle("visible", scrollable && !nearBottom)
}

// ─── Lazy history loading ───────────────────────

/** Earliest loaded global history idx (from data-idx buttons), or null if none. */
function minLoadedIdx(ctx) {
  let min = Infinity
  for (const el of ctx.messagesEl.querySelectorAll("[data-idx]")) {
    const v = Number(el.dataset.idx)
    if (Number.isFinite(v) && v < min) min = v
  }
  return min === Infinity ? null : min
}

function showLoadOlderIndicator(ctx) {
  if (document.getElementById("load-older-indicator")) return
  const el = document.createElement("div")
  el.id = "load-older-indicator"
  el.className = "load-older-indicator"
  el.textContent = t("msg.loadingOlder")
  const anchor = ctx.messagesEl.querySelector(".message, .tool-call")
  ctx.messagesEl.insertBefore(el, anchor)
}

function removeLoadOlderIndicator(ctx) {
  ctx.messagesEl.querySelector("#load-older-indicator")?.remove()
}

/**
 * Render a historyPage payload ({ messages, hasOlder, older }). `older` pages are
 * prepended ABOVE the earliest rendered message with the scroll position
 * compensated (the newly loaded content must not shove the viewport down);
 * the first paint page is appended and scrolled to the bottom.
 */
function applyHistoryPage(ctx, m) {
  const frag = document.createDocumentFragment()
  for (const msg of m.messages || []) {
    const el = buildHistoryMessage(ctx, msg)
    if (!el) continue
    if (msg.kind === "assistant") attachCopyButtons(el) // code-block copy buttons only
    frag.appendChild(el)
  }
  const anchor = ctx.messagesEl.querySelector(".message, .tool-call")
  if (m.older) {
    const prevTop = ctx.messagesEl.scrollTop
    const prevHeight = ctx.messagesEl.scrollHeight
    ctx.messagesEl.insertBefore(frag, anchor)
    ctx.messagesEl.scrollTop = prevTop + (ctx.messagesEl.scrollHeight - prevHeight)
  } else {
    ctx.messagesEl.insertBefore(frag, anchor)
    scrollDown(ctx)
  }
  _hasOlder = !!m.hasOlder
  _loadingOlder = false
  removeLoadOlderIndicator(ctx)
}

/**
 * Render an inline question prompt (question tool) INSIDE the chat panel —
 * not VS Code's native popup at the window top. Options → button list; free
 * text → input + submit. Cancel always available (answer null = cancelled).
 */
function showQuestion(ctx, question, options) {
  const el = document.createElement("div")
  el.className = "question-card"
  el.setAttribute("role", "alert")
  el.setAttribute("aria-label", t("question.label"))

  const textEl = document.createElement("div")
  textEl.className = "question-text"
  textEl.innerHTML = `<span class="question-mark">${escHtml(t("question.mark"))}</span> ${escHtml(question)}`
  el.appendChild(textEl)

  const actions = document.createElement("div")
  actions.className = "question-actions"
  el.appendChild(actions)

  const answer = (value) => {
    el.remove()
    vscode.postMessage({ type: "questionResponse", answer: value ?? null })
    ctx.inputEl.focus()
  }

  // Free-text channel — ALWAYS present (options or not). Users must be able to
  // supplement or correct the AI's preset choices with their own answer.
  const addFreeInput = (placeholder) => {
    const input = document.createElement("input")
    input.className = "question-input"
    input.type = "text"
    input.placeholder = placeholder
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) answer(input.value.trim())
    })
    actions.appendChild(input)
    const submit = document.createElement("button")
    submit.className = "perm-btn approve"
    submit.textContent = t("question.submit")
    submit.addEventListener("click", () => { if (input.value.trim()) answer(input.value.trim()) })
    actions.appendChild(submit)
  }

  if (Array.isArray(options) && options.length > 0) {
    for (const opt of options) {
      const b = document.createElement("button")
      b.className = "perm-btn approve question-option"
      b.textContent = opt
      b.addEventListener("click", () => answer(opt))
      actions.appendChild(b)
    }
    // Preset options PLUS a free-text input — the user can pick a preset or
    // type their own answer (the AI's options are never assumed exhaustive).
    addFreeInput(t("question.customPlaceholder"))
  } else {
    addFreeInput(t("question.placeholder"))
  }

  const cancel = document.createElement("button")
  cancel.className = "perm-btn deny"
  cancel.textContent = t("question.cancel")
  cancel.addEventListener("click", () => answer(null))
  actions.appendChild(cancel)

  ctx.messagesEl.appendChild(el)
  el.scrollIntoView({ behavior: "smooth", block: "nearest" })
  const input = el.querySelector(".question-input")
  if (input) setTimeout(() => input.focus(), 50)
}

// Scroll-back trigger: near the top → fetch the next older page (guarded against
// double requests; _hasOlder=false means everything is already rendered).
ctx.messagesEl.addEventListener("scroll", () => {
  updateScrollBottomVisibility()
  if (!_hasOlder || _loadingOlder) return
  if (ctx.messagesEl.scrollTop > 40) return
  const before = minLoadedIdx(ctx)
  if (before == null) { _hasOlder = false; return }  // nothing anchorable — defensive stop
  _loadingOlder = true
  showLoadOlderIndicator(ctx)
  vscode.postMessage({ type: "loadOlder", before })
})

// ─── Message handling ──────────────────────────

window.addEventListener("message", (e) => {
  const m = e.data
  switch (m.type) {
    case "i18n":           setStrings(m.strings); applyI18nToDOM(); break
    case "userMessage":      addUser(ctx, m.text, m.timestamp, m.idx); break
    case "assistantMessage": addAssistantHistory(ctx, m.text, m.timestamp, m.idx);
      attachCopyButtons(ctx.messagesEl.lastElementChild);
      break
    case "token":            onToken(m.text); break
    case "reasoning":        onReasoning(m.text); break
    case "toolCall":         _currentTool = m.name; addTool(ctx, m.name, m.args, m.id); renderStatusBar(); break
    case "toolResult":       finishTool(ctx, m.name, m.id, m.text, m.links); _currentTool = null; renderStatusBar(); break
    case "toolOutput": {
      // Live output streaming (bash etc.): chunks append to the running card's
      // body. Open while streaming so long commands are watchable; finishTool
      // collapses the card again on success.
      const ref = ctx._toolRefs[m.id || m.name]
      if (!ref) break
      if (ref.b.textContent === t("tool.initial")) ref.b.textContent = ""
      ref.b.textContent += m.text
      ref.b.classList.add("open")
      ref.h.querySelector(".tool-call-icon")?.classList.add("open")
      ref.h.setAttribute("aria-expanded", "true")
      maybeScrollDown(ctx)
      break
    }
    case "toolHistory":      addToolHistory(ctx, m.name, m.text, m.idx); break
    case "loading": {
      if (m.loading) {
        document.getElementById("status-line").innerHTML = _planActive
          ? `<span style="color:var(--accent)">${t("status.plan")}</span> <span class="status-sep">|</span> ${t("status.thinking")}<span class="loading-dots"></span>`
          : `${t("status.thinking")}<span class="loading-dots"></span>`
      }
      setLoading(ctx, m.loading)
      break
    }
    case "complete":         finish(); break
    case "aborted":          finish(true); break
    case "error":
      showError(ctx, m.text, m.techInfo)
      // Send failed because no provider is configured/usable — re-open the
      // welcome configuration panel even if the user previously skipped it.
      if (m.needsSetup) {
        _welcomeDismissed = false
        showWelcomePanel(_lastProviderStatus)
      }
      finish()
      break
    case "clearMessages":
      ctx.messagesEl.replaceChildren()
      ctx.currentBubble = null; ctx.currentBlock = null; ctx.currentTools = []; ctx.currentRaw = ""; ctx.currentReasoning = null; ctx.currentReasoningRaw = ""
      _advisorBlock = null; _subBlocks.clear()
      _hasOlder = false
      _loadingOlder = false
      renderStatusBar()
      showWelcome(ctx)
      break
    case "historyPage":
      applyHistoryPage(ctx, m)
      break
    case "sessions":
      ctx._sessions = m.sessions || []
      ctx.activeSession = m.active || 0
      updateSessionTitle()
      break
    case "models":
      ctx._models = m.models || []
      if (ctx._models.length > 0) {
        ctx.modelBtn.style.display = ""
        ctx.reasoningBtn.style.display = ""
        const prefs = m.prefs || {}
        const match = ctx._models.find((x) => x.id === prefs.model && x.provider === prefs.provider)
        if (match) {
          ctx.selectedModel = match.id; ctx.selectedProvider = match.provider
          ctx.modelBtn.textContent = match.id
          ctx.selectedReasoning = prefs.reasoning || "off"
          const levels = match.reasoning || []
          if (levels.length > 0 && !levels.includes(ctx.selectedReasoning)) ctx.selectedReasoning = levels[0]
          ctx.reasoningBtn.textContent = ctx.selectedReasoning === "none" ? "off" : (reasoningLabel(ctx.selectedReasoning))
          ctx.reasoningBtn.classList.toggle("active", levels.length > 0 && ctx.selectedReasoning !== "off")
          vscode.postMessage({ type: "selectModel", model: match.id, provider: match.provider })
          vscode.postMessage({ type: "selectReasoning", reasoning: ctx.selectedReasoning })
        } else if (!ctx._models.find((x) => x.id === ctx.selectedModel)) {
          const m0 = ctx._models[0]
          ctx.selectedModel = m0.id; ctx.selectedProvider = m0.provider || ""; ctx.modelBtn.textContent = m0.id
          const levels = m0.reasoning || []
          ctx.selectedReasoning = levels.length > 0 ? levels[0] : "off"
          ctx.reasoningBtn.textContent = ctx.selectedReasoning === "none" ? "off" : (reasoningLabel(ctx.selectedReasoning))
          ctx.reasoningBtn.classList.toggle("active", levels.length > 0 && ctx.selectedReasoning !== "off")
          vscode.postMessage({ type: "selectModel", model: m0.id, provider: m0.provider || "" })
          vscode.postMessage({ type: "selectReasoning", reasoning: ctx.selectedReasoning })
        }
      } else {
        ctx.modelBtn.textContent = ""
        ctx.modelBtn.title = ""
        ctx.modelBtn.style.display = "none"
        ctx.reasoningBtn.style.display = "none"
      }
      break
    case "providerStatus":
      _lastProviderStatus = m.status || {}
      updateProviderStatus(_lastProviderStatus)
      showBanner(ctx, m.keyOk ? t("banner.configured") : t("banner.notConfigured"), m.keyOk)
      maybeShowWelcome(_lastProviderStatus, m.keyOk)
      break
    case "providerError":
      showSettingsError(m.text)
      break
    case "autoApprove":
      _autoApprove = m.value
      autoBtn.classList.toggle("active", _autoApprove)
      autoBtn.classList.toggle("warning", _autoApprove)
      autoBtn.textContent = _autoApprove ? "⚠ AUTO" : "AUTO"
      break
    case "agentSettings":
      updateAgentSettings(m.settings || {})
      _advisorOn = !!(m.settings?.advisor?.enabled)
      _engOn = !!(m.settings?.engineering)
      applyModeButtons()
      break
    case "websearchSettings":
      updateWebsearchSettings(m.settings || {})
      break
    case "testProviderResult":
      updateTestProviderResult(m)
      break
    case "shellCandidates":
      updateShellCandidates(m)
      break
    case "proxySettings":
      updateProxySettings(m.settings || {})
      break
    case "proxyTestResult":
      updateProxyTestResult(m.result || {})
      break
    case "question": {
      showQuestion(ctx, m.question, m.options)
      break
    }
    case "permissionRequest": {
      const el = document.createElement("div")
      el.className = "permission-prompt"
      el.setAttribute("role", "alert")
      el.setAttribute("aria-label", t("perm.wantsTo") + " " + m.tool)
      const argsPreview = m.args ? m.args.slice(0, 150) + (m.args.length > 150 ? "…" : "") : ""
      let diffHtml = ""
      let diffBig = false
      if (m.diff && m.diff.patch) {
        diffHtml = '<div class="diff-preview"><div class="diff-header">apply_patch</div>' + renderPatch(m.diff.patch) + '</div>'
        diffBig = m.diff.patch.split("\n").length > 20
      } else if (m.diff && m.diff.old !== m.diff.new) {
        const lines = lineDiff(m.diff.old, m.diff.new)
        diffHtml = '<div class="diff-preview"><div class="diff-header">' + escHtml(m.diff.path) + '</div>' + renderDiff(lines) + '</div>'
        diffBig = lines.filter((l) => l.type !== "same").length > 12
      }
      let html = '<div class="permission-prompt-text">' + t("perm.wantsTo") + ' <code>' + escHtml(m.tool) + '</code>'
      if (argsPreview) html += '<br><span style="font-size:11px;opacity:0.7">' + escHtml(argsPreview) + '</span>'
      html += '</div>' + diffHtml
      // Large diffs are unreviewable in the cramped card — offer the native diff viewer.
      if (diffBig) html += '<button class="view-diff" style="margin-top:4px;font-size:11px">' + t("perm.viewInEditor") + '</button>'
      html += '<div class="permission-prompt-actions">'
      html += '<button class="approve" aria-label="' + t("perm.approve") + ' ' + m.tool + '">' + t("perm.approve") + '</button>'
      html += '<button class="approve-all" aria-label="' + t("perm.approveAll") + '">' + t("perm.approveAll") + '</button>'
      html += '<button class="deny" aria-label="' + t("perm.deny") + ' ' + m.tool + '">' + t("perm.deny") + '</button>'
      html += '</div>'
      el.innerHTML = html
      el.querySelector(".view-diff")?.addEventListener("click", () => {
        vscode.postMessage({ type: "openDiff", diff: m.diff })
      })
      el.querySelector(".approve").addEventListener("click", () => {
        el.remove()
        vscode.postMessage({ type: "permissionResponse", approved: true })
      })
      el.querySelector(".approve-all").addEventListener("click", () => {
        el.remove()
        vscode.postMessage({ type: "permissionResponse", approved: "approveAll" })
      })
      el.querySelector(".deny").addEventListener("click", () => {
        el.remove()
        vscode.postMessage({ type: "permissionResponse", approved: false })
      })
      document.getElementById("messages").appendChild(el)
      el.scrollIntoView({ behavior: "smooth" })
      // Focus the deny button (safest default)
      setTimeout(() => el.querySelector(".deny")?.focus(), 50)
      break
    }
    case "atResults":
      showAtDropdown(m.matches || [])
      break
    case "mcpStatus":
      window._mcpServers = m.servers || {}
      renderMcpList()
      break
    case "mcpTools": updateMcpTools(m); break
    case "indexStatus":
      updateIndexStatus(m.status)
      break
    case "usage": {
      _lastUsage = m.usage || {}
      _llmCalls++ // one LLM call per usage report (CLI turn parity)
      if (m.ctxPct != null) _lastCtxPct = m.ctxPct
      renderStatusBar(m)
      break
    }
    case "taskProgress": {
      const p = m.pending ?? 0, ip = m.inProgress ?? 0, d = m.done ?? 0
      _taskProgress = m
      if (m.total > 0) _taskStatus = `✓${d}/${m.total}${ip > 0 ? ` ·${ip}` : ""}${p > 0 ? ` …${p}` : ""}`
      else _taskStatus = null
      renderTaskPanel()
      renderStatusBar()
      break
    }
    case "planMode":
      _planActive = m.active
      document.getElementById("input-row").classList.toggle("plan-active", _planActive)
      applyModeButtons()
      renderStatusBar()
      break
    case "subagent":
      if (m.status === "started") {
        _subagentMap[m.id] = { role: m.role, status: "started", startedAt: m.startedAt || Date.now(), tool: null, model: m.model ?? null }
      } else {
        const s = _subagentMap[m.id]
        if (s) { s.status = m.status; s.doneAt = Date.now(); if (m.error) s.error = m.error; if (m.replyPreview) s.replyPreview = m.replyPreview }
        // Consult terminal state → collapse its activity block (consult-UI review 2026-08-15;
        // the "collapses when done" comment was a promise the code never kept).
        if (m.role === "consult" && m.model && m.status !== "started") {
          const block = _subBlocks.get(`sub:consult ${m.model}`)
          if (block) block.open = false
        }
      }
      renderSubagentPanel()
      renderStatusBar()
      break
    case "goal":
      _goalInfo = m
      renderGoalPanel()
      renderStatusBar()
      break
    case "toolPanel":
      // Advisor streams into an in-conversation details block (like reasoning),
      // round-tagged and never truncated — NOT a side panel.
      if (m.name === "advisor") advisorChunk(m)
      else if (m.name?.startsWith("sub:")) subagentChunk(m)
      break
  }
})

/**
 * Advisor output renders as an in-conversation details block (reasoning-style):
 * full content streams into a scrolling region — NEVER truncated — and the
 * summary carries the round number. A "start" chunk opens (and closes the
 * previous round's block); think/tool/text chunks append inside it.
 */
function advisorChunk(m) {
  if (m.kind === "start") {
    if (_advisorBlock) _advisorBlock.open = false // previous round collapses (stays readable)
    const details = buildAdvisorBlock(t("advisor.round", { round: m.round ?? "?" }))
    if (ctx.currentBlock) ctx.currentBlock.appendChild(details)
    else ctx.messagesEl.appendChild(details)
    _advisorBlock = details
    return
  }
  if (!_advisorBlock) return
  appendAdvisorChunk(_advisorBlock, m.kind ?? "text", m.text)
  const content = _advisorBlock.querySelector(".advisor-content")
  if (content) content.scrollTop = content.scrollHeight
  maybeScrollDown(ctx)
}


/** Subagent/consultant activity stream — same in-conversation details block as the
 *  advisor, one block per subagent label ("sub:explore", "sub:consult glm:glm-5.2" ...).
 *  Collapses when done so a busy turn with several children stays readable. */
function subagentChunk(m) {
  let block = _subBlocks.get(m.name)
  if (!block) {
    block = buildAdvisorBlock(m.name.slice(4)) // strip "sub:" — the label IS the header
    block.classList.add("sub-block") // shorter content height + dimmer title (consult-UI review)
    block.open = true
    if (ctx.currentBlock) ctx.currentBlock.appendChild(block)
    else ctx.messagesEl.appendChild(block)
    _subBlocks.set(m.name, block)
  }
  appendAdvisorChunk(block, m.kind ?? "tool", m.text)
  const content = block.querySelector(".advisor-content")
  if (content) content.scrollTop = content.scrollHeight
  maybeScrollDown(ctx)
}

// ─── Send ──────────────────────────────────────

/** Whether the @-autocomplete dropdown is open (input-history keys must not fight it). */
function isAtDropdownOpen() {
  return document.getElementById("at-dropdown")?.style.display !== "none"
}

/** ↑/↓ input history with draft protection (CLI parity). */
function navigateInputHistory(dir) {
  const h = ctx._inputHistory
  if (h.length === 0) return
  if (dir < 0) {
    // ↑ — draft → newest entry, then walk older (CLI key-handler parity).
    if (ctx._historyIdx === -1) ctx._inputDraft = ctx.inputEl.value
    ctx._historyIdx = ctx._historyIdx === -1 ? h.length - 1 : Math.max(0, ctx._historyIdx - 1)
  } else {
    // ↓ — walk newer; past the newest returns to the stashed draft.
    if (ctx._historyIdx === -1) return
    ctx._historyIdx++
    if (ctx._historyIdx >= h.length) ctx._historyIdx = -1
  }
  ctx.inputEl.value = ctx._historyIdx === -1 ? ctx._inputDraft : h[ctx._historyIdx]
  const len = ctx.inputEl.value.length
  ctx.inputEl.setSelectionRange(len, len)
  ctx.inputEl.style.height = "auto"
  ctx.inputEl.style.height = Math.min(ctx.inputEl.scrollHeight, 150) + "px"
}

function send() {
  const text = ctx.inputEl.value.trim()
  if (!text || ctx.isRunning) return
  const h = ctx._inputHistory
  if (h[h.length - 1] !== text) h.push(text) // dedupe consecutive repeats
  ctx._historyIdx = -1
  ctx._inputDraft = ""
  _turnStart = Date.now()
  _llmCalls = 0
  const w = ctx.messagesEl.querySelector(".welcome")
  if (w) w.remove()
  ctx.inputEl.value = ""
  ctx.inputEl.style.height = "auto"
  setLoading(ctx, true)
  ctx.hadToolResult = false
  clearPanels()
  addUser(ctx, text)
  const images = ctx._pastedImages
  ctx._pastedImages = []
  document.getElementById("paste-bar").style.display = "none"
  document.getElementById("paste-badge").innerHTML = ""
  vscode.postMessage({ type: "userMessage", text, model: ctx.selectedModel, reasoning: ctx.selectedReasoning, provider: ctx.selectedProvider, images })
  // If session title is auto-generated (Session N), show a hint that a better title is coming
  if (/^Session \d+$/.test(ctx.sessionTitle.textContent)) {
    ctx.sessionTitle.textContent = ctx.sessionTitle.textContent + " — " + (t("session.generatingTitle") || "generating title…")
  }
}

// ─── Token handling ────────────────────────────

function onReasoning(text) {
  // Start a new block if tool results arrived or if there are tools in the current block
  // (ensures reasoning always appears below tool calls, preserving session flow order)
  if (ctx.hadToolResult || ctx.currentTools.length > 0) {
    ctx.currentBubble = null; ctx.currentBlock = null; ctx.currentReasoning = null; ctx.currentReasoningRaw = ""; ctx.hadToolResult = false
  }
  if (!ctx.currentBlock) newBlock(ctx)
  if (!ctx.currentReasoning) {
    const details = document.createElement("details")
    details.className = "reasoning-block"
    details.open = true
    const summary = document.createElement("summary")
    summary.textContent = t("status.thinking") + "..."
    details.appendChild(summary)
    const div = document.createElement("div")
    div.className = "reasoning-content"
    details.appendChild(div)
    ctx.currentBlock.appendChild(details)
    ctx.currentReasoning = div
    ctx.currentReasoningRaw = ""
  }
  ctx.currentReasoningRaw += text
  // Render markdown (reasoning models emit headers/code/bold in their thinking)
  // with a plain-text fallback on pathological input — same contract as onToken.
  try { ctx.currentReasoning.innerHTML = md(ctx.currentReasoningRaw) } catch { ctx.currentReasoning.textContent = ctx.currentReasoningRaw }
  // Scroll reasoning content itself (it has max-height + overflow)
  ctx.currentReasoning.scrollTop = ctx.currentReasoning.scrollHeight
  maybeScrollDown(ctx)
}

function onToken(text) {
  // Start a new block if tool results arrived or if there are tools in the current block
  if (ctx.hadToolResult || ctx.currentTools.length > 0) { ctx.currentBubble = null; ctx.currentBlock = null; ctx.currentRaw = ""; ctx.hadToolResult = false }
  if (!ctx.currentBlock) newBlock(ctx)
  if (!ctx.currentBubble) {
    ctx.currentBubble = document.createElement("div")
    ctx.currentBubble.className = "bubble content"
    ctx.currentBlock.appendChild(ctx.currentBubble)
    ctx.currentRaw = ""
  }
  ctx.currentRaw += text
  // md() failure on pathological input must not break all subsequent token
  // rendering for the rest of the turn — plain-text fallback.
  try { ctx.currentBubble.innerHTML = md(ctx.currentRaw) } catch { ctx.currentBubble.textContent = ctx.currentRaw }
  maybeScrollDown(ctx)
}

function finish(aborted) {
  // A turn end without an answer leaves a stale inline question card — drop it
  // (aborted/error paths; a completed turn answers via questionResponse which
  // removes its own card).
  if (aborted) document.querySelectorAll(".question-card").forEach((el) => el.remove())
  if (aborted) {
    // Match CLI: push "[stopped]" as a line in the output stream
    if (!ctx.currentBubble) {
      ctx.currentRaw = ""
      if (!ctx.currentBlock) newBlock(ctx)
      ctx.currentBubble = document.createElement("div")
      ctx.currentBubble.className = "bubble content"
      ctx.currentBlock.appendChild(ctx.currentBubble)
    }
      ctx.currentRaw += "\n\n"
      // Append the "[stopped]" indicator AFTER markdown rendering — raw HTML
      // inside ctx.currentRaw would break if md() ever starts escaping HTML
      // (security hardening) or if the i18n string contains < > &.
      const indicator = `<span style="color:var(--vscode-editorWarning-foreground, #cca700);font-style:italic">${escHtml(t("status.stopped"))}</span>`
      try { ctx.currentBubble.innerHTML = md(ctx.currentRaw) + indicator } catch { ctx.currentBubble.textContent = ctx.currentRaw + " " + t("status.stopped") }
  }
  if (ctx.currentBubble) attachCopyButtons(ctx.currentBubble)
  ctx.currentBubble = null; ctx.currentBlock = null; ctx.currentTools = []; ctx.currentRaw = ""; ctx.currentReasoning = null; ctx.currentReasoningRaw = ""; ctx.hadToolResult = false
  ctx._toolRefs = {}
  _currentTool = null
  _turnStart = null
  _advisorBlock = null; _subBlocks.clear() // turn over — blocks reset with the turn
  setLoading(ctx, false)
  renderStatusBar()
}

/** Attach copy buttons to all code blocks in a container */
function attachCopyButtons(container) {
  if (!container) return
  const blocks = container.querySelectorAll(".code-block")
  for (const block of blocks) {
    if (block.querySelector(".code-copy-btn")) continue // already has one
    const btn = document.createElement("button")
    btn.className = "code-copy-btn"
    btn.textContent = t("msg.copy")
    btn.addEventListener("click", async () => {
      const code = block.querySelector("code")?.textContent || ""
      try { await navigator.clipboard.writeText(code) } catch { /* */ }
      btn.textContent = t("msg.copied")
      btn.classList.add("copied")
      setTimeout(() => { btn.textContent = t("msg.copy"); btn.classList.remove("copied") }, 2000)
    })
    block.appendChild(btn)
  }
}

// ─── i18n DOM updates ──────────────────────────

/** Apply locale strings to static HTML elements after i18n message arrives */
function applyI18nToDOM() {
  // session bar
  const title = document.getElementById("session-title")
  if (title && title.textContent === "Session 1") title.textContent = t("session.title") + " 1"
  const newBtn = document.getElementById("new-session-btn")
  if (newBtn) newBtn.title = t("session.new")

  // input
  const input = document.getElementById("input")
  if (input) input.placeholder = t("input.placeholder")

  // toolbar buttons
  const sendBtn = document.getElementById("send-btn")
  if (sendBtn) sendBtn.title = t("toolbar.send")
  const abortBtn = document.getElementById("abort-btn")
  if (abortBtn) abortBtn.title = t("toolbar.stop")
  const attachBtn = document.getElementById("attach-btn")
  if (attachBtn) { attachBtn.title = t("toolbar.attach"); attachBtn.textContent = t("toolbar.attachShort") }
  const modelBtn = document.getElementById("model-btn")
  if (modelBtn) modelBtn.title = t("toolbar.model")
  const reasoningBtn = document.getElementById("reasoning-btn")
  if (reasoningBtn) reasoningBtn.title = t("toolbar.reasoning")
  const autoBtn = document.getElementById("auto-btn")
  if (autoBtn) autoBtn.title = t("toolbar.autoApprove")
  if (document.getElementById("advisor-btn")) document.getElementById("advisor-btn").title = t("toolbar.advisor")
  if (document.getElementById("eng-btn")) document.getElementById("eng-btn").title = t("toolbar.engineering")
  const settingsBtn = document.getElementById("settings-btn")
  if (settingsBtn) settingsBtn.title = t("toolbar.settings")

  // settings panel
  const settingsTitle = document.querySelector("#settings-panel h3")
  if (settingsTitle) settingsTitle.textContent = t("settings.title")

  // welcome page
  const welcome = document.querySelector(".welcome h2")
  if (welcome) welcome.textContent = t("welcome.heading")
}

/** Get reasoning label from i18n */
function reasoningLabel(level) {
  return t("reasoning." + (level || "none"))
}

// ─── Startup handshake: the extension sets webview.html then immediately
// postMessages i18n — but the webview loads ASYNCHRONOUSLY, so that message is
// DROPPED (restart/Reload Window made this race visible: labels showed "msg.user",
// send felt dead). Pull instead: once THIS script runs, the listener is ready,
// so ask the extension to push the initial state.
vscode.postMessage({ type: "webviewReady" })
