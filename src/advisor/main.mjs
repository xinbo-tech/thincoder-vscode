/**
 * advisor/main.mjs — advisor system-prompt selection, follow-up building, session assembly.
 * VS Code port of thincoder CLI src/advisor.mjs (kept in sync with the CLI).
 * User-message building in advisor/messages.mjs; execution in advisor/run.mjs;
 * git discovery/collection in advisor/repos.mjs; history extraction in advisor/history.mjs.
 *
 * Convergence protocol / session memory semantics — see the CLI file header.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { extractPriorIssueTable, extractAgentResponseTable } from "./history.mjs"
import { buildAdvisorUserMessage } from "./messages.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ────────────────────────────────────────
// Prompt files — loaded at module init
// ────────────────────────────────────────

const ADVISOR_ROUND1 = readFileSync(join(__dirname, "..", "prompts", "advisor-round1.md"), "utf8")
const ADVISOR_ROUND2 = readFileSync(join(__dirname, "..", "prompts", "advisor-round2.md"), "utf8")
const ADVISOR_ROUND3 = readFileSync(join(__dirname, "..", "prompts", "advisor-round3.md"), "utf8")
let ADVISOR_DESIGN = ""
try { ADVISOR_DESIGN = readFileSync(join(__dirname, "..", "prompts", "advisor-design.md"), "utf8") } catch { /* design review unavailable */ }

/**
 * Build the system prompt for an advisor review session.
 * @param {Object} agent — the parent agent
 * @param {Object|null} [_prior] — prior issue table (from extractPriorIssueTable)
 * @param {string} [reviewType] — "design" for design review, undefined/"code" for code review
 */
export function buildAdvisorSystemPrompt(agent, _prior, reviewType) {
  // Design review: dedicated prompt, no convergence rounds
  if (reviewType === "design") return ADVISOR_DESIGN || `You are an independent design reviewer for an engineering-mode project. Review the design document in the changes below. Evaluate: completeness, feasibility, clarity, scope, acceptance criteria. Read METHODOLOGY.md if provided. Produce a review table with | # | Category | Severity | Issue | Suggestion | format.`
  const prior = _prior ?? extractPriorIssueTable(agent.history)
  if (!prior || (agent._advisorRound || 0) === 0) return ADVISOR_ROUND1
  const round = (agent._advisorRound || 0) + 1
  if (round === 2) return ADVISOR_ROUND2
  return ADVISOR_ROUND3
}

/**
 * Build a follow-up user message for round 2+ — the agent's response table +
 * round-aware instructions, without re-sending the full round-1 context.
 * Deliberately NO git information injected (no diff snapshot, no git context):
 * git output misled re-reviews — committed fixes never show in `git diff HEAD`,
 * so the model read "no changes" as "no fixes". Verification is `read`-only.
 */
export function buildAdvisorFollowUp(agent, _prior) {
  const prior = _prior ?? extractPriorIssueTable(agent.history)
  const response = extractAgentResponseTable(agent.history, prior?.sinceIdx ?? 0)
    || "(Agent did not provide a response table — re-evaluate each issue)"
  const round = (agent._advisorRound || 0) + 1
  const label = round === 2 ? "Verify Prior Table + Flag New Issues" : "Strict Verification"

  const parts = [
    `## Round ${round} — ${label}`,
    "",
    `[System reminder: this is round ${round} of the convergence protocol. The system prompt for this round has already narrowed the review scope — follow it: ${round === 2 ? "verify the prior table and flag only obvious new issues introduced by the fixes" : "strictly verify only the prior table — do NOT look for new issues"}.]`,
    "",
    "## Prior Issue Table",
    prior?.text ?? "(no prior table — review from scratch)",
    "",
    "## Agent Response",
    response,
    "",
    "## Instructions",
    round === 2
      ? "Verify each item in the prior table. Flag any obvious NEW issues introduced by the fixes (crashes, data loss, logic errors — not style). Produce a verification table."
      : "Strictly verify ONLY the items in the prior table against the CURRENT FILE STATE (use `read` — an empty diff does not mean the fixes are absent). Do NOT look for new issues.",
    "",
    "IMPORTANT: the prior issue table is HISTORY — always verify current file state with `read` before judging an item as fixed or unfixed.",
    // Round-aware evidence rule: "New" entries only exist in round 2 (round 3+ forbids them).
    `STALE-CONTEXT WARNING: only fresh \`read\` results describe the current state — never judge from earlier snapshots or from \`git diff\` (committed fixes never show in \`git diff HEAD\`). Read the files to verify. Any "Unfixed" entry${round === 2 ? ' (and any "New" entry)' : ""} MUST quote the exact line content from THIS round's \`read\` output (e.g. \`run.mjs:180: timeoutId = setTimeout(...)\`); line numbers alone are NOT evidence (they may come from the stale prior table). Uncited findings are unverified and will be ignored.`,
    "",
    "Do NOT re-read AGENTS.md / design docs. Verify fix status with `read` only — do not rely on git output: a clean working tree does not mean fixes are absent (they may be committed).",
    "",
  ]
  return parts.join("\n")
}

/**
 * Build or continue the advisor conversation for this run.
 * First call in a run: fresh [system, user] session. Later calls: append a
 * follow-up to the existing session so the advisor keeps its context.
 * @param {string[]|null} [paths] — code review only: explicit list of file/dir paths to review
 * @param {string} [reviewType] — "design" or "code" (default)
 * @param {string|null} [designToken] — design-review approval token (design only)
 * @param {string[]|null} [documents] — design review only: explicit list of doc paths to review
 */
export function prepareAdvisorMessages(agent, reviewType, designToken = null, documents = null, paths = null) {
  const prior = extractPriorIssueTable(agent.history)
  // Design review: always fresh session, no convergence
  if (reviewType === "design") {
    return [
      { role: "system", content: buildAdvisorSystemPrompt(agent, prior, reviewType) },
      { role: "user", content: buildAdvisorUserMessage(agent, prior, reviewType, designToken, documents, paths) },
    ]
  }
  let session = agent._advisorSession
  if (session) {
    // Session exists but no prior table (last review was all-clear or none) —
    // a follow-up "Verify Prior Table" would be meaningless; start a fresh full review
    if (!prior) {
      agent._advisorSession = null
      // Only reset the round counter on a truly fresh start (no prior reviews at all).
      // If _advisorRound > 0, there WAS a prior review — it just passed (all-clear).
      if (!agent._advisorRound) agent._advisorRound = 0
    } else {
      // Convergence rounds (2+): replace the system prompt so the round-1
      // "full-scope review" mandate cannot override the follow-up's narrowed scope.
      session[0] = { role: "system", content: buildAdvisorSystemPrompt(agent, prior, reviewType) }
      session.push({ role: "user", content: buildAdvisorFollowUp(agent, prior) })
      return session
    }
  }
  session = [
    { role: "system", content: buildAdvisorSystemPrompt(agent, prior, reviewType) },
    { role: "user", content: buildAdvisorUserMessage(agent, prior, reviewType, designToken, documents, paths) },
  ]
  // Fresh session. Only reset round if this is truly the first review.
  if (!agent._advisorRound) agent._advisorRound = 0
  if (!prior) {
    // Tell the advisor why no prior issue table is present
    session[1] = {
      role: "user",
      content: `[System reminder: no prior issue table is being carried into this review (first review, app restart, or session clear) — start with a fresh full review.]\n\n${session[1].content}`,
    }
  }
  return session
}
