/**
 * panels.js — side panels: task progress, subagents/consultants, goal.
 * Owns the auto-clean interval and the taskProgress / subagent / goal message
 * handlers.
 */
import { S } from "./state.js"
import { t } from "./i18n.js"
import { escHtml } from "./ui.js"
import { renderStatusBar } from "./status-bar.js"

export function renderTaskPanel() {
  const panel = document.getElementById("task-panel")
  if (!S._taskProgress || !S._taskProgress.items || S._taskProgress.items.length === 0) {
    panel.style.display = "none"
    return
  }
  const allDone = S._taskProgress.items.every((item) => item.status === "done")
  if (allDone && panel.style.display !== "block") {
    // Don't show — badge already says ✓N/N, no need for the panel
    return
  }
  const icons = { pending: "○", in_progress: "◉", done: "✓" }
  panel.innerHTML = `<div class="panel-desc">${t("panel.taskDesc") || "Tracks multi-step work — created and updated by the agent"}</div>` +
    S._taskProgress.items.map((item) =>
    `<div class="task-item">
      <span class="task-mark">${icons[item.status] || " "}</span>
      <span class="task-title">${escHtml(item.title)}</span>
      <span class="task-status">${item.status === "in_progress" ? t("task.in_progress") : item.status}</span>
    </div>`
  ).join("")
  panel.style.display = "block"
}

export function renderSubagentPanel() {
  const panel = document.getElementById("subagent-panel")
  const subs = Object.values(S._subagentMap)
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

export function renderGoalPanel() {
  const panel = document.getElementById("goal-panel")
  if (!S._goalInfo) { panel.style.display = "none"; return }
  const g = S._goalInfo
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

export function clearPanels() {
  S._subagentMap = {}
  S._goalInfo = null
  S._taskProgress = null
  S._taskStatus = null
  document.getElementById("subagent-panel").style.display = "none"
  document.getElementById("goal-panel").style.display = "none"
  document.getElementById("task-panel").style.display = "none"
}

function autoCleanPanels() {
  // Remove finished subagents/consultants after a short linger
  const now = Date.now()
  for (const [id, s] of Object.entries(S._subagentMap)) {
    // consult cards linger 60s — the answered reply preview is the consultation's core
    // output; 3s (plain subagents) would delete it before the user looks up.
    const linger = s.role === "consult" ? 60000 : 3000
    const lingerErr = s.role === "consult" ? 60000 : 5000
    if ((s.status === "done" || s.status === "answered" || s.status === "terminated") && s.doneAt && now - s.doneAt > linger) delete S._subagentMap[id]
    if ((s.status === "error" || s.status === "failed") && s.doneAt && now - s.doneAt > lingerErr) delete S._subagentMap[id]
  }
  renderSubagentPanel()
  // Refresh elapsed seconds while a turn is running (CLI 1s ticker parity)
  if (S._turnStart) renderStatusBar()
}

// Auto-clean panel entries (done subagents after 3s, tool panels after 10s)
// Panel cleanup interval. The webview has no teardown path today (it lives for
// the panel's lifetime and dies with it), but the ID is captured so a future
// dispose/visibility-hidden handler can clear it.
const _panelTimer = setInterval(autoCleanPanels, 2000)
// Webview lifetime == panel lifetime, but clear on unload so a future
// teardown/dispose path cannot leak the interval.
window.addEventListener("unload", () => clearInterval(_panelTimer))

/** taskProgress message: update the badge text + panel. */
export function handleTaskProgress(m) {
  const p = m.pending ?? 0, ip = m.inProgress ?? 0, d = m.done ?? 0
  S._taskProgress = m
  if (m.total > 0) S._taskStatus = `✓${d}/${m.total}${ip > 0 ? ` ·${ip}` : ""}${p > 0 ? ` …${p}` : ""}`
  else S._taskStatus = null
  renderTaskPanel()
  renderStatusBar()
}

/** subagent message: track lifecycle; collapse consult blocks on terminal state. */
export function handleSubagentMessage(m) {
  if (m.status === "started") {
    S._subagentMap[m.id] = { role: m.role, status: "started", startedAt: m.startedAt || Date.now(), tool: null, model: m.model ?? null }
  } else {
    const s = S._subagentMap[m.id]
    if (s) { s.status = m.status; s.doneAt = Date.now(); if (m.error) s.error = m.error; if (m.replyPreview) s.replyPreview = m.replyPreview }
    // Consult terminal state → collapse its activity block (consult-UI review 2026-08-15;
    // the "collapses when done" comment was a promise the code never kept).
    if (m.role === "consult" && m.model && m.status !== "started") {
      const block = S._subBlocks.get(`sub:consult ${m.model} #${m.sessionId}`)
      if (block) block.open = false
    }
  }
  renderSubagentPanel()
  renderStatusBar()
}

/** goal message: refresh the goal panel + status badge. */
export function handleGoalMessage(m) {
  S._goalInfo = m
  renderGoalPanel()
  renderStatusBar()
}
