/**
 * send.js — the send path: input history bookkeeping, turn-start state, panel
 * reset, and the userMessage post.
 */
import { ctx, vscode, S } from "./state.js"
import { t } from "./i18n.js"
import { addUser, setLoading } from "./ui.js"
import { clearPanels } from "./panels.js"

export function send() {
  const text = ctx.inputEl.value.trim()
  if (!text || ctx.isRunning) return
  const h = ctx._inputHistory
  if (h[h.length - 1] !== text) h.push(text) // dedupe consecutive repeats
  ctx._historyIdx = -1
  ctx._inputDraft = ""
  S._turnStart = Date.now()
  S._llmCalls = 0
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
