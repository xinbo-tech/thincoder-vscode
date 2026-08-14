/**
 * permission-gate.mjs — the per-turn tool permission gate.
 *
 * Two sources of truth: the `autoApprove` session-slot snapshot taken when a turn
 * starts (persisted, cross-turn) and the live `panel._autoApprove` flag that
 * approve-all / the AUTO toolbar button flip MID-TURN. runAgent receives the
 * startup snapshot (as a getter), which cannot change while the agent loop is
 * running — so the gate re-checks the live flag on every invocation. Without
 * this, clicking "Approve All" only clears the currently queued prompts and
 * every later tool call of the SAME turn asks again.
 */

/**
 * Build the permission gate for one turn. Returns undefined when autoApprove is
 * already on (no gate at all — execute-tools skips the permission check), else
 * a callback that re-checks the live flag before prompting.
 * @param {{ _autoApprove: boolean, _permissionQueue: {resolve: Function}[], _panel?: { webview: { postMessage: Function } } }} panel
 */
export function permissionGate(panel) {
  if (panel._autoApprove) return undefined
  return (toolName, args, diffInfo) => new Promise((resolve) => {
    // Re-check on every invocation: approve-all / AUTO may have flipped the
    // flag after this gate was built. Honoring it immediately stops repeated
    // permission prompts for the rest of the running turn.
    if (panel._autoApprove) { resolve(true); return }
    const entry = { resolve, toolName }
    panel._permissionQueue.push(entry)
    panel._setStatus?.("waiting")
    panel._panel?.webview.postMessage({ type: "permissionRequest", tool: toolName, args: JSON.stringify(args, null, 2), diff: diffInfo })
    // Stop must release a permission-parked turn — otherwise the loop hangs on
    // this promise until the user answers the (now irrelevant) prompt.
    const onAbort = () => {
      const i = panel._permissionQueue.indexOf(entry)
      if (i >= 0) panel._permissionQueue.splice(i, 1)
      resolve(false)
    }
    const sig = panel._abortController?.signal
    if (sig?.aborted) onAbort()
    else sig?.addEventListener("abort", onAbort, { once: true })
  })
}
