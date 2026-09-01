/**
 * permission.js — the permissionRequest prompt: approve / approve-all / deny,
 * with apply_patch approval preview (+/- coloring) and a native-diff-viewer
 * handoff for large diffs.
 */
import { vscode } from "./state.js"
import { t } from "./i18n.js"
import { patchLineType } from "./lib.js"
import { renderDiff, lineDiff } from "./diff.js"
import { escHtml } from "./ui.js"

/**
 * Render a raw unified diff (apply_patch approval preview) with +/- coloring.
 * Hunk headers (@@, diff --git, ---/+++) stay neutral; only content lines colored.
 */
function renderPatch(patch) {
  const lines = String(patch || "").split("\n").map((l) => ({ type: patchLineType(l), text: l }))
  return renderDiff(lines)
}

export function showPermissionRequest(m) {
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
}


/**
 * §16 D-B1 merged batch-approval row: "N tools need permission: A、B、C" with
 * approve-all / one-by-one / deny. One ask covers the whole batch — no click fatigue.
 * approveAll → whole batch runs; oneByOne → the extension falls back to per-item cards;
 * deny → whole batch refused (no second ask).
 */
export function showBatchPermissionRequest(m) {
  const el = document.createElement("div")
  el.className = "permission-prompt"
  el.setAttribute("role", "alert")
  const names = (m.tools ?? []).map((t) => escHtml(t?.name ?? "?")).join(", ")
  let html =
    '<div class="permission-prompt-text">' +
    t("perm.batch.wantsTo", { count: String(m.count ?? (m.tools ?? []).length), names }) +
    "</div>"
  html += '<div class="permission-prompt-actions">'
  html += '<button class="approve-all">' + t("perm.approveAll") + "</button>"
  html += '<button class="one-by-one">' + t("perm.batch.oneByOne") + "</button>"
  html += '<button class="deny">' + t("perm.deny") + "</button>"
  html += "</div>"
  el.innerHTML = html
  el.querySelector(".approve-all").addEventListener("click", () => {
    el.remove()
    vscode.postMessage({ type: "batchPermissionResponse", choice: "approveAll" })
  })
  el.querySelector(".one-by-one").addEventListener("click", () => {
    el.remove()
    vscode.postMessage({ type: "batchPermissionResponse", choice: "oneByOne" })
  })
  el.querySelector(".deny").addEventListener("click", () => {
    el.remove()
    vscode.postMessage({ type: "batchPermissionResponse", choice: "deny" })
  })
  document.getElementById("messages").appendChild(el)
  el.scrollIntoView({ behavior: "smooth" })
  // Focus the deny button (safest default)
  setTimeout(() => el.querySelector(".deny")?.focus(), 50)
}
