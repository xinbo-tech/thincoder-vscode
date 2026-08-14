/**
 * ui.js — DOM helpers for the chat panel
 * All functions take `ctx` which provides DOM refs and mutable state.
 */

import { md, mdInline, esc } from "./md.js"
import { fmtTime } from "./lib.js"
import { t } from "./i18n.js"

// ─── Advisor review block (in-conversation, reasoning-style) ──

/**
 * Create the details block that streams an advisor review into the conversation.
 * `roundLabel` is the summary text (e.g. "Advisor Review (Round 2)").
 */
export function buildAdvisorBlock(roundLabel) {
  const details = document.createElement("details")
  details.className = "advisor-block"
  details.open = true
  const summary = document.createElement("summary")
  summary.textContent = roundLabel
  const content = document.createElement("div")
  content.className = "advisor-content"
  details.appendChild(summary)
  details.appendChild(content)
  return details
}

/**
 * Append one advisor progress chunk ({ kind: "think"|"tool"|"text", text }) to
 * the block's scrolling content region. Same-kind text runs merge; nothing is
 * ever truncated — the full review stays in the block (scrolling).
 */
export function appendAdvisorChunk(block, kind, text) {
  const content = block.querySelector(".advisor-content")
  if (!content) return
  const str = String(text ?? "")
  if (!str) return
  if (kind === "tool") {
    const line = document.createElement("div")
    line.className = "advisor-tool-line"
    line.textContent = str
    content.appendChild(line)
    return
  }
  const k = kind ?? "text"
  const last = content.lastElementChild
  if (last && last.classList.contains("advisor-text") && last.dataset.kind === k) {
    last.textContent += str
  } else {
    const div = document.createElement("div")
    div.className = "advisor-text" + (k === "think" ? " advisor-think" : "")
    div.dataset.kind = k
    div.textContent = str
    content.appendChild(div)
  }
}

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

/** Historical user message. `idx` (when set) is stored as data-idx on the element
 *  for lazy-load paging (minLoadedIdx) — no action buttons on messages. */
export function buildUserMessage(ctx, text, timestamp, idx) {
  const el = document.createElement("div")
  el.className = "message user"
  const ts = timestamp ? fmtTime(new Date(timestamp)) : fmtTime(new Date())
  if (idx !== undefined) el.dataset.idx = String(idx)
  el.innerHTML = `<div class="msg-label">❯ ${t("msg.user")}: <span class="msg-time">${ts}</span></div><div class="bubble">${mdInline(esc(text))}</div>`
  return el
}

export function addUser(ctx, text, timestamp, idx) {
  ctx.assistantLabeled = false // new turn — the next assistant label is allowed once
  ctx.messagesEl.appendChild(buildUserMessage(ctx, text, timestamp, idx))
  scrollDown(ctx)
}

/** Historical assistant message. The "❯ ThinCoder:" label is painted ONLY when
 *  `turnStart` (one label per turn — CLI parity); mid-turn segments render the
 *  content alone. `idx` stored as data-idx for lazy-load paging. */
export function buildAssistantHistory(ctx, text, timestamp, idx, turnStart = true) {
  const el = document.createElement("div")
  el.className = "message assistant"
  const ts = timestamp ? fmtTime(new Date(timestamp)) : ""
  if (idx !== undefined) el.dataset.idx = String(idx)
  const label = turnStart ? `<div class="msg-label">❯ ${t("msg.assistant")}: ${ts ? `<span class="msg-time">${ts}</span>` : ""}</div>` : ""
  el.innerHTML = `${label}<div class="bubble content">${md(text)}</div>`
  return el
}

export function addAssistantHistory(ctx, text, timestamp, idx) {
  ctx.messagesEl.appendChild(buildAssistantHistory(ctx, text, timestamp, idx))
  scrollDown(ctx)
}

