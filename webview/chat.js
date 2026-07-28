/**
 * chat.js — main orchestration: state, events, token handling
 */
import { md } from "./md.js"
import { renderDiff, lineDiff } from "./diff.js"
import {
  showWelcome, showBanner, addUser, addAssistantHistory, newBlock,
  addTool, finishTool, setLoading, showError, scrollDown,
} from "./ui.js"
import { setStrings, t } from "./i18n.js"

const vscode = acquireVsCodeApi()
window._vscode = vscode

const REASONING_LABELS = { max: "Maximum", xhigh: "Extra High", high: "High", medium: "Medium", low: "Low", minimal: "Minimal", none: "Off", enabled: "Reasoning" }

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
  _models: [],
  selectedModel: "", selectedProvider: "", selectedReasoning: "max",
  _sessions: [], activeSession: "",
  _pastedImages: [],
}

// ─── Init ──────────────────────────────────────

showWelcome(ctx)

ctx.sendBtn.addEventListener("click", send)
ctx.abortBtn.addEventListener("click", () => vscode.postMessage({ type: "abort" }))
ctx.inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() }
})
ctx.inputEl.addEventListener("input", () => {
  ctx.inputEl.style.height = "auto"
  ctx.inputEl.style.height = Math.min(ctx.inputEl.scrollHeight, 150) + "px"
})

// ─── @‑autocomplete ────────────────────────────

const atDropdown = document.getElementById("at-dropdown")
let _atTimer = null, _atActive = false, _atBase = ""

ctx.inputEl.addEventListener("input", () => {
  if (!_atActive) return
  handleAtInput()
})

ctx.inputEl.addEventListener("keydown", (e) => {
  if (!_atActive) return
  if (e.key === "Escape") { closeAtDropdown(); e.preventDefault(); return }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault()
    const items = atDropdown.querySelectorAll(".dropdown-item")
    if (items.length === 0) return
    const cur = atDropdown.querySelector(".dropdown-item.active")
    const idx = cur ? Array.from(items).indexOf(cur) : -1
    if (e.key === "ArrowDown") {
      const next = idx + 1 < items.length ? idx + 1 : 0
      items.forEach(i => i.classList.remove("active"))
      items[next].classList.add("active")
      items[next].scrollIntoView({ block: "nearest" })
    } else {
      const prev = idx - 1 >= 0 ? idx - 1 : items.length - 1
      items.forEach(i => i.classList.remove("active"))
      items[prev].classList.add("active")
      items[prev].scrollIntoView({ block: "nearest" })
    }
    return
  }
  if (e.key === "Enter" || e.key === "Tab") {
    const active = atDropdown.querySelector(".dropdown-item.active")
    if (active) {
      e.preventDefault()
      insertAtRef(active.dataset.path)
      closeAtDropdown()
    }
    return
  }
})

function handleAtInput() {
  const pos = ctx.inputEl.selectionStart
  const text = ctx.inputEl.value.slice(0, pos)
  const atIdx = text.lastIndexOf("@")
  if (atIdx < 0) { closeAtDropdown(); return }
  // Check if there's a space between @ and cursor
  const afterAt = text.slice(atIdx + 1)
  if (/\s/.test(afterAt)) { closeAtDropdown(); return }
  _atBase = text.slice(0, atIdx)
  const query = text.slice(atIdx)
  clearTimeout(_atTimer)
  _atTimer = setTimeout(() => {
    vscode.postMessage({ type: "atComplete", query, cwd: "" })
  }, 150)
}

function showAtDropdown(matches) {
  if (matches.length === 0) { closeAtDropdown(); return }
  atDropdown.innerHTML = matches.map((m, i) =>
    `<div class="dropdown-item${i === 0 ? " active" : ""}" data-path="${escHtml(m.path)}" tabindex="0" role="option" aria-selected="${i === 0}">
      <span class="at-file-name">${escHtml(m.name)}</span>
      <span class="at-file-path">${escHtml(m.path)}</span>
    </div>`
  ).join("")
  atDropdown.style.display = "block"
  atDropdown.setAttribute("aria-expanded", "true")
  _atActive = true
}

function closeAtDropdown() {
  atDropdown.style.display = "none"
  atDropdown.setAttribute("aria-expanded", "false")
  _atActive = false
  atDropdown.innerHTML = ""
  clearTimeout(_atTimer)
}

