/**
 * ui.js — DOM helpers for the chat panel
 * All functions take `ctx` which provides DOM refs and mutable state.
 */

import { md, mdInline, esc } from "./md.js"

// ─── Welcome / Banner ──────────────────────────

export function showWelcome(ctx) {
  const el = document.createElement("div")
  el.className = "welcome"
  el.innerHTML = `<h2>ThinCoder</h2><p>Ask me to read, write, search, or explain code in this workspace.</p>`
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

export function addUser(ctx, text) {
  const el = document.createElement("div")
  el.className = "message user"
  el.innerHTML = `<div class="msg-label">❯ You:</div><div class="bubble">${mdInline(esc(text))}</div>`
  ctx.messagesEl.appendChild(el)
  scrollDown(ctx)
}

export function addAssistantHistory(ctx, text) {
  const el = document.createElement("div")
  el.className = "message assistant"
  el.innerHTML = `<div class="msg-label">❯ ThinCoder:</div><div class="bubble content">${md(text)}</div>`
  ctx.messagesEl.appendChild(el)
  scrollDown(ctx)
}

export function newBlock(ctx) {
  ctx.currentTools = []
  ctx.currentBubble = null
  ctx.currentRaw = ""
  ctx.currentBlock = document.createElement("div")
  ctx.currentBlock.className = "message assistant"
  ctx.currentBlock.innerHTML = `<div class="msg-label">❯ ThinCoder:</div>`
  ctx.messagesEl.appendChild(ctx.currentBlock)
}

export function addTool(ctx, name, args) {
  if (!ctx.currentBlock) newBlock(ctx)
  ctx.hadToolResult = false

  const c = document.createElement("div")
  c.className = "tool-call"

  const h = document.createElement("div")
  h.className = "tool-call-header"
  h.innerHTML =
    `<span class="tool-call-icon"></span>` +
    `<span class="tool-call-name">${esc(name)}</span>` +
    `<span class="tool-call-args">${esc(args.slice(0, 80))}</span>` +
    `<span class="tool-call-status">running…</span>`

  const b = document.createElement("div")
  b.className = "tool-call-body"
  b.textContent = "Running…"

  h.addEventListener("click", () => {
    h.querySelector(".tool-call-icon").classList.toggle("open")
    b.classList.toggle("open")
  })

  c.appendChild(h)
  c.appendChild(b)
  ctx.currentBlock.appendChild(c)
  ctx.currentTools.push({ h, b, name })
  scrollDown(ctx)
}

export function finishTool(ctx, name, text) {
  const t = ctx.currentTools.find((x) => x.name === name)
  if (!t) return
  t.b.textContent = text
  t.h.querySelector(".tool-call-status").textContent = "done"
  t.h.querySelector(".tool-call-status").style.color = "#4ec9b0"
  ctx.hadToolResult = true
}

// ─── Loading / Error ───────────────────────────

export function setLoading(ctx, on) {
  ctx.sendBtn.style.display = on ? "none" : "flex"
  ctx.abortBtn.style.display = on ? "flex" : "none"
  ctx.inputEl.disabled = on
  if (!on) ctx.inputEl.focus()
  ctx.isRunning = on
}

export function showError(ctx, text) {
  if (!ctx.currentBlock) newBlock(ctx)
  const err = document.createElement("div")
  err.className = "error-banner"
  err.textContent = text
  ctx.currentBlock.appendChild(err)
  scrollDown(ctx)
}

export function scrollDown(ctx) {
  ctx.messagesEl.scrollTop = ctx.messagesEl.scrollHeight
}
