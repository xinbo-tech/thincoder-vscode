/**
 * advisor/history.mjs — advisor history extraction: issue/response tables and conversation background.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const ADVISOR_MD_PATH = ".thincoder/advisor.md"
export const ADVISOR_TABLE_HEADER = "| # | File | Severity | Issue | Suggestion |"
export const CONVERGENCE_TABLE_HEADER = "| # | Orig# | File | Severity | Status | Notes |"
export const AGENT_RESPONSE_HEADER = "| # | Action | Detail |"
export const LEGACY_ADVISOR_HEADER = "| # | 文件 | 严重程度 | 问题描述 | 建议修复 |"

const DEFAULT_CRITERIA = `Review the code changes, focusing on:
1. Correctness: logic errors, edge cases, off-by-one, incomplete modifications
2. Security: unhandled exceptions, null references, resource leaks, race conditions
3. Consistency: alignment with existing project patterns and conventions
4. Completeness: missing callers, imports, or follow-up changes
5. Maintainability: vague naming, missing comments, overly complex logic`

/**
 * Extract the most recent advisor review table from history.
 * Returns { text, sinceIdx } where sinceIdx is the index of the advisor call's
 * own history entry — extractAgentResponseTable skips it (role is "tool", not
 * "assistant") and scans forward for the agent's response table.
 * Returns null when: no advisor call, empty output, or the last review is
 * all-clear (nothing to follow up on).
 */
export function extractPriorIssueTable(history) {
  // allClear: exact phrases the prompts instruct the advisor to use on a clean review.
  // NOTE: "已修复" (Fixed) is NOT here — it's a per-row Status value in convergence tables,
  // and a mixed table must continue convergence even if some rows are Fixed.
  const allClear = ["no 🔴", "all clear", "全部通过", "review passed", "no issues found", "no new issues"]
  // Negative signals: a table listing SOME items as unfixed is NOT all-clear.
  // Applied when the message carries a Status column (English or Chinese convergence
  // format) — "failed"/"❌" in a round-1 Issue description must NOT trigger it.
  const partiallyFixedRe = /\bunfixed\b|未修复|❌|\bfailed\b/i
  const entries = Array.isArray(history) ? history : []

  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i]
    if (m.role !== "tool" || typeof m.content !== "string") continue
    // Only review outputs carry one of these table headers. Matched at LINE START:
    // an `includes()` match would also fire on advisor output that quotes the
    // header constants' own source code (e.g. history.mjs), producing a phantom
    // "prior issue table" and re-opening convergence rounds against stale data.
    if (!lineHasHeader(m.content, ADVISOR_TABLE_HEADER)
      && !lineHasHeader(m.content, CONVERGENCE_TABLE_HEADER)
      && !lineHasHeader(m.content, LEGACY_ADVISOR_HEADER)) continue
    const text = m.content
    const lower = text.toLowerCase()
    // Has a Status column? (English convergence format or any table with a Status-like
    // column) — Chinese legacy tables lack it, but they are issue tables, not convergence.
    const hasStatusColumn = lineHasHeader(text, CONVERGENCE_TABLE_HEADER)
      || /Status|状态/.test(text.slice(0, text.indexOf("\n") + 1))
    if (hasStatusColumn && partiallyFixedRe.test(lower)) return { text, sinceIdx: i }
    if (allClear.some((s) => lower.includes(s))) return null
    // sinceIdx = the advisor call's own index; extractAgentResponseTable skips it (role !== assistant)
    return { text, sinceIdx: i }
  }
  return null
}

/** True when some line of `text` starts with `header` — table headers always sit at line start. */
function lineHasHeader(text, header) {
  return text.split("\n").some((l) => l.trimStart().startsWith(header))
}

/**
 * Extract the agent's response table (| # | Action | Detail |) that follows
 * the advisor review. Returns null when missing or no advisor review precedes.
 */
export function extractAgentResponseTable(history, sinceIdx) {
  const entries = Array.isArray(history) ? history : []
  for (let i = sinceIdx ?? 0; i < entries.length; i++) {
    const m = entries[i]
    if (m.role !== "assistant" || typeof m.content !== "string") continue
    if (m.content.includes(AGENT_RESPONSE_HEADER)) return m.content
  }
  return null
}

/**
 * Load review criteria: project .thincoder/advisor.md if present,
 * otherwise the built-in defaults.
 */
export function loadAdvisorMd(cwd) {
  try {
    return readFileSync(join(cwd, ADVISOR_MD_PATH), "utf8")
  } catch {
    return DEFAULT_CRITERIA
  }
}

/** Extract recent user↔assistant exchanges (up to maxTurns) for intent context. */
export function extractConversationBackground(history, maxTurns = 3) {
  const entries = Array.isArray(history) ? history : []
  const lines = []
  let turns = 0
  for (let i = entries.length - 1; i >= 0 && turns < maxTurns; i--) {
    const m = entries[i]
    if (m.role === "tool" || m.role === "system") continue
    if (typeof m.content !== "string") continue
    if (m.content.startsWith("[System reminder:") || m.content.startsWith("[System mode:") || m.content.startsWith("[Relevant memories")) continue
    // ^ [System mode:] is not currently generated anywhere — kept as forward-looking
    // defensive filtering in case convergence messages ever adopt a different prefix.
    if (m.role === "user" || m.role === "assistant") {
      lines.unshift(`${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 400)}`)
      if (m.role === "user") turns++
    }
  }
  return lines.length > 0 ? lines.join("\n\n") : null
}