function insertAtRef(path) {
  const pos = ctx.inputEl.selectionStart
  const text = ctx.inputEl.value
  const before = _atBase + "@" + path
  const after = text.slice(pos)
  ctx.inputEl.value = before + " " + after
  ctx.inputEl.selectionStart = ctx.inputEl.selectionEnd = before.length + 1
  ctx.inputEl.focus()
}

// Detect @ typing to activate autocomplete
ctx.inputEl.addEventListener("input", (e) => {
  const pos = ctx.inputEl.selectionStart
  const prevChar = ctx.inputEl.value[pos - 2]
  if (prevChar === "@") {
    _atActive = true
    handleAtInput()
  }
})

// Image paste — only intercept images, let text through to textarea
document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items
  if (!items) return
  let hasImage = false
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      if (!hasImage) { e.preventDefault(); hasImage = true }
      readImageFile(item.getAsFile())
    }
  }
})

// File upload button
const fileInput = document.getElementById("file-input")
document.getElementById("attach-btn").addEventListener("click", () => fileInput.click())
fileInput.addEventListener("change", () => {
  for (const file of fileInput.files) {
    if (file.type.startsWith("image/")) readImageFile(file)
  }
  fileInput.value = "" // reset so same file can be re-selected
})

function readImageFile(file) {
  const reader = new FileReader()
  reader.onload = () => {
    ctx._pastedImages.push(reader.result)
    renderPasteBar()
  }
  reader.readAsDataURL(file)
}

function renderPasteBar() {
  const bar = document.getElementById("paste-bar")
  const badge = document.getElementById("paste-badge")
  if (ctx._pastedImages.length === 0) {
    bar.style.display = "none"
    return
  }
  badge.innerHTML = ctx._pastedImages.map((_, i) =>
    `<span class="paste-chip">📎 image ${i + 1}<span class="paste-chip-del" data-idx="${i}">✕</span></span>`
  ).join(" ")
  bar.style.display = "flex"
  // Wire delete buttons
  badge.querySelectorAll(".paste-chip-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation()
      const idx = parseInt(btn.dataset.idx)
      ctx._pastedImages.splice(idx, 1)
      renderPasteBar()
    })
  })
}

// ─── Session bar ───────────────────────────────

// Auto-clean panel entries (done subagents after 3s, tool panels after 10s)
setInterval(autoCleanPanels, 2000)

// ─── Permission bar ──────────────────────────────



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
      <span class="session-item-meta">${s.count}msgs${s.updated ? " · " + fmtDate(s.updated) : ""}</span>
      <button class="session-delete" title="${t("session.delete")}" aria-label="${t("session.delete")} ${escHtml(s.title)}">✕</button>`
    item.addEventListener("click", (e) => {
      if (e.target.closest(".session-delete")) return
      vscode.postMessage({ type: "switchSession", name: s.name })
      ctx.sessionDropdown.style.display = "none"
    })
    item.querySelector(".session-delete").addEventListener("click", (e) => {
      e.stopPropagation()
      vscode.postMessage({ type: "deleteSession", name: s.name })
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

function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n) }

function renderTaskPanel() {
  const panel = document.getElementById("task-panel")
  if (!_taskProgress || !_taskProgress.items || _taskProgress.items.length === 0) {
    panel.style.display = "none"
    return
  }
  const allDone = _taskProgress.items.every((t) => t.status === "done")
  if (allDone && panel.style.display !== "block") {
    // Don't show — badge already says ✓N/N, no need for the panel
    return
  }
  const icons = { pending: "○", in_progress: "◉", done: "✓" }
  panel.innerHTML = _taskProgress.items.map((t) =>
    `<div class="task-item">
      <span class="task-mark">${icons[t.status] || " "}</span>
      <span class="task-title">${escHtml(t.title)}</span>
      <span class="task-status">${t.status === "in_progress" ? t("task.in_progress") : t.status}</span>
    </div>`
  ).join("")
  panel.style.display = "block"
}

function renderSubagentPanel() {
  const panel = document.getElementById("subagent-panel")
  const subs = Object.values(_subagentMap)
  if (subs.length === 0) { panel.style.display = "none"; return }
  panel.innerHTML = subs.map((s) => {
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
  panel.innerHTML = `<div class="goal-section">
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
    return `<div class="tool-panel-item">
      <div class="tool-panel-header">
        <span class="tool-panel-name">${escHtml(name)}</span>
        <span class="tool-panel-age">${age}</span>
        <button class="tool-panel-close" data-name="${escHtml(name)}" aria-label="Close tool panel">✕</button>
      </div>
      <pre class="tool-panel-body">${escHtml(data.text.slice(-4000))}</pre>
    </div>`
  }).join("")
  panel.style.display = "block"
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
  // Remove tool panels older than 10s
  for (const [name, d] of Object.entries(_toolPanels)) {
    if (d.started && now - d.started > 10000) delete _toolPanels[name]
  }
  renderSubagentPanel()
  renderToolPanels()
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
  if (m && m.ctxPct != null) parts.push(`ctx ${m.ctxPct}%`)
  else if (_lastCtxPct != null) parts.push(`ctx ${_lastCtxPct}%`)
  const subCount = Object.keys(_subagentMap).length
  if (subCount > 0) parts.push(`<span id="sub-badge" role="button" tabindex="0" aria-label="${subCount} subagents" style="cursor:pointer">sub:${subCount}</span>`)
  if (_taskStatus) parts.push(`<span id="task-badge" role="button" tabindex="0" aria-label="Task progress" style="cursor:pointer">${_taskStatus}</span>`)
  document.getElementById("status-line").innerHTML = parts.join(` <span class="status-sep">|</span> `)
  // Wire click handlers for all three badges
  const wire = (id, panelId) => {
    const el = document.getElementById(id)
    if (el) el.addEventListener("click", (e) => {
      e.stopPropagation()
      const p = document.getElementById(panelId)
      p.style.display = p.style.display === "none" ? "block" : "none"
    })
  }
  wire("task-badge", "task-panel")
  wire("sub-badge", "subagent-panel")
  wire("goal-badge", "goal-panel")
}

