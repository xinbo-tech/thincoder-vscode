/**
 * chat.js — main orchestration: state, events, token handling
 */
import { md } from "./md.js"
import {
  showWelcome, showBanner, addUser, addAssistantHistory, newBlock,
  addTool, finishTool, setLoading, showError, scrollDown,
} from "./ui.js"

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
  isRunning: false, hadToolResult: false,
  _models: [],
  selectedModel: "", selectedProvider: "", selectedReasoning: "max",
  _sessions: [], activeSession: "",
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

// ─── Session bar ───────────────────────────────

document.getElementById("new-session-btn").addEventListener("click", () => vscode.postMessage({ type: "newSession" }))

ctx.sessionSelector.addEventListener("click", (e) => {
  e.stopPropagation()
  const open = ctx.sessionDropdown.style.display !== "none"
  ctx.sessionDropdown.style.display = open ? "none" : "block"
  if (!open) buildSessionDropdown()
})

ctx.sessionDropdown.addEventListener("click", (e) => {
  e.stopPropagation() // prevent closing when clicking inside dropdown
})

function buildSessionDropdown() {
  ctx.sessionDropdown.innerHTML = ""
  for (const s of ctx._sessions) {
    const item = document.createElement("div")
    item.className = "session-item"
    if (s.active) item.classList.add("active")
    item.innerHTML = `<span class="session-item-title">${escHtml(s.title)}</span>
      <span class="session-item-meta">${s.count}msgs${s.updated ? " · " + fmtDate(s.updated) : ""}</span>
      <button class="session-delete" title="Delete">✕</button>`
    item.addEventListener("click", (e) => {
      if (e.target.closest(".session-delete")) return
      vscode.postMessage({ type: "switchSession", name: s.name })
      ctx.sessionDropdown.style.display = "none"
    })
    item.querySelector(".session-delete").addEventListener("click", (e) => {
      e.stopPropagation()
      if (confirm(`Delete session "${s.title}"?`)) {
        vscode.postMessage({ type: "deleteSession", name: s.name })
      }
    })
    ctx.sessionDropdown.appendChild(item)
  }
  if (ctx._sessions.length === 0) {
    const empty = document.createElement("div")
    empty.className = "session-item"
    empty.textContent = "No sessions"
    empty.style.opacity = "0.5"
    ctx.sessionDropdown.appendChild(empty)
  }
}

function updateSessionTitle() {
  const active = ctx._sessions.find((s) => s.active)
  ctx.sessionTitle.textContent = active ? active.title : "Session"
}

