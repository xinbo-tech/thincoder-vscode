/**
 * agent.mjs — Agent loop for VS Code context.
 * Full thincoder feature set: subagents, plan mode, goal tracking, verify guard.
 */

import { chat } from "./provider.mjs"
import { specForModel } from "./specs.mjs"
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { builtinTools, toOpenAISchema, readImageTool } from "./tools.mjs"
import {
  taskTool, recentChangesTool, subagentTool,
  planTool, goalTool, skillTool, verifyTool, timerTool,
  advisorTool, engTool,
} from "./agent-tools.mjs"
import { compactHistory, injectContext, truncateFallback, COMPRESS_FAILURE_LIMIT } from "./context.mjs"
import { loadAgentSettings, loadRaw, normalizeProxy } from "./config-io.mjs"
import { isDocFile } from "./advisor/repos.mjs"
import * as os from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SYSTEM_PROMPT = readFileSync(join(__dirname, "prompts", "system.md"), "utf8")
const DISCIPLINE_RULES = readFileSync(join(__dirname, "prompts", "discipline.md"), "utf8")
const MAIN_OVERLAY = readFileSync(join(__dirname, "prompts", "main.md"), "utf8")
let _EXPLORE, _CODER, _PLAN, _ENG_CODER, _ENG_MAIN, _ENG_SUB
try { _EXPLORE = readFileSync(join(__dirname, "prompts", "explore.md"), "utf8") } catch { _EXPLORE = "" }
try { _CODER = readFileSync(join(__dirname, "prompts", "coder.md"), "utf8") } catch { _CODER = "" }
try { _PLAN = readFileSync(join(__dirname, "prompts", "plan.md"), "utf8") } catch { _PLAN = "" }
try { _ENG_CODER = readFileSync(join(__dirname, "prompts", "eng-coder.md"), "utf8") } catch { _ENG_CODER = "" }
try { _ENG_MAIN = readFileSync(join(__dirname, "prompts", "engineering.md"), "utf8") } catch { _ENG_MAIN = "" }
try { _ENG_SUB = readFileSync(join(__dirname, "prompts", "engineering-sub.md"), "utf8") } catch { _ENG_SUB = "" }

/** Engineering mode reminder — shared with the eng tool (CLI parity). */
export const ENG_ON_REMINDER =
  "[System reminder: engineering mode is ON — design-before-code enforced. " +
  "Workflow: Requirements doc → Design doc → advisor(type='design') → " +
  "user approval → eng-coder implementation. Code changes go through eng-coder " +
  "subagents only. Advisor calls are NOT per-turn-mandatory — call only at " +
  "flow nodes or when the user asks.]"

/** File-modifying tools — the engineering design gate blocks these before review passes (CLI parity). */
const FILE_MUTATORS = new Set(["write", "edit", "insert_after", "apply_patch", "delete", "hashline_edit"])
const MAX_ADVISOR_PUSHBACKS = 3

const DEFAULT_MAX_TURNS = 100

/** Top-level turn limit from the shared config.json (CLI agent.maxTurns), with local default fallback. */
function configuredMaxTurns() {
  try {
    return loadAgentSettings().maxTurns
  } catch { return DEFAULT_MAX_TURNS }
}
const STALL_WINDOW = 5
const STALL_THRESHOLD = 3
const MAX_VERIFY_PUSHBACKS = 2
const MAX_VERIFY_RETRIES = 3
const MAX_EMPTY_RETRIES = 2 // empty-response retry budget (CLI parity, IK60QP)

/** Task re-injection reminder prefix — stale copies are filtered before re-injecting (CLI parity D7). */
const TASK_REINJECT_PREFIX = "[System reminder: your current task list after compaction:"

/**
 * Build the engineering-mode prompt fragment: engineering template + project METHODOLOGY.md
 * (CLI setup.mjs buildEngineeringPrompt parity). Returns { prompt, templateMissing, methodologyMissing }.
 */