// ─── Toolbar buttons ───────────────────────────

document.getElementById("settings-btn").addEventListener("click", openSettings)

let _autoApprove = false
let _taskStatus = null
let _taskProgress = null
let _lastUsage = null
let _lastCtxPct = null
let _planActive = false
let _subagentMap = {}
let _goalInfo = null
let _toolPanels = {}
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

function escHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") }

// ─── Model selector ────────────────────────────

function buildModelDropdown() {
  ctx.dropdown.innerHTML = ""
  if (ctx._models.length === 0) {
    ctx.dropdown.appendChild(sectionEl(t("model.loading")))
    return
  }
  let lastGroup = ""
  for (const m of ctx._models) {
    if (m.group !== lastGroup) { ctx.dropdown.appendChild(sectionEl(m.group)); lastGroup = m.group }
    const item = document.createElement("div")
    item.className = "dropdown-item"
    item.tabIndex = 0
    item.setAttribute("role", "option")
    item.setAttribute("aria-selected", String(m.id === ctx.selectedModel))
    item.innerHTML = `<span>${m.label}</span>${m.id === ctx.selectedModel ? '<span class="check">✓</span>' : ""}`
    item.addEventListener("click", () => selectModel(m))
    ctx.dropdown.appendChild(item)
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
      document.getElementById("settings-panel").style.display = "none"
      document.getElementById("settings-panel").setAttribute("aria-hidden", "true")
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

// ─── Settings panel ────────────────────────────

const PROVIDER_LABELS = {
  deepseek: "DeepSeek", kimi: "Kimi (Moonshot)", glm: "GLM (Zhipu)",
  qwen: "Qwen (Alibaba)", minimax: "MiniMax", openai: "OpenAI",
}

let _providerStatus = {}

function openSettings() {
  const panel = document.getElementById("settings-panel")
  panel.style.display = "flex"
  panel.setAttribute("aria-hidden", "false")
  buildSettings()
  // Focus first focusable element in panel
  setTimeout(() => {
    const firstBtn = panel.querySelector("button, input")
    if (firstBtn) firstBtn.focus()
  }, 50)
}

function buildSettings() {
  const body = document.getElementById("settings-body")
  const ps = _providerStatus.providers || {}
  const custom = _providerStatus.custom || null

  let html = ""
  for (const [name, label] of Object.entries(PROVIDER_LABELS)) {
    const s = ps[name] || {}
    html += `<div class="key-row" id="row-${name}">
      <span class="key-label">${label}</span>
      <span class="key-status ${s.configured ? "ok" : ""}" id="status-${name}">${s.configured ? s.masked : "—"}</span>
      ${s.configured
        ? `<button class="key-btn" onclick="window._editKey('${name}')">${t("settings.changeKey")}</button>
           <button class="key-btn del-key" onclick="window._delKey('${name}')">✕</button>`
        : `<button class="key-btn" onclick="window._editKey('${name}')">${t("settings.addKey")}</button>`}
    </div>`
  }

  html += `<div class="settings-sep"></div>
    <h4 class="settings-section-title">${t("settings.customSection")}</h4>
    <div class="key-field"><label>${t("settings.apiKey")}</label><input id="s-custom-key" type="password" placeholder="sk-..."></div>
    <div class="key-field"><label>${t("settings.baseUrl")}</label><input id="s-custom-url" placeholder="https://api.example.com/v1" value="${escHtml(custom?.baseURL || "")}"></div>
    <div class="key-field"><label>${t("settings.model")}</label><input id="s-custom-model" placeholder="model-name" value="${escHtml(custom?.model || "")}"></div>`

  // MCP section
  html += `<div class="settings-sep"></div>
    <h4 class="settings-section-title">${t("settings.mcpSection")}</h4>
    <div id="mcp-list"></div>
    <button id="mcp-add-btn" class="key-btn" style="margin-top:6px">${t("settings.mcpAdd")}</button>
    <div id="mcp-form" style="display:none;margin-top:8px">
      <div class="key-field"><label>${t("settings.mcp.name")}</label><input id="mcp-name" placeholder="my-server"></div>
      <div class="key-field"><label>${t("settings.mcp.type")}</label><select id="mcp-type"><option value="stdio">Command (stdio)</option><option value="http">HTTP</option><option value="ws">WebSocket</option></select></div>
      <div id="mcp-stdio-fields">
        <div class="key-field"><label>${t("settings.mcp.command")}</label><input id="mcp-command" placeholder="npx"></div>
        <div class="key-field"><label>${t("settings.mcp.args")}</label><input id="mcp-args" placeholder="-y,@modelcontextprotocol/server-filesystem,/path"></div>
      </div>
      <div id="mcp-http-fields" style="display:none">
        <div class="key-field"><label>${t("settings.mcp.url")}</label><input id="mcp-url" placeholder="https://example.com/mcp"></div>
        <div class="key-field"><label>${t("settings.mcp.headers")}</label><input id="mcp-headers" placeholder='{"Authorization":"Bearer xxx"}'></div>
      </div>
      <div id="mcp-ws-fields" style="display:none">
        <div class="key-field"><label>${t("settings.mcp.wsUrl")}</label><input id="mcp-ws-url" placeholder="wss://example.com/mcp"></div>
        <div class="key-field"><label>${t("settings.mcp.headers")}</label><input id="mcp-ws-headers" placeholder='{"Authorization":"Bearer xxx"}'></div>
      </div>
      <button id="mcp-save-btn" class="key-btn">${t("settings.save")}</button>
      <button id="mcp-cancel-btn" class="key-btn">${t("settings.cancel")}</button>
    </div>`

  body.innerHTML = html

  // Bind MCP type toggle
  document.getElementById("mcp-type").addEventListener("change", (e) => {
    document.getElementById("mcp-stdio-fields").style.display = e.target.value === "stdio" ? "" : "none"
    document.getElementById("mcp-http-fields").style.display = e.target.value === "http" ? "" : "none"
    document.getElementById("mcp-ws-fields").style.display = e.target.value === "ws" ? "" : "none"
  })

  // Bind MCP add
  document.getElementById("mcp-add-btn").addEventListener("click", () => {
    document.getElementById("mcp-form").style.display = "block"
    document.getElementById("mcp-name").value = ""
    document.getElementById("mcp-command").value = ""
    document.getElementById("mcp-args").value = ""
    document.getElementById("mcp-url").value = ""
    document.getElementById("mcp-headers").value = ""
    document.getElementById("mcp-ws-url").value = ""
    document.getElementById("mcp-ws-headers").value = ""
    document.getElementById("mcp-type").value = "stdio"
    document.getElementById("mcp-stdio-fields").style.display = ""
    document.getElementById("mcp-http-fields").style.display = "none"
    document.getElementById("mcp-ws-fields").style.display = "none"
  })

  // Bind MCP save
  document.getElementById("mcp-save-btn").addEventListener("click", () => {
    const name = document.getElementById("mcp-name").value.trim()
    if (!name) return
    const type = document.getElementById("mcp-type").value
    const config = {}
    if (type === "stdio") {
      config.command = document.getElementById("mcp-command").value.trim()
      const argsStr = document.getElementById("mcp-args").value.trim()
      config.args = argsStr ? argsStr.split(",").map((s) => s.trim()) : []
    } else if (type === "ws") {
      config.wsUrl = document.getElementById("mcp-ws-url").value.trim()
      try { config.headers = JSON.parse(document.getElementById("mcp-ws-headers").value || "{}") } catch { config.headers = {} }
    } else {
      config.url = document.getElementById("mcp-url").value.trim()
      try { config.headers = JSON.parse(document.getElementById("mcp-headers").value || "{}") } catch { config.headers = {} }
    }
    vscode.postMessage({ type: "saveMcpServer", name, config })
    document.getElementById("mcp-form").style.display = "none"
  })

  // Bind MCP cancel
  document.getElementById("mcp-cancel-btn").addEventListener("click", () => {
    document.getElementById("mcp-form").style.display = "none"
  })

  // Render MCP server list
  renderMcpList()

  // Request MCP status
  vscode.postMessage({ type: "getMcpStatus" })
}

// Expose to inline onclick handlers
window._editKey = function(name) {
  const row = document.getElementById("row-" + name)
  row.innerHTML = `<span class="key-label">${PROVIDER_LABELS[name]}</span>
    <input id="input-${name}" type="password" placeholder="sk-..." style="flex:1;margin:0 8px;"
      onkeydown="if(event.key==='Enter')window._saveKey('${name}')">
    <button class="key-btn" onclick="window._saveKey('${name}')">${t("settings.save")}</button>
    <button class="key-btn" onclick="window._cancelEdit('${name}')">${t("settings.cancel")}</button>`
  setTimeout(() => document.getElementById("input-" + name)?.focus(), 50)
}

window._saveKey = function(name) {
  const inp = document.getElementById("input-" + name)
  const key = inp?.value?.trim()
  if (!key) return
  window._vscode.postMessage({ type: "saveProviderKey", name, key })
}

window._cancelEdit = function(name) {
  window._vscode.postMessage({ type: "getProviderStatus" })
}

window._delKey = function(name) {
  window._vscode.postMessage({ type: "deleteProviderKey", name })
}

document.getElementById("settings-close").addEventListener("click", () => {
  const panel = document.getElementById("settings-panel")
  panel.style.display = "none"
  panel.setAttribute("aria-hidden", "true")
  ctx.inputEl.focus()
})

document.getElementById("settings-body").addEventListener("change", () => {
  // Save custom provider on any change
  const key = document.getElementById("s-custom-key")?.value
  const url = document.getElementById("s-custom-url")?.value
  const model = document.getElementById("s-custom-model")?.value
  if (key || url || model) {
    vscode.postMessage({ type: "saveCustomProvider", config: { key, baseURL: url, model } })
  }
})

// ─── MCP settings ──────────────────────────────

window._mcpServers = {}

function renderMcpList() {
  const list = document.getElementById("mcp-list")
  if (!list) return
  const servers = window._mcpServers
  const names = Object.keys(servers)
  if (names.length === 0) {
    list.innerHTML = `<div style="font-size:12px;opacity:0.5;padding:4px 0">${t("settings.mcp.noServers")}</div>`
    return
  }
  list.innerHTML = names.map((n) => {
    const s = servers[n]
    const type = s.command ? "stdio" : (s.wsUrl ? "ws" : "http")
    const detail = type === "stdio" ? `${s.command} ${(s.args||[]).join(" ")}` : (s.wsUrl || s.url)
    return `<div class="key-row" style="font-size:12px">
      <span class="key-label">${escHtml(n)}</span>
      <span style="opacity:0.5;flex:1;margin:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(detail)}</span>
      <span style="font-size:10px;opacity:0.4;margin-right:8px">${type}</span>
      <button class="key-btn del-key mcp-del-btn" data-name="${escHtml(n)}">✕</button>
    </div>`
  }).join("")
  list.querySelectorAll(".mcp-del-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.name
      vscode.postMessage({ type: "deleteMcpServer", name })
    })
  })
}

