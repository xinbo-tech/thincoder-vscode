/**
 * run-helpers.mjs — agent loop helpers (split out of agent.mjs for the 500-line limit).
 * Constants + pure helpers shared by runAgent and executeToolBatches.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { loadAgentSettings } from "../config-io.mjs"
import { isDocFile } from "../advisor/repos.mjs"

/** File-modifying tools — the engineering design gate blocks these before review passes (CLI parity). */
export const FILE_MUTATORS = new Set(["write", "edit", "insert_after", "apply_patch", "delete", "hashline_edit"])
export const MAX_ADVISOR_PUSHBACKS = 3

const DEFAULT_MAX_TURNS = 200

/** Top-level turn limit from the shared config.json (CLI agent.maxTurns), with local default fallback. */
export function configuredMaxTurns() {
  try {
    return loadAgentSettings().maxTurns
  } catch { return DEFAULT_MAX_TURNS }
}
export const STALL_WINDOW = 5
export const STALL_THRESHOLD = 3
export const MAX_VERIFY_PUSHBACKS = 2
export const MAX_VERIFY_RETRIES = 3
export const MAX_EMPTY_RETRIES = 2 // empty-response retry budget (CLI parity, IK60QP)

/** Task re-injection reminder prefix — stale copies are filtered before re-injecting (CLI parity D7). */
export const TASK_REINJECT_PREFIX = "[System reminder: your current task list after compaction:"

// Engineering-mode prompt templates (loaded once; methodology is read per-run from the project).
let _ENG_MAIN = ""
let _ENG_SUB = ""
try { _ENG_MAIN = readFileSync(new URL("../prompts/engineering.md", import.meta.url), "utf8") } catch { /* */ }
try { _ENG_SUB = readFileSync(new URL("../prompts/engineering-sub.md", import.meta.url), "utf8") } catch { /* */ }

/**
 * Build the engineering-mode prompt fragment: engineering template + project METHODOLOGY.md
 * (CLI setup.mjs buildEngineeringPrompt parity). Returns { prompt, templateMissing, methodologyMissing }.
 */
export function loadEngineeringPrompt(cwd, role) {
  const engTemplate = role === "eng-coder" ? _ENG_SUB : _ENG_MAIN
  let methodology = ""
  try { methodology = readFileSync(join(cwd, "METHODOLOGY.md"), "utf8") } catch { /* no methodology */ }
  const templateMissing = !engTemplate
  const methodologyMissing = !methodology
  const prompt = engTemplate
    ? (methodology ? `${engTemplate}\n\n---\n\n## Project METHODOLOGY.md\n\n${methodology}` : engTemplate)
    : (methodology ? `[ENGINEERING MODE]\n\nFollow this methodology strictly:\n\n${methodology}` : null)
  return { prompt, templateMissing, methodologyMissing }
}

/**
 * True when this run mutated at least one CODE file (CLI hasCodeMutations parity).
 * Doc-only changes (docs/, *.md, LICENSE…) must NOT trigger the advisor guard.
 * _touchedFiles stores absolute paths; the src/ check matches a path component.
 */
export function hasCodeMutations(agent) {
  const files = agent._touchedFiles ?? []
  if (files.length === 0) return agent._mutatedThisRun
  return files.some((p) => /(?:^|[\\/])src[\\/]/.test(p) || !isDocFile(p))
}
export const MAX_TOOL_RESULT = 64 * 1024 // chars — large results saved to disk instead of truncated (aligns with CLI)
export const TOOL_RESULT_PREVIEW = 64 * 1024 // chars shown inline when offloaded (aligns with CLI)
/** Offload-dir write-time self-cleanup retention window (CLI parity 2026-08-21): files older than 3 days are deleted on the next offload. */
export const TMP_RETENTION_MS = 3 * 24 * 3600 * 1000
export const MAX_PARALLEL_SUBAGENTS = 3

