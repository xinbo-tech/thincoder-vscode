/**
 * ui.js — DOM helpers for the chat panel
 * All functions take `ctx` which provides DOM refs and mutable state.
 */

import { md, mdInline, esc } from "./md.js"
import { t } from "./i18n.js"

// ─── Welcome / Banner ──────────────────────────

export function showWelcome(ctx) {
  const el = document.createElement("div")
  el.className = "welcome"
  el.innerHTML = `<h2>${t("welcome.heading")}</h2>
    <p>${t("welcome.text")}</p>
    <p style="margin-top:8px;opacity:0.7">${t("welcome.shortcutsHtml")}</p>`
  ctx.messagesEl.appendChild(el)
}

export function showBanner(ctx, text, keyOk) {
  let banner = document.getElementById("provider-banner")
  if (!banner) {
    banner = document.createElement("div")
    banner.id = "provider-banner"
    banner.className = "provider-banner"
    ctx.messagesEl.insertBefore(banner, ctx.messagesEl.firstChild)
  }
  banner.innerHTML = ""
  banner.className = keyOk ? "provider-banner ok" : "provider-banner warn"
  const label = document.createElement("span")
  label.textContent = text
  banner.appendChild(label)
}

// ─── Messages ──────────────────────────────────

/** Historical user message (idx set) gets edit + delete buttons; live ones don't. */
export function addUser(ctx, text, timestamp, idx) {
  const el = document.createElement("div")
  el.className = "message user"
  const ts = timestamp ? fmtTime(new Date(timestamp)) : fmtTime(new Date())
  const actions = idx === undefined ? "" :
    `<span class="msg-actions">
      <button class="msg-edit-btn" data-idx="${idx}" title="${t("msg.editTitle")}">✎</button>
      <button class="msg-del-btn" data-idx="${idx}" title="${t("msg.deleteTitle")}">✕</button>
    </span>`
  el.innerHTML = `<div class="msg-label">❯ ${t("msg.user")}: <span class="msg-time">${ts}</span>${actions}</div><div class="bubble">${mdInline(esc(text))}</div>`
  ctx.messagesEl.appendChild(el)
  scrollDown(ctx)
}

/** Historical assistant message (idx set) gets a delete button; live ones don't. */
export function addAssistantHistory(ctx, text, timestamp, idx) {
  const el = document.createElement("div")
  el.className = "message assistant"
  const ts = timestamp ? fmtTime(new Date(timestamp)) : ""
  const actions = idx === undefined ? "" : `<button class="msg-del-btn" data-idx="${idx}" title="${t("msg.deleteTitle")}">✕</button>`
  el.innerHTML = `<div class="msg-label">❯ ${t("msg.assistant")}: ${ts ? `<span class="msg-time">${ts}</span>` : ""}<button class="msg-copy-btn" title="${t("msg.copyTitle")}">${t("msg.copy")}</button>${actions}</div><div class="bubble content">${md(text)}</div>`
  ctx.messagesEl.appendChild(el)
  scrollDown(ctx)
}

function fmtTime(d) {
  const h = String(d.getHours()).padStart(2,"0")
  const m = String(d.getMinutes()).padStart(2,"0")
  return `${h}:${m}`
}

export function newBlock(ctx) {
  ctx.currentTools = []
  ctx.currentBubble = null
  ctx.currentRaw = ""
  ctx.currentBlock = document.createElement("div")
  ctx.currentBlock.className = "message assistant"
  ctx.currentBlock.innerHTML = `<div class="msg-label">❯ ${t("msg.assistant")}:</div>`
  ctx.messagesEl.appendChild(ctx.currentBlock)
}

export function addTool(ctx, name, args, id) {
  if (!ctx.currentBlock) newBlock(ctx)

  const c = document.createElement("div")
  c.className = "tool-call"
  c.dataset.startTime = String(Date.now())

  const h = document.createElement("div")
  h.className = "tool-call-header"
  h.tabIndex = 0
  h.setAttribute("role", "button")
  h.setAttribute("aria-expanded", "false")
  h.innerHTML =
    `<span class="tool-call-icon"></span>` +
    `<span class="tool-call-name">${esc(name)}</span>` +
    `<span class="tool-call-args">${esc(args.slice(0, 80))}</span>` +
    `<span class="tool-call-status">${t("tool.running")}</span>`

  const b = document.createElement("div")
  b.className = "tool-call-body"
  b.setAttribute("role", "region")
  b.setAttribute("aria-label", `Output of ${name}`)
  b.textContent = t("tool.initial")

  h.addEventListener("click", () => {
    h.querySelector(".tool-call-icon").classList.toggle("open")
    b.classList.toggle("open")
    h.setAttribute("aria-expanded", String(b.classList.contains("open")))
  })

  c.appendChild(h)
  c.appendChild(b)
  c.dataset.toolId = id || name  // fallback: findable via DOM query even if _toolRefs cleared
  ctx.currentBlock.appendChild(c)
  const ref = { h, b, name, id: id || name, startTime: Date.now() }
  ctx.currentTools.push(ref)
  ctx._toolRefs[id || name] = ref  // flat lookup — primary path
  scrollDown(ctx)
}