export function newBlock(ctx) {
  ctx.currentTools = []
  ctx.currentBubble = null
  ctx.currentRaw = ""
  ctx.currentBlock = document.createElement("div")
  ctx.currentBlock.className = "message assistant"
  // One "❯ ThinCoder:" per turn (CLI ensureAssistantLabel parity): only the
  // turn's FIRST block carries the label; segments after tool batches start
  // fresh blocks but must not paint a second label.
  if (!ctx.assistantLabeled) {
    ctx.assistantLabeled = true
    ctx.currentBlock.innerHTML = `<div class="msg-label">❯ ${t("msg.assistant")}:</div>`
  }
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

/** Update a tool card to its done state: elapsed ms, result summary, collapse/expand, error tint. */
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
  // Auto-collapse on success: the header already shows the → summary, so a finished
  // card folds up to one line (CLI outputPanel parity). Errors stay EXPANDED — the
  // user must see what failed without an extra click.
  if (isError) {
    ref.b.classList.add("open")
    ref.h.querySelector(".tool-call-icon")?.classList.add("open")
    ref.h.setAttribute("aria-expanded", "true")
  } else {
    ref.b.classList.remove("open")
    ref.h.querySelector(".tool-call-icon")?.classList.remove("open")
    ref.h.setAttribute("aria-expanded", "false")
  }
}

export function finishTool(ctx, name, id, text) {
  // Primary: O(1) flat lookup by tool_call_id
  const key = id || name
  const ref = ctx._toolRefs[key]
  if (ref) {
    finishToolCard(ref, text)
    ctx.hadToolResult = true
    scrollDown(ctx) // the auto-expanded output must scroll into view, not sit below the fold
    return
  }
  // Fallback: DOM traversal for any reason the map missed
  const el = ctx.messagesEl.querySelector(`.tool-call[data-tool-id="${globalThis.CSS.escape(key)}"] .tool-call-status`)
  if (el) {
    const card = el.closest(".tool-call")
    const body = card?.querySelector(".tool-call-body")
    finishToolCard({ h: card, b: body, startTime: card?.dataset.startTime ? Number(card.dataset.startTime) : Date.now() }, text)
    ctx.hadToolResult = true
    scrollDown(ctx)
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
export function buildToolHistory(ctx, name, text, idx) {
  const c = document.createElement("div")
  c.className = "tool-call"
  c.dataset.toolId = "hist-" + (idx ?? name)

  const h = document.createElement("div")
  h.className = "tool-call-header"
  h.tabIndex = 0
  h.setAttribute("role", "button")
  h.setAttribute("aria-expanded", "false")
  if (idx !== undefined) c.dataset.idx = String(idx) // lazy-load paging (minLoadedIdx)
  h.innerHTML =
    `<span class="tool-call-icon"></span>` +
    `<span class="tool-call-name">${esc(name)}</span>` +
    `<span class="tool-call-status" style="color:#4ec9b0">${t("tool.done")}</span>` +
    (resultSummary(text) ? `<span class="tool-call-summary">→ ${esc(resultSummary(text))}</span>` : "")

  const b = document.createElement("div")
  b.className = "tool-call-body"
  b.setAttribute("role", "region")
  b.setAttribute("aria-label", `Output of ${name}`)
  b.textContent = text || ""

  h.addEventListener("click", () => {
    h.querySelector(".tool-call-icon").classList.toggle("open")
    b.classList.toggle("open")
    h.setAttribute("aria-expanded", String(b.classList.contains("open")))
  })

  c.appendChild(h)
  c.appendChild(b)
  return c
}

export function addToolHistory(ctx, name, text, idx) {
  ctx.messagesEl.appendChild(buildToolHistory(ctx, name, text, idx))
  scrollDown(ctx)
}

/**
 * Build one history element from a historyPage message ({ kind, text, name,
 * timestamp, idx }) — the lazy-loading counterpart of the eager per-message
 * loaders above. Returns null for kinds the UI does not render.
 */
export function buildHistoryMessage(ctx, msg) {
  if (!msg) return null
  if (msg.kind === "user") return buildUserMessage(ctx, msg.text, msg.timestamp, msg.idx)
  if (msg.kind === "assistant") return buildAssistantHistory(ctx, msg.text, msg.timestamp, msg.idx, msg.turnStart !== false)
  if (msg.kind === "tool") return buildToolHistory(ctx, msg.name ?? "tool", msg.text, msg.idx)
  return null
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