function fmtDate(ts) {
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

// ─── Toolbar buttons ───────────────────────────

document.getElementById("settings-btn").addEventListener("click", openSettings)
ctx.modelBtn.addEventListener("click", () => toggleDropdown(ctx.dropdown, () => buildModelDropdown()))
ctx.reasoningBtn.addEventListener("click", () => toggleDropdown(ctx.reasoningDropdown, () => buildReasoningDropdown()))

function escHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") }

// ─── Model selector ────────────────────────────

function buildModelDropdown() {
  ctx.dropdown.innerHTML = ""
  if (ctx._models.length === 0) {
    ctx.dropdown.appendChild(sectionEl("Loading models…"))
    return
  }
  let lastGroup = ""
  for (const m of ctx._models) {
    if (m.group !== lastGroup) { ctx.dropdown.appendChild(sectionEl(m.group)); lastGroup = m.group }
    const item = document.createElement("div")
    item.className = "dropdown-item"
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
    ctx.reasoningDropdown.appendChild(sectionEl("No reasoning"))
    const item = document.createElement("div")
    item.className = "dropdown-item"
    item.innerHTML = "<span>Off (not supported)</span>"
    item.style.opacity = "0.5"
    ctx.reasoningDropdown.appendChild(item)
    return
  }
  ctx.reasoningDropdown.appendChild(sectionEl("Reasoning"))
  for (const level of levels) {
    const item = document.createElement("div")
    item.className = "dropdown-item"
    const label = REASONING_LABELS[level] || level
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
  ctx.reasoningBtn.textContent = visible === "none" ? "off" : (REASONING_LABELS[visible] || visible)
  ctx.reasoningBtn.classList.toggle("active", levels.length > 0 && visible !== "off")
}

function toggleDropdown(el, build) {
  const open = el.style.display !== "none"
  el.style.display = open ? "none" : "block"
  if (!open) build()
}

document.addEventListener("click", (e) => {
  if (!ctx.dropdown.contains(e.target) && e.target !== ctx.modelBtn) ctx.dropdown.style.display = "none"
  if (!ctx.reasoningDropdown.contains(e.target) && e.target !== ctx.reasoningBtn) ctx.reasoningDropdown.style.display = "none"
  if (!ctx.sessionDropdown.contains(e.target) && !ctx.sessionSelector.contains(e.target)) ctx.sessionDropdown.style.display = "none"
})

// ─── Settings panel ────────────────────────────

const PROVIDER_LABELS = {
  deepseek: "DeepSeek", kimi: "Kimi (Moonshot)", glm: "GLM (Zhipu)",
  qwen: "Qwen (Alibaba)", minimax: "MiniMax", openai: "OpenAI",
}

let _providerStatus = {}

function openSettings() {
  document.getElementById("settings-panel").style.display = "flex"
  buildSettings()
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
        ? `<button class="key-btn" onclick="window._editKey('${name}')">Change</button>
           <button class="key-btn del-key" onclick="window._delKey('${name}')">✕</button>`
        : `<button class="key-btn" onclick="window._editKey('${name}')">Add Key</button>`}
    </div>`
  }

  html += `<div class="settings-sep"></div>
    <h4 class="settings-section-title">Custom Provider</h4>
    <div class="key-field"><label>API Key</label><input id="s-custom-key" type="password" placeholder="sk-..."></div>
    <div class="key-field"><label>Base URL</label><input id="s-custom-url" placeholder="https://api.example.com/v1" value="${escHtml(custom?.baseURL || "")}"></div>
    <div class="key-field"><label>Model</label><input id="s-custom-model" placeholder="model-name" value="${escHtml(custom?.model || "")}"></div>`

  body.innerHTML = html
}

// Expose to inline onclick handlers
window._editKey = function(name) {
  const row = document.getElementById("row-" + name)
  row.innerHTML = `<span class="key-label">${PROVIDER_LABELS[name]}</span>
    <input id="input-${name}" type="password" placeholder="sk-..." style="flex:1;margin:0 8px;"
      onkeydown="if(event.key==='Enter')window._saveKey('${name}')">
    <button class="key-btn" onclick="window._saveKey('${name}')">Save</button>
    <button class="key-btn" onclick="window._cancelEdit('${name}')">Cancel</button>`
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
  document.getElementById("settings-panel").style.display = "none"
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

// ─── Message handling ──────────────────────────

window.addEventListener("message", (e) => {
  const m = e.data
  switch (m.type) {
    case "userMessage":      addUser(ctx, m.text); break
    case "assistantMessage": addAssistantHistory(ctx, m.text); break
    case "token":            onToken(m.text); break
    case "toolCall":         addTool(ctx, m.name, m.args); break
    case "toolResult":       finishTool(ctx, m.name, m.text); break
    case "loading":          setLoading(ctx, m.loading); break
    case "complete":         finish(); break
    case "aborted":          finish(true); break
    case "error":            showError(ctx, m.text); finish(); break
    case "clearMessages":
      ctx.messagesEl.replaceChildren()
      ctx.currentBubble = null; ctx.currentBlock = null; ctx.currentTools = []; ctx.currentRaw = ""
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
          ctx.reasoningBtn.textContent = ctx.selectedReasoning === "none" ? "off" : (REASONING_LABELS[ctx.selectedReasoning] || ctx.selectedReasoning)
          ctx.reasoningBtn.classList.toggle("active", levels.length > 0 && ctx.selectedReasoning !== "off")
          vscode.postMessage({ type: "selectModel", model: match.id, provider: match.provider })
          vscode.postMessage({ type: "selectReasoning", reasoning: ctx.selectedReasoning })
        } else if (!ctx._models.find((x) => x.id === ctx.selectedModel)) {
          const m0 = ctx._models[0]
          ctx.selectedModel = m0.id; ctx.selectedProvider = m0.provider || ""; ctx.modelBtn.textContent = m0.id
          const levels = m0.reasoning || []
          ctx.selectedReasoning = levels.length > 0 ? levels[0] : "off"
          ctx.reasoningBtn.textContent = ctx.selectedReasoning === "none" ? "off" : (REASONING_LABELS[ctx.selectedReasoning] || ctx.selectedReasoning)
          ctx.reasoningBtn.classList.toggle("active", levels.length > 0 && ctx.selectedReasoning !== "off")
          vscode.postMessage({ type: "selectModel", model: m0.id, provider: m0.provider || "" })
          vscode.postMessage({ type: "selectReasoning", reasoning: ctx.selectedReasoning })
        }
      }
      break
    case "providerStatus":
      _providerStatus = m.status || {}
      showBanner(ctx, m.keyOk ? "ThinCoder" : "⚠ Not configured — click ⚙ to set API keys", m.keyOk)
      if (document.getElementById("settings-panel").style.display !== "none") buildSettings()
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
  addUser(ctx, text)
  vscode.postMessage({ type: "userMessage", text, model: ctx.selectedModel, reasoning: ctx.selectedReasoning, provider: ctx.selectedProvider })
}

// ─── Token handling ────────────────────────────

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
  if (aborted && ctx.currentBubble) { ctx.currentRaw += "\n\n*[Stopped]*"; ctx.currentBubble.innerHTML = md(ctx.currentRaw) }
  ctx.currentBubble = null; ctx.currentBlock = null; ctx.currentTools = []; ctx.currentRaw = ""; ctx.hadToolResult = false
  setLoading(ctx, false)
}
