/**
 * chat.js — main orchestration: state, events, token handling
 */
import { md } from "./md.js"
import { tailTruncate, fmtK, patchLineType } from "./lib.js"
import { renderDiff, lineDiff } from "./diff.js"
import {
  showWelcome, showBanner, addUser, addAssistantHistory, newBlock,
  addTool, addToolHistory, finishTool, setLoading, showError, scrollDown, escHtml,
  buildHistoryMessage,
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
  // First-run onboarding panel
  welcomePanel: document.getElementById("welcome-panel"),
  welcomeProvider: document.getElementById("welcome-provider"),
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
let _toolPanels = {}
// Lazy history loading: _hasOlder = more pages exist before the first rendered
// message; _loadingOlder guards against scroll-triggered double requests.
let _hasOlder = false
let _loadingOlder = false
// First-run onboarding: shown when no provider is configured; dismissed on skip
// (stays dismissed for the webview's lifetime, reappears after a reload).
let _welcomeDismissed = false
// Panel preview caps (named — used by tailTruncate and the block accumulator)
const PANEL_PREVIEW_CHARS = 2000
const PANEL_BLOCK_MAX = 20000
let _currentTool = null  // name of the tool currently executing (CLI status parity)
let _llmCalls = 0        // LLM calls this turn (CLI turn-count parity)
let _turnStart = null    // ms timestamp of the current turn (elapsed parity)

// ─── Init ──────────────────────────────────────

showWelcome(ctx)

ctx.sendBtn.addEventListener("click", send)
ctx.abortBtn.addEventListener("click", () => vscode.postMessage({ type: "abort" }))
ctx.inputEl.addEventListener("keydown", (e) => {
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
const _settings = initSettings({ onClose: () => ctx.inputEl.focus() })
const { openSettings, closeSettings, renderMcpList, updateProviderStatus, updateIndexStatus, updateAgentSettings, updateShellCandidates, updateProxySettings, updateProxyTestResult, showSettingsError } = _settings

// ─── Session bar ───────────────────────────────

// Auto-clean panel entries (done subagents after 3s, tool panels after 10s)
// Panel cleanup interval. The webview has no teardown path today (it lives for
// the panel's lifetime and dies with it), but the ID is captured so a future
// dispose/visibility-hidden handler can clear it.
const _panelTimer = setInterval(autoCleanPanels, 2000)
// Webview lifetime == panel lifetime, but clear on unload so a future
// teardown/dispose path cannot leak the interval.
window.addEventListener("unload", () => clearInterval(_panelTimer))

// ─── Historical message edit / delete (delegated — buttons carry data-idx) ──

ctx.messagesEl.addEventListener("click", (e) => {
  const editBtn = e.target.closest(".msg-edit-btn")
  if (editBtn) {
    vscode.postMessage({ type: "editMessage", idx: Number(editBtn.dataset.idx) })
    return
  }
  const delBtn = e.target.closest(".msg-del-btn")
  if (delBtn) {
    const idx = Number(delBtn.dataset.idx)
    const ok = window.confirm(t("msg.deleteConfirm") || "Delete this message and everything after it?")
    if (ok) vscode.postMessage({ type: "deleteMessage", idx })
  }
})

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
      vscode.postMessage({ type: "deleteSession", slot: s.slot })
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
  panel.innerHTML = `<div class="panel-desc">${t("panel.subDesc") || "Background sub-tasks — explore, plan, or implement independently"}</div>` +
    subs.map((s) => {
    const statusCls = s.status === "started" ? "started" : s.status === "done" ? "done" : "error"
    const statusText = s.status === "started" ? t("sub.running") : s.status
    return `<div class="sub-item">
      <span class="sub-role">${escHtml(s.role)}</span>
      <span class="sub-tool">${s.tool ? escHtml(s.tool) : ""}</span>
      <span class="sub-status ${statusCls}">${statusText}</span>
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

function renderToolPanels() {
  const panel = document.getElementById("tool-panels")
  const entries = Object.entries(_toolPanels)
  if (entries.length === 0) { panel.style.display = "none"; return }
  panel.innerHTML = entries.map(([name, data]) => {
    const age = data.started ? Math.round((Date.now() - data.started) / 1000) + "s ago" : ""
    // Ordered per-kind lines (think/tool/text) — accumulated, not overwritten
    // (CLI TUI parity: the emission order and kind styling survive).
    const blocks = data.blocks ?? [{ kind: "text", text: data.text ?? "" }]
    const body = blocks.slice(-10)
      .map((b) => {
        const kind = b.kind || "text"
        // text-kind blocks (final review prose) get the same markdown rendering
        // as the main conversation — **bold**, `code`, tables read naturally
        // instead of raw markers (CLI TUI parity). md() failure on pathological
        // input must not blank the whole panel — escHtml fallback.
        let rendered
        if (kind === "text") {
          try { rendered = md(tailTruncate(b.text)) } catch { rendered = escHtml(tailTruncate(b.text)) }
        } else {
          rendered = escHtml(tailTruncate(b.text))
        }
        return `<div class="tool-panel-line tool-panel-${escHtml(kind)}">${rendered}</div>`
      })
      .join("")
    return `<div class="tool-panel-item">
      <div class="tool-panel-header">
        <span class="tool-panel-name">${escHtml(name)}</span>
        <span class="tool-panel-age">${age}</span>
        <button class="tool-panel-close" data-name="${escHtml(name)}" aria-label="Close tool panel">✕</button>
      </div>
      <div class="tool-panel-body">${body}</div>
    </div>`
  }).join("")
  panel.style.display = "block"
  // Follow the stream: the panel is capped at 200px with its own scrollbar —
  // without this the newest output grows below the fold and looks "blocked
  // by the bottom" (bug report). Same follow-behavior as messages/reasoning.
  panel.scrollTop = panel.scrollHeight
  // Wire close buttons
  panel.querySelectorAll(".tool-panel-close").forEach((btn) => {
    btn.addEventListener("click", () => {
      delete _toolPanels[btn.dataset.name]
      renderToolPanels()
    })
  })
}

function clearPanels() {
  _subagentMap = {}
  _goalInfo = null
  _toolPanels = {}
  _taskProgress = null
  _taskStatus = null
  document.getElementById("subagent-panel").style.display = "none"
  document.getElementById("goal-panel").style.display = "none"
  document.getElementById("tool-panels").style.display = "none"
  document.getElementById("task-panel").style.display = "none"
}

function autoCleanPanels() {
  // Remove done subagents after 3s
  const now = Date.now()
  for (const [id, s] of Object.entries(_subagentMap)) {
    if (s.status === "done" && s.doneAt && now - s.doneAt > 3000) delete _subagentMap[id]
    if (s.status === "error" && s.doneAt && now - s.doneAt > 5000) delete _subagentMap[id]
  }
  // Remove tool panels idle >10s — an actively running tool's panel survives
  // (slow bash/reads must not lose accumulated output).
  for (const [name, d] of Object.entries(_toolPanels)) {
    if (d.started && now - d.started > 10000 && name !== _currentTool) delete _toolPanels[name]
  }
  renderSubagentPanel()
  renderToolPanels()
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

// Advisor / Engineering mode toggles (session-bar quick switches; the settings
// panel has the full advisor configuration — these mirror config.json fields).
let _advisorOn = false
let _engOn = false

const advisorBtn = document.getElementById("advisor-btn")
const engBtn = document.getElementById("eng-btn")

function applyModeButtons() {
  advisorBtn.classList.toggle("active", _advisorOn)
  advisorBtn.classList.toggle("warning", _advisorOn)
  engBtn.classList.toggle("active", _engOn)
  engBtn.classList.toggle("warning", _engOn)
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
ctx.modelBtn.addEventListener("click", () => toggleDropdown(ctx.dropdown, () => buildModelDropdown()))
ctx.reasoningBtn.addEventListener("click", () => toggleDropdown(ctx.reasoningDropdown, () => buildReasoningDropdown()))

// ─── Model selector ────────────────────────────

// Two-level hover submenu: Level 1 lists providers; hovering (or clicking) a provider opens a
// flyout submenu on its right with that provider's models. Clicking a model selects + closes.

function buildModelDropdown() {
  ctx.dropdown.innerHTML = ""
  if (ctx._models.length === 0) {
    ctx.dropdown.appendChild(sectionEl(t("model.loading")))
    return
  }
  const byProvider = new Map()
  for (const m of ctx._models) {
    const key = m.provider || m.group || ""
    if (!byProvider.has(key)) byProvider.set(key, { group: m.group || key, models: [] })
    byProvider.get(key).models.push(m)
  }
  for (const [provider, { group, models }] of byProvider) {
    ctx.dropdown.appendChild(providerRow(provider, group, models))
  }
  // Bottom management entries (CLI: add / remove / key flows at the picker footer)
  const sep = document.createElement("div")
  sep.className = "dropdown-sep"
  ctx.dropdown.appendChild(sep)
  ctx.dropdown.appendChild(manageEntry(t("model.addProvider"), "addProvider"))
  ctx.dropdown.appendChild(manageEntry(t("model.removeProvider"), "removeProvider"))
  ctx.dropdown.appendChild(manageEntry(t("model.setKey"), "setKey"))
}

// A management entry at the dropdown footer — posts the flow request to the extension host.
function manageEntry(label, type) {
  const item = document.createElement("div")
  item.className = "dropdown-item dropdown-manage"
  item.tabIndex = 0
  item.setAttribute("role", "menuitem")
  item.innerHTML = `<span>${label}</span>`
  item.addEventListener("click", (e) => {
    e.stopPropagation()
    ctx.dropdown.style.display = "none"
    vscode.postMessage({ type })
  })
  return item
}

// A Level-1 provider row with a hover flyout of its models on the right.
function providerRow(provider, group, models) {
  const current = models.find((m) => m.id === ctx.selectedModel && (m.provider || "") === (ctx.selectedProvider || ""))
  const shown = current || models[0]

  const item = document.createElement("div")
  item.className = "dropdown-item has-submenu"
  item.tabIndex = 0
  item.setAttribute("role", "option")
  item.setAttribute("aria-selected", String(!!current))
  item.innerHTML = `<span>${group}</span><span class="dropdown-sub">${shown ? shown.label : ""}</span><span class="submenu-arrow">›</span>`

  const sub = document.createElement("div")
  sub.className = "dropdown submenu"
  for (const m of models) {
    const si = document.createElement("div")
    si.className = "dropdown-item"
    si.tabIndex = 0
    si.setAttribute("role", "option")
    si.setAttribute("aria-selected", String(m.id === ctx.selectedModel && (m.provider || "") === (ctx.selectedProvider || "")))
    si.innerHTML = `<span>${m.label}</span>${m.id === ctx.selectedModel ? '<span class="check">✓</span>' : ""}`
    si.addEventListener("click", (e) => { e.stopPropagation(); selectModel(m) })
    sub.appendChild(si)
  }
  item.appendChild(sub)

  // Hover opens the flyout; leaving the whole row (item + its flyout) closes it.
  const open = () => { closeSiblingSubmenus(item); item.classList.add("open") }
  const close = () => item.classList.remove("open")
  item.addEventListener("mouseenter", open)
  item.addEventListener("mouseleave", close)
  // Keyboard / touch fallback: click toggles the flyout (without selecting the provider).
  item.addEventListener("click", (e) => { if (e.target.closest(".submenu")) return; e.stopPropagation(); item.classList.contains("open") ? close() : open() })
  return item
}

// Only one provider flyout open at a time.
function closeSiblingSubmenus(except) {
  for (const el of ctx.dropdown.querySelectorAll(".has-submenu.open")) {
    if (el !== except) el.classList.remove("open")
  }
}

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
  ctx.modelBtn.textContent = m.id; ctx.dropdown.style.display = "none"
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
  ctx.dropdown.style.display = "none"
  ctx.reasoningDropdown.style.display = "none"
  ctx.sessionDropdown.style.display = "none"
  if (ctx.sessionSelector) ctx.sessionSelector.setAttribute("aria-expanded", "false")
  el.style.display = open ? "none" : "block"
  if (!open) build()
  // Update aria-expanded on the trigger button
  if (el === ctx.dropdown) ctx.modelBtn.setAttribute("aria-expanded", String(!open))
  if (el === ctx.reasoningDropdown) ctx.reasoningBtn.setAttribute("aria-expanded", String(!open))
}

// Close all dropdowns on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    ctx.dropdown.style.display = "none"
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
  if (!ctx.dropdown.contains(e.target) && e.target !== ctx.modelBtn) ctx.dropdown.style.display = "none"
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
    if (msg.kind === "assistant") {
      attachCopyButtons(el)
      wireMsgCopyButton(el)
    }
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

  if (Array.isArray(options) && options.length > 0) {
    for (const opt of options) {
      const b = document.createElement("button")
      b.className = "perm-btn approve question-option"
      b.textContent = opt
      b.addEventListener("click", () => answer(opt))
      actions.appendChild(b)
    }
  } else {
    const input = document.createElement("input")
    input.className = "question-input"
    input.type = "text"
    input.placeholder = t("question.placeholder")
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
      wireMsgCopyButton(ctx.messagesEl.lastElementChild);
      break
    case "token":            onToken(m.text); break
    case "loadDraft": {
      // Historical message edit: text was loaded back into the input box
      ctx.inputEl.value = m.text ?? ""
      ctx.inputEl.style.height = "auto"
      ctx.inputEl.style.height = Math.min(ctx.inputEl.scrollHeight, 150) + "px"
      ctx.inputEl.focus()
      break
    }
    case "reasoning":        onReasoning(m.text); break
    case "toolCall":         _currentTool = m.name; addTool(ctx, m.name, m.args, m.id); renderStatusBar(); break
    case "toolResult":       finishTool(ctx, m.name, m.id, m.text); _currentTool = null; renderStatusBar(); break
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
    case "error":            showError(ctx, m.text, m.techInfo); finish(); break
    case "clearMessages":
      ctx.messagesEl.replaceChildren()
      ctx.currentBubble = null; ctx.currentBlock = null; ctx.currentTools = []; ctx.currentRaw = ""; ctx.currentReasoning = null; ctx.currentReasoningRaw = ""
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
      updateProviderStatus(m.status || {})
      showBanner(ctx, m.keyOk ? t("banner.configured") : t("banner.notConfigured"), m.keyOk)
      maybeShowWelcome(m.status || {}, m.keyOk)
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
      if (m.diff && m.diff.patch) {
        diffHtml = '<div class="diff-preview"><div class="diff-header">apply_patch</div>' + renderPatch(m.diff.patch) + '</div>'
      } else if (m.diff && m.diff.old !== m.diff.new) {
        const lines = lineDiff(m.diff.old, m.diff.new)
        diffHtml = '<div class="diff-preview"><div class="diff-header">' + escHtml(m.diff.path) + '</div>' + renderDiff(lines) + '</div>'
      }
      let html = '<div class="permission-prompt-text">' + t("perm.wantsTo") + ' <code>' + escHtml(m.tool) + '</code>'
      if (argsPreview) html += '<br><span style="font-size:11px;opacity:0.7">' + escHtml(argsPreview) + '</span>'
      html += '</div>' + diffHtml
      html += '<div class="permission-prompt-actions">'
      html += '<button class="approve" aria-label="' + t("perm.approve") + ' ' + m.tool + '">' + t("perm.approve") + '</button>'
      html += '<button class="approve-all" aria-label="' + t("perm.approveAll") + '">' + t("perm.approveAll") + '</button>'
      html += '<button class="deny" aria-label="' + t("perm.deny") + ' ' + m.tool + '">' + t("perm.deny") + '</button>'
      html += '</div>'
      el.innerHTML = html
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
      renderStatusBar()
      break
    case "subagent":
      if (m.status === "started") {
        _subagentMap[m.id] = { role: m.role, status: "started", startedAt: m.startedAt || Date.now(), tool: null }
      } else {
        const s = _subagentMap[m.id]
        if (s) { s.status = m.status; s.doneAt = Date.now(); if (m.error) s.error = m.error }
      }
      renderSubagentPanel()
      renderStatusBar()
      break
    case "goal":
      _goalInfo = m
      renderGoalPanel()
      renderStatusBar()
      break
    case "toolPanel": {
      // Accumulate per-kind blocks (think/tool/text) instead of overwriting —
      // same emission contract as the CLI TUI. Same-kind chunks merge; hard
      // cap per block so a runaway stream cannot balloon the panel.
      const panel = _toolPanels[m.name] ?? { blocks: [], started: Date.now() }
      const kind = m.kind ?? "text"
      const text = String(m.text ?? "")
      if (text) {
        const last = panel.blocks[panel.blocks.length - 1]
        if (last && last.kind === kind) {
          last.text += text
          if (last.text.length > PANEL_BLOCK_MAX) last.text = last.text.slice(-PANEL_BLOCK_MAX)
        } else {
          panel.blocks.push({ kind, text })
        }
        panel.started = Date.now() // refresh activity — long streams must not be reaped mid-stream
        _toolPanels[m.name] = panel
      }
      renderToolPanels()
      // Cleanup is handled by the autoCleanPanels interval (10s threshold) —
      // a per-message setTimeout would stack one timer per streamed chunk.
      break
    }
  }
})

// ─── Send ──────────────────────────────────────

/** Whether the @-autocomplete dropdown is open (input-history keys must not fight it). */
function isAtDropdownOpen() {
  return document.getElementById("at-dropdown")?.style.display !== "none"
}

/** ↑/↓ input history with draft protection (CLI parity). */
function navigateInputHistory(dir) {
  const h = ctx._inputHistory
  if (h.length === 0) return
  if (ctx._historyIdx === -1) ctx._inputDraft = ctx.inputEl.value // stash live draft once
  let idx = ctx._historyIdx + dir
  if (idx >= h.length) idx = h.length - 1
  if (idx < -1) idx = -1
  ctx._historyIdx = idx
  ctx.inputEl.value = idx === -1 ? ctx._inputDraft : h[idx]
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
  ctx.currentReasoning.textContent = ctx.currentReasoningRaw
  // Scroll reasoning content itself (it has max-height + overflow)
  ctx.currentReasoning.scrollTop = ctx.currentReasoning.scrollHeight
  scrollDown(ctx)
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
  scrollDown(ctx)
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

/** Wire the copy-message button in an assistant message element */
function wireMsgCopyButton(el) {
  const btn = el?.querySelector(".msg-copy-btn")
  if (!btn) return
  btn.addEventListener("click", async () => {
    const bubble = el.querySelector(".bubble")
    const text = bubble?.textContent || ""
    try { await navigator.clipboard.writeText(text) } catch { /* */ }
    btn.textContent = t("msg.copied")
    setTimeout(() => { btn.textContent = t("msg.copy") }, 2000)
  })
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