/** Last line of a tool result (CLI-style completion summary, ≤80 chars). */
function resultSummary(text) {
  const trimmed = (text || "").trim()
  if (!trimmed) return ""
  const last = trimmed.split("\n").filter(Boolean).pop() ?? ""
  return last.length > 80 ? last.slice(0, 79) + "…" : last
}

/** Update a tool card to its done state: elapsed ms, result summary, auto-expand, error tint. */
function finishToolCard(ref, text) {
  ref.b.textContent = text || ""
  const ms = Date.now() - (ref.startTime || Date.now())
  const isError = /^Error[:：]/.test((text || "").trim())
  const statusEl = ref.h.querySelector(".tool-call-status")
  if (statusEl) {
    if (isError) {
      statusEl.textContent = `${t("tool.error")} (${ms}ms)`
      statusEl.style.color = "#f14c4c"
    } else {
      statusEl.textContent = `${t("tool.done")} (${ms}ms)`
      statusEl.style.color = "#4ec9b0"
    }
  }
  // CLI parity: completion summary (last line) visible in the header
  const summary = resultSummary(text)
  let summaryEl = ref.h.querySelector(".tool-call-summary")
  if (summary) {
    if (!summaryEl) {
      summaryEl = document.createElement("span")
      summaryEl.className = "tool-call-summary"
      ref.h.appendChild(summaryEl)
    }
    summaryEl.textContent = "→ " + summary
    summaryEl.style.display = ""
  } else if (summaryEl) {
    summaryEl.style.display = "none"
  }
  // Auto-expand on completion (CLI parity: tool output is visible, not hidden)
  ref.b.classList.add("open")
  ref.h.querySelector(".tool-call-icon")?.classList.add("open")
  ref.h.setAttribute("aria-expanded", "true")
}

export function finishTool(ctx, name, id, text) {
  // Primary: O(1) flat lookup by tool_call_id
  const key = id || name
  const ref = ctx._toolRefs[key]
  if (ref) {
    finishToolCard(ref, text)
    ctx.hadToolResult = true
    return
  }
  // Fallback: DOM traversal for any reason the map missed
  const el = ctx.messagesEl.querySelector(`.tool-call[data-tool-id="${globalThis.CSS.escape(key)}"] .tool-call-status`)
  if (el) {
    const card = el.closest(".tool-call")
    const body = card?.querySelector(".tool-call-body")
    finishToolCard({ h: card, b: body, startTime: card?.dataset.startTime ? Number(card.dataset.startTime) : Date.now() }, text)
    ctx.hadToolResult = true
  }
}

// ─── Loading / Error ───────────────────────────

export function setLoading(ctx, on) {
  ctx.sendBtn.style.display = on ? "none" : "flex"
  ctx.abortBtn.style.display = on ? "flex" : "none"
  ctx.inputEl.disabled = on
  if (!on) ctx.inputEl.focus()
  ctx.isRunning = on
}

/** Historical tool call rendered from the human line (collapsed card, read-only). */
export function addToolHistory(ctx, name, text, idx) {
  const c = document.createElement("div")
  c.className = "tool-call"
  c.dataset.toolId = "hist-" + (idx ?? name)

  const h = document.createElement("div")
  h.className = "tool-call-header"
  h.tabIndex = 0
  h.setAttribute("role", "button")
  h.setAttribute("aria-expanded", "false")
  h.innerHTML =
    `<span class="tool-call-icon"></span>` +
    `<span class="tool-call-name">${esc(name)}</span>` +
    `<span class="tool-call-status" style="color:#4ec9b0">${t("tool.done")}</span>` +
    (resultSummary(text) ? `<span class="tool-call-summary">→ ${esc(resultSummary(text))}</span>` : "") +
    (idx !== undefined ? `<button class="msg-del-btn" data-idx="${idx}" title="${t("msg.deleteTitle")}">✕</button>` : "")

  const b = document.createElement("div")
  b.className = "tool-call-body"
  b.setAttribute("role", "region")
  b.setAttribute("aria-label", `Output of ${name}`)
  b.textContent = text || ""

  h.addEventListener("click", (e) => {
    if (e.target.closest(".msg-del-btn")) return
    h.querySelector(".tool-call-icon").classList.toggle("open")
    b.classList.toggle("open")
    h.setAttribute("aria-expanded", String(b.classList.contains("open")))
  })

  c.appendChild(h)
  c.appendChild(b)
  ctx.messagesEl.appendChild(c)
  scrollDown(ctx)
}

export function showError(ctx, text, techInfo) {
  if (!ctx.currentBlock) newBlock(ctx)
  const err = document.createElement("div")
  err.className = "error-banner"
  let html = `<div class="error-text">${escHtml(text)}</div>`
  if (techInfo) html += `<details class="error-details"><summary>Details</summary><pre>${escHtml(techInfo)}</pre></details>`
  html += `<button class="error-retry-btn">${t("error.retry")}</button>`
  err.innerHTML = html
  err.querySelector(".error-retry-btn").addEventListener("click", () => {
    ctx.vscode.postMessage({ type: "retry" })
  })
  ctx.currentBlock.appendChild(err)
  scrollDown(ctx)
}

export function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function scrollDown(ctx) {
  ctx.messagesEl.scrollTop = ctx.messagesEl.scrollHeight
}