function loadEngineeringPrompt(cwd, role) {
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
function hasCodeMutations(agent) {
  const files = agent._touchedFiles ?? []
  if (files.length === 0) return agent._mutatedThisRun
  return files.some((p) => /(?:^|[\\/])src[\\/]/.test(p) || !isDocFile(p))
}
const MAX_TOOL_RESULT = 16000 // chars — large results saved to disk instead of truncated (aligns with CLI)
const TOOL_RESULT_PREVIEW = 2000 // chars shown inline when offloaded (aligns with CLI)
const MAX_PARALLEL_SUBAGENTS = 3

/** Typed error for turn-limit exhaustion — consumers can detect and offer "Continue?" prompt */
export class ContinueError extends Error {
  constructor(turns) { super(`Agent reached max turns (${turns}).`); this.turns = turns }
}

/** Run async tasks with a concurrency limit */
async function runWithLimit(items, fn, limit) {
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

/** Save large tool results to disk so the agent can read them with the read tool */
function offloadToolResult(cwd, text) {
  if (text.length <= MAX_TOOL_RESULT) return text
  try {
    if (!existsSync(join(cwd, ".thincoder", "tmp"))) mkdirSync(join(cwd, ".thincoder", "tmp"), { recursive: true })
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const path = join(cwd, ".thincoder", "tmp", `tool-${id}.txt`)
    writeFileSync(path, text, "utf8")
    return `[Large output saved. Read the full result with the read tool: ${path}]\n\n${text.slice(0, TOOL_RESULT_PREVIEW)}...`
  } catch {
    // If saving fails (disk full, permissions), fall back to truncation
    return text.slice(0, MAX_TOOL_RESULT) + `\n... (truncated ${text.length - MAX_TOOL_RESULT} chars)`
  }
}

export { builtinTools } from "./tools.mjs"

/**
 * pushReal — the single entry point for REAL conversation messages.
 * A real message (user input, assistant reply, tool result, multimodal image) is appended to BOTH the
 * machine line (history) and the human line (fullHistory). Machine-only injections ([System reminder:...],
 * compaction notes, task/plan reminders) are pushed to history directly and never enter fullHistory.
 * Mirrors thincoder/src/context.mjs:pushReal — the two lines are written independently at the source.
 */
function pushReal(history, fullHistory, msg) {
  fullHistory.push(msg)
  history.push(msg)
}

/** Extract the persisted engineering/advisor state for the session file (CLI session.mjs fields).
 *  Only the design token is session-scoped — engineering lives in config.json and the advisor
 *  convergence budget resets per run (CLI parity). */
function agentState(agent) {
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
function reinjectAfterCompaction(history, agent, autoApprove) {
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

  // Re-inject permission mode reminder
  if (autoApprove) {
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


/**
 * Run the agent loop.
 * @param {object} opts - { depth, role, maxTurns } for subagent context
 */
export async function runAgent(provider, cwd, input, callbacks = {}, signal, autoApprove = true, opts = {}) {
  const { depth = 0, role = null, maxTurns: overrideTurns, mcpServers, skills, engState, engDesignReviewed } = opts

  const agentTools = depth === 0
    ? [taskTool, recentChangesTool, subagentTool, planTool, goalTool, skillTool, verifyTool, timerTool, advisorTool, engTool]
    : role === "eng-coder"
      ? [taskTool, recentChangesTool, planTool, timerTool, advisorTool, verifyTool] // eng-coder: design review + verify gates
      : [taskTool, recentChangesTool] // subagents get fewer meta-tools

  // Subagent role-based tool filtering: explore/plan get read-only tools only
  const isReadOnlyRole = depth > 0 && (role === "explore" || role === "plan")
  const tools = [
    ...(isReadOnlyRole ? builtinTools.filter((t) => t.readonly) : builtinTools),
    ...(specForModel(provider.model).multimodal ? [readImageTool] : []),
    ...agentTools,
  ]
  const toolSchemas = tools.map(toOpenAISchema)
  const toolByName = new Map(tools.map((t) => [t.name, t]))

  // Runtime config: advisor settings live in the shared config.json (CLI agent.advisor),
  // engineering state is per-session (persisted by chat-panel alongside the history lines).
  let advisorCfg = { enabled: false }
  let cfgEngineering = false
  let cfgVerifyGuard = false
  let cfgCompactThreshold = null
  let cfgProxy = undefined
  try {
    const raw = loadRaw()
    advisorCfg = raw.agent?.advisor ?? { enabled: false }
    cfgEngineering = raw.agent?.engineering ?? false
    cfgVerifyGuard = raw.agent?.verifyGuard === true // opt-in, CLI parity
    cfgCompactThreshold = raw.agent?.compactThreshold ?? null // null = auto from model context
    cfgProxy = normalizeProxy(raw.proxy) // web tools consult agent.config.proxy (resolveWebProxy)
  } catch { /* config unreadable — defaults */ }
  const engineering = engState?.enabled ?? cfgEngineering

  const agent = {
    _tasks: [], _touchedFiles: [], _planMode: false,
    _goal: null, _provider: provider,
    _verifiedThisRun: false, _pendingTimers: [],
    // Compaction bookkeeping (CLI parity): measured baseline + failure counter + empty-response budget.
    // All per-run — the agent object is rebuilt on every runAgent call, so they reset per user message.
    _lastPromptTokens: null, _usageAtLen: null,
    _compressFailures: 0, _emptyRetries: 0,
    // Advisor / engineering bookkeeping (CLI parity). _advisorRound always starts at 0 — the
    // convergence budget is per-run (runAgent resets it in the CLI), never persisted.
    _role: role,
    _advisorRound: 0,
    _advisorSession: null, _advisorLastSnapshotHash: null,
    _engDesignToken: engState?.engDesignToken ?? null,
    _engDesignReviewed: engDesignReviewed === true, // eng-coder children arrive pre-authorized
    _calledAdvisorThisRun: false, _mutatedThisRun: false,
    _lastEngState: engineering, _pendingReminders: [],
    config: { advisor: advisorCfg, agent: { engineering }, proxy: cfgProxy },
  }

  // Live state channel for the parent (eng-coder mutation merge) — the caller gets a
  // reference to the same array, so it stays current as the child touches files.
  if (opts.stateSink) opts.stateSink.touchedFiles = agent._touchedFiles
  const platform = { win32: "Windows", darwin: "macOS", linux: "Linux" }[os.platform()] ?? os.platform()

  // System prompt — engineering mode replaces the standard discipline block with
  // engineering.md (or engineering-sub.md for eng-coder) + project METHODOLOGY.md (CLI parity).
  const engPromptActive = engineering && (depth === 0 || role === "eng-coder")
  const engResult = engPromptActive ? loadEngineeringPrompt(cwd, role) : null
  let base = engPromptActive
    ? (engResult.prompt ? `${SYSTEM_PROMPT}\n\n${engResult.prompt}` : SYSTEM_PROMPT)
    : `${SYSTEM_PROMPT}\n\n${DISCIPLINE_RULES}`
  if (depth > 0 && role) {
    const overlay = { explore: _EXPLORE, coder: _CODER, plan: _PLAN, "eng-coder": _ENG_CODER }[role] || ""
    base = overlay ? `${overlay}\n\n${base}` : base
  }
  const systemPrompt = `${base}${depth === 0 && !engPromptActive ? `\n\n${MAIN_OVERLAY}` : ""}\n\nOS: ${platform}. Working directory: ${cwd}.`

  // Dual-line history. Top-level runs use PERSISTENT lines passed in via opts (survive across calls,
  // written to the session file by chat-panel): history = machine context (compaction shrinks it),
  // fullHistory = never-compacted human-readable record. Subagents always use throwaway local lines.
  // Old sessions / first turn: seed the machine line from the human line (correctness over tokens).
  const fullHistory = depth === 0 ? (opts.fullHistory ?? (opts.fullHistory = [])) : []
  const history = depth === 0
    ? (opts.history ?? (opts.history = [...fullHistory]))
    : []

  // The advisor helpers (ported from the CLI) reach for agent.cwd and agent.history —
  // keep those aliases live so the ported modules work unchanged.
  agent.cwd = cwd
  agent.history = history

  // ─── Context injection (top-level only, fresh machine line only) ────
  // These machine-only injections are transient context; a persistent machine line already carries
  // them from prior turns, so only inject when starting a brand-new (empty) machine line.
  const freshMachineLine = history.length === 0
  if (depth === 0 && freshMachineLine) {
    injectContext(history, cwd, input)
    // MCP server config
    // MCP server config (array of { name, command?, args?, env?, url?, wsUrl?, headers? } — shared config.json)
    if (mcpServers && mcpServers.length > 0) {
      const list = mcpServers.map((cfg) => {
        const desc = cfg.wsUrl ? cfg.wsUrl : cfg.url ? cfg.url : `stdio (${cfg.command} ${(cfg.args ?? []).join(" ")})`
        return `  - ${cfg.name}: ${desc}`
      }).join("\n")
      history.push({ role: "user", content: `[System: configured MCP servers (use mcp tool to connect):\n${list}]` })
    }
    // Skills from .thincoder/skills/
    if (skills && skills.length > 0) {
      const list = skills.map((s) => `### ${s.name}\n${s.content}`).join("\n\n")
      history.push({ role: "user", content: `[System: available skills from .thincoder/skills/ — use the skill tool to load one when relevant. Available skills:\n\n${list}]` })
    }
  }

  if (depth === 0 && freshMachineLine) {
    if (autoApprove) {
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
    // Engineering mode degraded-constraint warnings (CLI setup.mjs parity)
    if (engPromptActive && (engResult.templateMissing || engResult.methodologyMissing)) {
      const warnings = []
      if (engResult.templateMissing) warnings.push(`Engineering template (${role === "eng-coder" ? "engineering-sub.md" : "engineering.md"}) not found — using degraded constraints.`)
      if (engResult.methodologyMissing) warnings.push("METHODOLOGY.md not found — project-specific rules are absent.")
      history.push({
        role: "user",
        content: `[System reminder: ENGINEERING MODE is active but ${warnings.join(" ")} Create METHODOLOGY.md and ensure prompt templates exist for full enforcement, or disable engineering mode (eng tool).]`,
      })
    }
  }

  pushReal(history, fullHistory, { role: "user", content: input })

  // Inject pasted images as multimodal content on the first user message
  if (depth === 0 && Array.isArray(opts.images) && opts.images.length > 0) {
    const spec = specForModel(provider.model)
    if (!spec.multimodal) {
      throw new Error("This model does not support pasted images. Switch to a vision-capable model (Kimi K3, Qwen, GPT-4o, or MiniMax M3).")
    } else {
      const lastMsg = history[history.length - 1]
      const parts = [{ type: "text", text: input }]
      for (const img of opts.images) {
        if (typeof img === "string" && img.startsWith("data:image/")) {
          parts.push({ type: "image_url", image_url: { url: img } })
        }
      }
      if (parts.length > 1) lastMsg.content = parts
    }
  }

  // ─── Main loop ─────────────────────────────
  const maxTurns = overrideTurns || configuredMaxTurns()
  const recentSigs = []
  let guardPushbacks = 0
  let advisorPushbacks = 0

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    // Context compaction check — only at safe points: history ends with a complete
    // exchange (user input or tool result), never mid-assistant (CLI parity D1).
    const lastRole = history.at(-1)?.role
    if (lastRole === "user" || lastRole === "tool") {
      try {
        // Measured baseline path (CLI parity D3): the last response's prompt_tokens is the
        // true full-context cost; messages appended since are estimated as increments.
        const compacted = await compactHistory(history, systemPrompt, provider, cfgCompactThreshold, {
          lastPromptTokens: agent._lastPromptTokens,
          usageAtLen: agent._usageAtLen,
        })
        if (compacted) {
          history.length = 0
          history.push(...compacted)
          // Measured baseline is invalidated along with old history — fall back to estimation
          agent._lastPromptTokens = null
          agent._usageAtLen = null
          agent._compressFailures = 0
          reinjectAfterCompaction(history, agent, autoApprove)
        }
      } catch (e) {
        // AbortError must not be swallowed: user cancellation must propagate
        if (e?.name === "AbortError" || signal?.aborted) throw e
        // Summary LLM failed — count consecutive failures; after the limit degrade to
        // deterministic truncation (no network) so the task can continue (CLI parity D6).
        agent._compressFailures = (agent._compressFailures ?? 0) + 1
        if (agent._compressFailures >= COMPRESS_FAILURE_LIMIT) {
          agent._compressFailures = 0
          const truncated = truncateFallback(history, provider)
          if (truncated) {
            history.length = 0
            history.push(...truncated)
            agent._lastPromptTokens = null
            agent._usageAtLen = null
            reinjectAfterCompaction(history, agent, autoApprove)
          }
        }
      }
    }

    // Flush pending reminders queued by meta-tools (eng enter/exit, etc.)
    if (agent._pendingReminders.length > 0) {
      for (const reminder of agent._pendingReminders) history.push({ role: "user", content: reminder })
      agent._pendingReminders = []
    }

    const messages = [{ role: "system", content: systemPrompt }, ...history]
    const response = await chat(provider, {
      messages,
      tools: toolSchemas,
      onToken: depth === 0 ? callbacks.onToken : null,
      onReasoning: callbacks.onReasoning,
      onWait: callbacks.onWait,
      signal,
    })

    if (response.usage && depth === 0) {
      callbacks.onUsage?.(response.usage)
      // Measured compaction baseline (CLI parity D3): the full-context prompt_tokens from
      // this response anchors the next compaction check; appended messages count as increments.
      if (response.usage.prompt_tokens != null) {
        agent._lastPromptTokens = response.usage.prompt_tokens
        agent._usageAtLen = history.length
      }
    }

    // ─── No tool calls ──────────────────────
    if (response.toolCalls.length === 0) {
      if (!response.content) {
        if (response.reasoning) {
          // Model output only reasoning (thinking) — treat as content
          response.content = response.reasoning
        } else {
          // Transient empty response (reasoning exhausted / output truncated): instead of
          // aborting the whole turn, inject a reminder and let the model respond again.
          // Bounded — after MAX_EMPTY_RETRIES consecutive empties, surface the error (CLI parity, IK60QP).
          const retries = agent._emptyRetries ?? 0
          if (retries < MAX_EMPTY_RETRIES) {
            agent._emptyRetries = retries + 1
            history.push({
              role: "user",
              content: "[System reminder: your last response was empty — the provider returned no content (likely reasoning was exhausted or output was truncated). Respond again, continuing your work from where you left off.]",
            })
            continue
          }
          throw new Error("LLM returned empty response (likely reasoning exhausted or output truncated). Try lowering reasoning effort if this persists.")
        }
      }

      // Pending tasks check (top-level only)
      if (depth === 0) {
        const pending = agent._tasks?.filter((t) => t.status === "pending")
        if (pending?.length) {
          pushReal(history, fullHistory, { role: "assistant", content: response.content })
          history.push({
            role: "user",
            content: `[System reminder: you still have pending tasks: ${pending.map((t) => t.title).join(", ")}. Update their status before finishing — if done, mark done; if not applicable, remove them.]`,
          })
          continue
        }

        // Verify guard — OPT-IN (config agent.verifyGuard === true, CLI parity). When off
        // the agent is not pushed back to verify before finishing.
        if (cfgVerifyGuard && agent._touchedFiles.length > 0 && !agent._verifiedThisRun && guardPushbacks < MAX_VERIFY_PUSHBACKS) {
          guardPushbacks++
          pushReal(history, fullHistory, { role: "assistant", content: response.content })
          history.push({
            role: "user",
            content: "[System reminder: you modified files in this run but have not verified the changes. Before finishing: call the verify tool to run syntax checks and tests. If verify reports failures, fix them and run verify again. If verification is genuinely impossible here, say so explicitly in your reply.]",
          })
          continue
        }
        if (agent._verifiedThisRun && agent._verifyPassed === false) {
          const retries = (agent._verifyRetries ?? 0) + 1
          agent._verifyRetries = retries
          if (retries < MAX_VERIFY_RETRIES) {
            agent._verifyPassed = undefined // reset for next attempt
            pushReal(history, fullHistory, { role: "assistant", content: response.content })
            history.push({
              role: "user",
              content: `[System reminder: verify reported failures (retry ${retries}/${MAX_VERIFY_RETRIES}). Review the failures, fix the issues, then run verify again. If you cannot fix after ${MAX_VERIFY_RETRIES} attempts, explain honestly what's blocking you.]`,
            })
            continue
          }
          // Exhausted retries — inject honest-declaration reminder
          if (!agent._honestReminderInjected) {
            agent._honestReminderInjected = true
            pushReal(history, fullHistory, { role: "assistant", content: response.content })
            history.push({
              role: "user",
              content: `[System reminder: ${MAX_VERIFY_RETRIES} verify attempts exhausted and tests are still failing. In your response to the user, you MUST state explicitly: (1) what tests are still failing, (2) what you tried, (3) what you believe the root cause is. Do not present this as complete — the user needs to know the work is unfinished.]`,
            })
            continue
          }
        }

        // Advisor guard (CLI completion.mjs parity): OPT-IN via advisor.enabled + guard!==false,
        // NEVER in engineering mode (engineering has its own mandatory gates).
        const advisorCfg = agent.config?.advisor
        const advisorReview = advisorCfg?.enabled && advisorCfg?.guard !== false
        if (advisorReview && !agent.config?.agent?.engineering
            && agent._mutatedThisRun && !agent._calledAdvisorThisRun && hasCodeMutations(agent)
            && advisorPushbacks < MAX_ADVISOR_PUSHBACKS) {
          advisorPushbacks++
          pushReal(history, fullHistory, { role: "assistant", content: response.content })
          history.push({
            role: "user",
            content: `[System reminder: you changed code in this run and MUST get an advisor review before finishing (round ${agent._advisorRound + 1}). Call the \`advisor\` tool now. This is required, not optional — do not skip it even if you believe the changes are trivial — the review will be quick either way. After the review, produce a response table for every issue found (see discipline rules for format).]`,
          })
          continue
        }
      }

      pushReal(history, fullHistory, { role: "assistant", content: response.content })
      if (depth === 0) callbacks.onComplete?.(response.content, agentState(agent))
      return response.content
    }

    // ─── Tool calls ─────────────────────────
    pushReal(history, fullHistory, {
      role: "assistant",
      content: response.content || null,
      tool_calls: response.toolCalls.map((tc) => ({
        id: tc.id, type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
      ...(response.reasoning && specForModel(provider.model).reasoningEcho === "required"
        ? { reasoning_content: response.reasoning }
        : {}),
    })

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
          if (tool && !tool.readonly && !tool.sideEffectExempt) {
            // Side-effect tools (bash, git, …) invalidate prior review/verify —
            // the environment changed even if no code file did.
            if (agent._calledAdvisorThisRun) agent._calledAdvisorThisRun = false
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
          if (FILE_MUTATORS.has(toolName)) {
            agent._mutatedThisRun = true
            const paths = tool.touchedPaths ? tool.touchedPaths(args) : [args?.path]
            for (const p of paths) {
              if (typeof p !== "string") continue
              const abs = join(cwd, p)
              if (!agent._touchedFiles.includes(abs)) agent._touchedFiles.push(abs)
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

    // Expired timers — inject reminders when the thinking budget is up (ported from CLI post-turn)
    if (agent._pendingTimers.length > 0) {
      const now = Date.now()
      const expired = agent._pendingTimers.filter((t) => t.expiresAt <= now)
      agent._pendingTimers = agent._pendingTimers.filter((t) => t.expiresAt > now)
      for (const t of expired) {
        history.push({ role: "user", content: `[System reminder: ⏰ timer — ${t.message}]` })
      }
    }

    // Goal injection
    if (agent._goal?.status === "active") {
      agent._goal.turnsUsed = (agent._goal.turnsUsed ?? 0) + 1
      history.push({
        role: "user",
        content: `[System reminder: goal active — "${agent._goal.objective}". Turns used: ${agent._goal.turnsUsed}. Complete with the goal tool when criteria are met.]`,
      })
    }
  }

  throw new ContinueError(maxTurns)
}

