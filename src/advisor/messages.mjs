/**
 * advisor/messages.mjs — advisor user-message building (buildAdvisorUserMessage).
 * Split out of advisor.mjs to keep it under the 300-line advisory threshold
 * (.thincoder/advisor.md). System prompts live in advisor.mjs / prompts/.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { findReviewRepos, collectRepoSnapshots, collectChangedFiles } from "./repos.mjs"
import { loadAdvisorMd, extractConversationBackground, extractAgentResponseTable, extractPriorIssueTable } from "./history.mjs"

/**
 * Build the user message for an advisor review session.
 * @param {Object} agent — the parent agent
 * @param {Object|null} [_prior] — prior issue table
 * @param {string} [reviewType] — "design" or "code" (default)
 * @param {string|null} [designToken] — token injected into the design-review prompt; the advisor echoes it only on approval
 * @param {string[]|null} [documents] — design review only: explicit list of doc paths to review (requirements + design + referenced docs).
 *   When set, the review input is built from this list ONLY — no git-diff change-set collection.
 *   When absent, the legacy git-diff-based scope is kept (backward compatible).
 * @returns {string} the user message
 */
export function buildAdvisorUserMessage(agent, _prior, reviewType, designToken = null, documents = null, paths = null) {
  const prior = _prior ?? extractPriorIssueTable(agent.history)

  const parts = []
  const docList = Array.isArray(documents) ? documents.filter((d) => typeof d === "string" && d.trim()) : []
  const pathList = Array.isArray(paths) ? paths.filter((p) => typeof p === "string" && p.trim()) : []

  // Design review: simplified message — focus on the design doc, not code
  if (reviewType === "design") {
    const repos = findReviewRepos(agent)
    parts.push("## Design Review")
    if (docList.length > 0) {
      // Explicit review scope (engineering mode, FR2): the caller hands over the
      // doc list — the advisor reviews ONLY these. No git-diff change-set
      // collection: diff-based discovery reviewed unrelated files, and untracked
      // design docs were invisible to git diff anyway (ENGINEERING-MODE.md §2.4).
      parts.push("The documents below are the review scope. Review ONLY these files — do not scan git diff or read any other files.")
      parts.push("")
      parts.push("## Documents to Review")
      parts.push(docList.map((d) => `- ${d} — Read this file in full`).join("\n"))
      parts.push("")
    } else {
      // Backward-compatible fallback (no documents): discover docs via git status/diff.
      parts.push("The following changes are a design document. Review it against the project's methodology.")
      parts.push("")

      // List changed file paths explicitly — new design docs are untracked,
      // so git diff HEAD won't show their content; the advisor must read the file itself
      const changedFiles = collectChangedFiles(repos, agent.cwd)
      if (changedFiles.length > 0) {
        parts.push("## Changed Files")
        parts.push(changedFiles.map((f) => `- ${f}`).join("\n"))
        parts.push("")
        parts.push("Read each changed file in full — untracked files are not shown in the diff below.")
        parts.push("")
      }

      // Pre-collected changes — the design doc diff.
      // _advisorLastSnapshot is only consumed by code-review convergence — skip the write here.
      const snapshots = collectRepoSnapshots(repos, agent.cwd)
      if (snapshots.length > 0) {
        parts.push("## Design Document (git diff)")
        parts.push(...snapshots)
        parts.push("")
      }
    }

    // Engineering mode: inject project methodology
    if (agent.config?.agent?.engineering) {
      try {
        const mpath = resolve(agent.cwd, "METHODOLOGY.md")
        const methodology = readFileSync(mpath, "utf8")
        parts.push("## Project Methodology")
        parts.push("Evaluate the design against this methodology:")
        parts.push(methodology)
        parts.push("")
      } catch { /* file doesn't exist — skip */ }
    }

    parts.push("## Instructions")
    if (docList.length > 0) {
      parts.push("1. Read every document in the Documents to Review list in full — review ONLY those files. Read METHODOLOGY.md to understand the project's standards.")
    } else {
      parts.push("1. Read the design document fully. Read METHODOLOGY.md to understand the project's standards.")
    }
    parts.push("2. Review against: completeness (all requirements covered?), feasibility (can this be built?), clarity (specific enough?), acceptance criteria (verifiable?), scope (appropriate?).")
    parts.push("3. Do NOT run git diff or look for code changes — there are none at this stage.")
    parts.push("4. If you find issues, produce your review table with the format: | # | Category | Severity | Issue | Suggestion |. If the design passes, no table is needed.")
    if (designToken) {
      parts.push("")
      parts.push("## Approval Signal")
      parts.push(`If — and ONLY if — your review finds NO 🔴 (Critical) issues, end your reply with this exact token: [DESIGN-TOKEN:${designToken}]`)
      parts.push("🟡 (Advisory) and 🔵 (Note) findings do NOT block approval — list them if present, but still include the token. If there are any 🔴 issues, do NOT include the token.")
    }
    return parts.join("\n")
  }

  // Convergence data (round 2+)
  if (prior && (agent._advisorRound || 0) > 0) {
    const response = extractAgentResponseTable(agent.history, prior.sinceIdx)
      || "(Agent did not provide a response table — re-evaluate each issue)"
    const round = (agent._advisorRound || 0) + 1
    const label = round === 2 ? "Verify Prior Table + Flag New Issues" : "Strict Verification"
    parts.push(`## Round ${round} — ${label}`)
    parts.push("")
    parts.push("## Prior Issue Table")
    parts.push(prior.text)
    parts.push("")
    parts.push("## Agent Response")
    parts.push(response)
    parts.push("")
    parts.push("---")
    parts.push("")
  }

  parts.push("## Review Scope")
  if (pathList.length > 0) {
    parts.push("Review these code files/directories — read them in full for context:")
    parts.push("")
    parts.push(pathList.map((p) => `- ${p}`).join("\n"))
    parts.push("")
  }
  if (docList.length > 0) {
    if (reviewType === "design") {
      parts.push("The documents below are the review scope. Review ONLY these files — do NOT scan git diff or read any other files.")
    } else {
      parts.push("The documents below define acceptance criteria and review context. Read them for context, then read the code files specified in the review scope. Judge the implementation against these documents.")
    }
    parts.push("")
    parts.push("## Documents to Review")
    parts.push(docList.map((d) => `- ${d} — Read this file in full`).join("\n"))
    parts.push("")
  }

  // Conversation background — recent user↔assistant exchanges for intent context
  const background = extractConversationBackground(agent.history)
  if (background) {
    parts.push("## Conversation Background (recent turns)")
    parts.push(background)
    parts.push("")
  }

  // Review criteria
  const criteria = loadAdvisorMd(agent.cwd)
  parts.push("## Review Criteria")
  parts.push(criteria)
  parts.push("")

  // Engineering mode: inject project methodology so advisor knows the rules
  if (agent.config?.agent?.engineering) {
    try {
      const mpath = resolve(agent.cwd, "METHODOLOGY.md")
      const methodology = readFileSync(mpath, "utf8")
      parts.push("## Project Methodology (Engineering Mode)")
      parts.push("The project follows this methodology. Evaluate the changes against it:")
      parts.push(methodology)
      parts.push("")
    } catch { /* file doesn't exist — skip */ }
  }

  // Instructions — round-aware: re-reviews skip convention discovery entirely
  const isReReview = prior && (agent._advisorRound || 0) > 0
  parts.push("## Instructions")
  parts.push("1. IMPORTANT: in the diff, `-` lines are REMOVED content (no longer in the file), `+` lines are ADDED. The prior issue table (if any) is HISTORY — always verify current file state with `read` before judging an item.")
  if (isReReview) {
    parts.push("2. STALE-CONTEXT WARNING: any diff embedded in earlier messages is a historical snapshot — treat it as expired. Only the \"Current Changes\" section above and fresh `read` results describe the current state. Never quote a `-` line from any diff as if it were live code.")
    parts.push("3. Do NOT re-read AGENTS.md / design docs — conventions were established in round 1. Focus on verifying the prior issue table against the current diff.")
    parts.push("4. `read` only the files touched by the fixes. Batch independent reads/greps in a single reply.")
    parts.push("5. Produce your verification table. Do not re-read content you already have.")
  } else {
    parts.push("2. Read `AGENTS.md` / design docs only if they exist (check once; do not re-probe with multiple patterns).")
    parts.push("3. `read` changed files for full context beyond the diff. Batch independent reads/greps in a single reply instead of one call per round-trip.")
    parts.push("4. Use `grep` or `lsp` to trace callers, imports, and dependencies — only where the diff leaves genuine doubt.")
    parts.push("5. Produce your review table based on the review criteria above. Do not re-read content you already have.")
    parts.push("6. You may also flag other issues: crashes, data loss, logic errors — anything obvious. This is the convergence protocol: round 1 is the full review, later rounds only re-verify.")
  }
  parts.push("")
  parts.push("Return your review as a markdown table (or a clear statement that everything is fine).")

  return parts.join("\n")
}