// ─── Message handling ──────────────────────────

window.addEventListener("message", (e) => {
  const m = e.data
  switch (m.type) {
    case "i18n":           setStrings(m.strings); applyI18nToDOM(); break
    case "userMessage":      addUser(ctx, m.text, m.timestamp); break
    case "assistantMessage": addAssistantHistory(ctx, m.text, m.timestamp);
      attachCopyButtons(ctx.messagesEl.lastElementChild);
      wireMsgCopyButton(ctx.messagesEl.lastElementChild);
      break
    case "token":            onToken(m.text); break
    case "reasoning":        onReasoning(m.text); break
    case "toolCall":         addTool(ctx, m.name, m.args); break
    case "toolResult":       finishTool(ctx, m.name, m.text); break
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
    case "error":            showError(ctx, m.text); finish(); break
    case "clearMessages":
      ctx.messagesEl.replaceChildren()
      ctx.currentBubble = null; ctx.currentBlock = null; ctx.currentTools = []; ctx.currentRaw = ""; ctx.currentReasoning = null; ctx.currentReasoningRaw = ""
      document.getElementById("status-line").innerHTML = ""
      showWelcome(ctx)
      break
    case "sessions":
      ctx._sessions = m.sessions || []
      ctx.activeSession = m.active || ""
      updateSessionTitle()
      break
    case "models":
      ctx._models = m.models || []
      if (ctx._models.length > 0) {
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
      }
      break
    case "providerStatus":
      _providerStatus = m.status || {}
      showBanner(ctx, m.keyOk ? t("banner.configured") : t("banner.notConfigured"), m.keyOk)
      if (document.getElementById("settings-panel").style.display !== "none") buildSettings()
      break
    case "autoApprove":
      _autoApprove = m.value
      autoBtn.classList.toggle("active", _autoApprove)
      autoBtn.classList.toggle("warning", _autoApprove)
      autoBtn.textContent = _autoApprove ? "⚠ AUTO" : "AUTO"
      break
    case "permissionRequest": {
      const el = document.createElement("div")
      el.className = "permission-prompt"
      el.setAttribute("role", "alert")
      el.setAttribute("aria-label", t("perm.wantsTo") + " " + m.tool)
      const argsPreview = m.args ? m.args.slice(0, 150) + (m.args.length > 150 ? "…" : "") : ""
      let diffHtml = ""
      if (m.diff && m.diff.old !== m.diff.new) {
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
    case "usage": {
      _lastUsage = m.usage || {}
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
    case "toolPanel":
      _toolPanels[m.name] = { text: m.text, started: Date.now() }
      renderToolPanels()
      // Auto-clean after 10s
      setTimeout(() => { if (_toolPanels[m.name]) { delete _toolPanels[m.name]; renderToolPanels() } }, 10000)
      break
  }
})

// ─── Send ──────────────────────────────────────

function send() {
  const text = ctx.inputEl.value.trim()
  if (!text || ctx.isRunning) return
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
  renderPasteBar()
  vscode.postMessage({ type: "userMessage", text, model: ctx.selectedModel, reasoning: ctx.selectedReasoning, provider: ctx.selectedProvider, images })
}

// ─── Token handling ────────────────────────────

function onReasoning(text) {
  if (ctx.hadToolResult) { ctx.currentBubble = null; ctx.currentBlock = null; ctx.currentReasoning = null; ctx.currentReasoningRaw = ""; ctx.hadToolResult = false }
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
  if (ctx.hadToolResult) { ctx.currentBubble = null; ctx.currentBlock = null; ctx.currentRaw = ""; ctx.hadToolResult = false }
  if (!ctx.currentBlock) newBlock(ctx)
  if (!ctx.currentBubble) {
    ctx.currentBubble = document.createElement("div")
    ctx.currentBubble.className = "bubble content"
    ctx.currentBlock.appendChild(ctx.currentBubble)
    ctx.currentRaw = ""
  }
  ctx.currentRaw += text
  ctx.currentBubble.innerHTML = md(ctx.currentRaw)
  scrollDown(ctx)
}

function finish(aborted) {
  if (aborted && ctx.currentBubble) { ctx.currentRaw += "\n\n*[" + t("status.stopped") + "]*"; ctx.currentBubble.innerHTML = md(ctx.currentRaw) }
  if (ctx.currentBubble) attachCopyButtons(ctx.currentBubble)
  ctx.currentBubble = null; ctx.currentBlock = null; ctx.currentTools = []; ctx.currentRaw = ""; ctx.currentReasoning = null; ctx.currentReasoningRaw = ""; ctx.hadToolResult = false
  setLoading(ctx, false)
}

/** Attach copy buttons to all code blocks in a container */
function attachCopyButtons(container) {
  const blocks = container.querySelectorAll?.(".code-block") || []
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