/** Run async tasks with a concurrency limit */
export async function runWithLimit(items, fn, limit) {
  const results = new Array(items.length)
  let idx = 0
  async function worker() {
    while (idx < items.length) {
      const i = idx++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/** Save large tool results to disk so the agent can read them with the read tool.
 *  Writes trigger write-time self-cleanup of <cwd>/.thincoder/tmp/ first (CLI parity, 2026-08-21):
 *  delete files older than TMP_RETENTION_MS (incl. paste-* images in the same dir); subdirs untouched; silent failures. */
export function offloadToolResult(cwd, text) {
  if (text.length <= MAX_TOOL_RESULT) return text
  const dir = join(cwd, ".thincoder", "tmp")
  const now = Date.now()
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    entries = [] // dir missing or unreadable → nothing to clean
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue // subdirectories untouched
    try {
      const st = statSync(join(dir, entry.name))
      if (now - st.mtimeMs > TMP_RETENTION_MS) unlinkSync(join(dir, entry.name))
    } catch {
      /* entry vanished concurrently or I/O error — best effort, keep going */
    }
  }
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const path = join(dir, `tool-${id}.txt`)
    writeFileSync(path, text, "utf8")
    return `[Large output saved. Read the full result with the read tool: ${path}]\n\n${text.slice(0, TOOL_RESULT_PREVIEW)}...`
  } catch {
    // If saving fails (disk full, permissions), fall back to truncation
    return text.slice(0, MAX_TOOL_RESULT) + `\n... (truncated ${text.length - MAX_TOOL_RESULT} chars)`
  }
}

/**
 * pushReal — the single entry point for REAL conversation messages.
 * A real message (user input, assistant reply, tool result, multimodal image) is appended to BOTH the
 * machine line (history) and the human line (fullHistory). Machine-only injections ([System reminder:...],
 * compaction notes, task/plan reminders) are pushed to history directly and never enter fullHistory.
 * Mirrors thincoder/src/context.mjs:pushReal — the two lines are written independently at the source.
 */
export function pushReal(history, fullHistory, msg) {
  fullHistory.push(msg)
  history.push(msg)
}

/** Extract the persisted engineering/advisor state for the session file (CLI session.mjs fields).
 *  Only the design token is session-scoped — engineering lives in config.json and the advisor
 *  convergence budget resets per run (CLI parity). */
export function agentState(agent) {
  return {
    engineering: agent.config?.agent?.engineering ?? false,
    engDesignToken: agent._engDesignToken ?? null,
  }
}

/**
 * Re-inject state reminders after the machine line was rewritten by compaction or truncation.
 * Task list is the single source of truth: stale re-injections are filtered FIRST, then the
 * latest version is appended (CLI parity D7 — otherwise old copies accumulate and grow stale).
 */
export function reinjectAfterCompaction(history, agent, getAuto) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role === "user" && typeof m.content === "string" && m.content.startsWith(TASK_REINJECT_PREFIX)) {
      history.splice(i, 1)
    }
  }

  // Re-inject task list after compaction (single source of truth)
  if (agent._tasks?.length > 0) {
    const pending = agent._tasks.filter((t) => t.status !== "done")
    const done = agent._tasks.filter((t) => t.status === "done")
    const taskSummary = [
      ...pending.map((t) => `- [${t.status}] ${t.title}`),
      ...done.slice(0, 3).map((t) => `- [done] ${t.title}`),
    ].join("\n")
    history.push({
      role: "user",
      content: `[System reminder: your current task list after compaction:\n${taskSummary}\nContinue from where you left off.]`,
    })
  }

  // Re-inject plan mode if active
  if (agent._planMode) {
    history.push({
      role: "user",
      content: "[System reminder: plan mode is active. Explore the codebase read-only, design your solution, then call plan with action='exit' to present it for user approval.]",
    })
  }

  // Re-inject permission mode reminder — getAuto() is the live flag (CLI parity), so a
  // mid-turn approve-all that survives compaction re-injects the correct reminder.
  if (getAuto()) {
    history.push({
      role: "user",
      content: "[System reminder: AUTO mode is active — all tool calls are automatically approved without asking.]",
    })
  } else {
    history.push({
      role: "user",
      content: "[System reminder: Permission mode — confirm with the user before making changes. Describe what you plan to modify and wait for approval before executing file-changing tools.]",
    })
  }
}
