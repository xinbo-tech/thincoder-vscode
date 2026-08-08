/**
 * execute-tools.mjs — tool batch execution (split out of agent.mjs for the 500-line limit).
 * Groups tool calls into parallel batches (readonly / subagent), runs them with guards
 * (plan mode, engineering design gates, permission), commits results to both history lines,
 * and tracks mutations / advisor-verify bookkeeping / stall detection.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  FILE_MUTATORS, STALL_WINDOW, STALL_THRESHOLD, MAX_PARALLEL_SUBAGENTS,
  offloadToolResult, pushReal, runWithLimit,
} from "./run-helpers.mjs"
import { isDocFile } from "../advisor/repos.mjs"

/**
 * Execute the tool calls of one assistant turn.
 * Batches: consecutive readonly tools run in parallel; consecutive subagent calls also run
 * in parallel (each has its own agent). sideEffectExempt tools (like subagent) don't block
 * readonly merging. Batch order is serial — results are committed in call order.
 */
export async function executeToolBatches(agent, { response, history, fullHistory, toolByName, autoApprove, callbacks, signal, cwd, recentSigs, depth }) {
  // Group tool calls into batches — consecutive readonly tools run in parallel,
  // consecutive subagent calls also run in parallel (each has its own agent).
  // sideEffectExempt tools (like subagent) don't block readonly merging.
  const batches = []
  let pendingReadonly = []
  for (const tc of response.toolCalls) {
    const tool = toolByName.get(tc.name)
    if (tool?.readonly) {
      pendingReadonly.push({ tc, tool })
    } else {
      // Flush pending readonly batch before this mutation
      if (pendingReadonly.length > 0) { batches.push(pendingReadonly); pendingReadonly = [] }
      if (tool?.name === "subagent") {
        // Subagents run in parallel with each other
        const last = batches[batches.length - 1]
        if (last?.length > 0 && last[0]?.tool?.name === "subagent") {
          last.push({ tc, tool })
        } else {
          batches.push([{ tc, tool }])
        }
      } else {
        batches.push([{ tc, tool }])
      }
    }
  }
  if (pendingReadonly.length > 0) batches.push(pendingReadonly)

  // Execute batches in order (parallel within batch, serial between batches)
  for (const batch of batches) {
    const runOne = async ({ tc, tool }) => {
      const toolName = tc.name
      let args
      try { args = JSON.parse(tc.arguments || "{}") } catch {
        return { tool_call_id: tc.id, toolName, content: "Error: invalid JSON", meta: null }
      }

      // Plan mode guard
      if (agent._planMode && tool && !tool.readonly) {
        return { tool_call_id: tc.id, toolName, content: "Error: plan mode active", meta: null }
      }

      // Engineering coder hard gate: no file modification before the design review passed (CLI dispatch.mjs parity).
      if (agent._role === "eng-coder" && agent.config?.agent?.engineering
          && !agent._engDesignReviewed && FILE_MUTATORS.has(toolName)) {
        return { tool_call_id: tc.id, toolName, content: "Error: engineering design gate — call advisor with type='design' to review the design document before any file modification. If the review found issues, report them to the parent agent.", meta: null }
      }

      // Engineering mode PARENT gate: no code-file writes before the design review passed.
      // Docs/** and root-level docs are exempt (writing them IS the design step); everything
      // under src/ (incl. src/prompts/*.md) is product code and needs a design token.
      if (agent.config?.agent?.engineering && depth === 0 && !agent._engDesignToken
          && FILE_MUTATORS.has(toolName)) {
        const paths = tool.touchedPaths ? tool.touchedPaths(args) : [args.path]
        // Unknown/missing paths are treated as code — block conservatively.
        const touchesCode = paths.some((p) => typeof p !== "string" || /^src[\\/]/.test(p) || !isDocFile(p))
        if (touchesCode) {
          return { tool_call_id: tc.id, toolName, content: "Error: engineering design gate — write the design document in docs/ first, then call advisor with type='design' to review it, and wait for user approval. Implementation is done by eng-coder subagents.", meta: null }
        }
      }

      // Permission gate: any non-readonly tool at depth 0 in manual mode
      if (!autoApprove && tool && !tool.readonly && depth === 0 && callbacks.onPermissionRequired) {
        // Compute diff preview for file-based tools
        let diffInfo = null
        if (toolName !== "bash" && args.path) {
          try {
            const abs = join(cwd, args.path)
            const oldContent = existsSync(abs) ? readFileSync(abs, "utf8") : ""
            let newContent = ""
            if (toolName === "write") {
              newContent = args.content || ""
            } else if (toolName === "edit") {
              if (args.replace_all) {
                newContent = oldContent.replaceAll(args.old_string, args.new_string)
              } else {
                newContent = oldContent.replace(args.old_string, args.new_string)
              }
            } else if (toolName === "insert_after") {
              const lines = oldContent.split("\n")
              let target = (args.after_line != null) ? args.after_line : lines.length
              if (target < 0) target = 0
              if (target > lines.length) target = lines.length
              lines.splice(target, 0, args.content || "")
              newContent = lines.join("\n")
            } else if (toolName === "delete") {
              newContent = "" // deletion — show all as removed
            }
            // apply_patch — too complex to preview inline, skip diff
            if (newContent !== oldContent) {
              diffInfo = { old: oldContent, new: newContent, path: args.path }
            }
          } catch { /* best-effort — permission still works without diff */ }
        }
        const approved = await callbacks.onPermissionRequired(toolName, args, diffInfo)
        if (!approved) return { tool_call_id: tc.id, toolName, content: "Denied by user (permission mode).", meta: null }
      }

      if (depth === 0) callbacks.onToolCall?.(toolName, args, tc.id)

      let result
      if (!tool) {
        result = `Error: unknown tool "${toolName}"`
      } else {
        try {
          const raw = await tool.execute(args, { cwd, agent, callbacks, signal })
          result = String(raw)

          // Multimodal tools
          if (tool.multimodal) {
            try {
              const parsed = JSON.parse(result)
              if (parsed.images?.length) {
                return { tool_call_id: tc.id, toolName, content: parsed.text, multimodal: { text: parsed.text, images: parsed.images } }
              }
            } catch { /* fall through */ }
          }
        } catch (e) {
          result = `Error: ${e.message}`
        }
      }

      // Truncate large results: save to disk so agent can read with read tool
      result = offloadToolResult(cwd, result)

      return {
        tool_call_id: tc.id, toolName, content: result,
        meta: { args, tool, tc },
      }
    }

    // Concurrency limit for subagent batches
    const isSubagentBatch = batch.length > 0 && batch[0]?.tool?.name === "subagent"
    const results = isSubagentBatch
      ? await runWithLimit(batch, runOne, MAX_PARALLEL_SUBAGENTS)
      : await Promise.all(batch.map(runOne))

    for (const r of results) {
      const { tool_call_id, toolName, content, multimodal, meta } = r

      if (multimodal) {
        pushReal(history, fullHistory, { role: "tool", tool_call_id, content: multimodal.text })
        pushReal(history, fullHistory, { role: "user", content: [{ type: "text", text: multimodal.text }, ...multimodal.images] })
        if (depth === 0) callbacks.onToolResult?.(toolName, multimodal.text, tool_call_id)
      } else {
        pushReal(history, fullHistory, { role: "tool", tool_call_id, content })
        if (depth === 0) callbacks.onToolResult?.(toolName, content, tool_call_id)
      }

      // Track mutations + advisor/verify bookkeeping (CLI parity)
      if (meta) {
        const { args, tool } = meta
        if (FILE_MUTATORS.has(toolName)) {
          // Direct file edit — code was changed. The prior advisor review and
          // verify are stale: a review that ran before the edit no longer
          // covers the current file state (user decision 2026-08-08: the review
          // is triggered by CODE MUTATIONS only).
          agent._mutatedThisRun = true
          agent._calledAdvisorThisRun = false
          agent._verifiedThisRun = false
          agent._verifyPassed = undefined
          const paths = tool.touchedPaths ? tool.touchedPaths(args) : [args?.path]
          for (const p of paths) {
            if (typeof p !== "string") continue
            const abs = join(cwd, p)
            if (!agent._touchedFiles.includes(abs)) agent._touchedFiles.push(abs)
          }
        } else if (tool && !tool.readonly && !tool.sideEffectExempt) {
          // Non-mutating side-effect tools (bash, git): do NOT invalidate the
          // advisor review — a review is triggered by code mutations only
          // (user decision 2026-08-08; bash is barred from writing files, so
          // it cannot change the reviewed code). Verify IS invalidated: its
          // state snapshot (git diff, file list) may be stale.
          if (agent._verifiedThisRun) {
            agent._verifiedThisRun = false
            agent._verifyPassed = undefined
          }
        }
        if (toolName === "verify") agent._verifiedThisRun = true
        if (toolName === "advisor") {
          agent._calledAdvisorThisRun = true
          // Design reviews are a separate gate with no convergence protocol —
          // they must not consume code-review rounds. A failed/interrupted review
          // still counts as an attempt (next retry uses the next round's prompt).
          try {
            if (args.type !== "design") agent._advisorRound++
          } catch {
            agent._advisorRound++
          }
        }
      }

      // Stall detection (stable serialization)
      try {
        const sig = `${toolName}:${meta?.args ? JSON.stringify(meta.args, Object.keys(meta.args).sort()) : ""}`
        recentSigs.push(sig)
        if (recentSigs.length > STALL_WINDOW) recentSigs.shift()
        if (recentSigs.length >= STALL_THRESHOLD) {
          const tail = recentSigs.slice(-STALL_THRESHOLD)
          if (tail[0] === tail[1] && tail[1] === tail[2]) {
            history.push({
              role: "user",
              content: `[System reminder: identical call (${sig.slice(0, 100)}) 3× in a row — you may be stuck. Change approach.]`,
            })
            recentSigs.length = 0
          }
        }
      } catch { /* */ }
    }
  }
}
