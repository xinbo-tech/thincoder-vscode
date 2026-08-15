/**
 * agent.mjs — Agent loop for VS Code context.
 * Full thincoder feature set: subagents, plan mode, goal tracking, verify guard.
 */

import { chat } from "./provider.mjs"
import { specForModel } from "./specs.mjs"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { builtinTools, toOpenAISchema, readImageTool } from "./tools.mjs"
import {
  taskTool, recentChangesTool, subagentTool,
  planTool, goalTool, skillTool, verifyTool, timerTool,
  advisorTool, engTool, consultStartTool, consultCheckTool, consultStopTool,
} from "./agent-tools.mjs"
import { compactHistory, truncateFallback, COMPRESS_FAILURE_LIMIT } from "./compact.mjs"
import { cleanupConsultSessions } from "./agent-tools/consult.mjs"
import { traceStop } from "./extension/stop-trace.mjs"
import { injectContext } from "./context.mjs"
import { loadRaw, normalizeProxy, resolveProviders } from "./config-io.mjs"
import * as os from "node:os"
import {
  MAX_ADVISOR_PUSHBACKS, MAX_VERIFY_PUSHBACKS, MAX_VERIFY_RETRIES, MAX_EMPTY_RETRIES,
  configuredMaxTurns, loadEngineeringPrompt, hasCodeMutations,
  pushReal, agentState, reinjectAfterCompaction,
} from "./agent/run-helpers.mjs"
import { MAX_ADVISOR_ROUNDS } from "./advisor/run.mjs"
import { executeToolBatches } from "./agent/execute-tools.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SYSTEM_PROMPT = readFileSync(join(__dirname, "prompts", "system.md"), "utf8")
const DISCIPLINE_RULES = readFileSync(join(__dirname, "prompts", "discipline.md"), "utf8")
const MAIN_OVERLAY = readFileSync(join(__dirname, "prompts", "main.md"), "utf8")
let _EXPLORE, _CODER, _PLAN, _ENG_CODER, _ENG_MAIN, _ENG_SUB, _CONSULT
try { _EXPLORE = readFileSync(join(__dirname, "prompts", "explore.md"), "utf8") } catch { _EXPLORE = "" }
try { _CODER = readFileSync(join(__dirname, "prompts", "coder.md"), "utf8") } catch { _CODER = "" }
try { _PLAN = readFileSync(join(__dirname, "prompts", "plan.md"), "utf8") } catch { _PLAN = "" }
try { _ENG_CODER = readFileSync(join(__dirname, "prompts", "eng-coder.md"), "utf8") } catch { _ENG_CODER = "" }
try { _ENG_MAIN = readFileSync(join(__dirname, "prompts", "engineering.md"), "utf8") } catch { _ENG_MAIN = "" }
try { _CONSULT = readFileSync(join(__dirname, "prompts", "consult.md"), "utf8") } catch { _CONSULT = "" }
try { _ENG_SUB = readFileSync(join(__dirname, "prompts", "engineering-sub.md"), "utf8") } catch { _ENG_SUB = "" }

/** AUTO mode reminder (CLI parity, agent.mjs:48 — same wording, byte-identical). */
const AUTO_REMINDER =
  "[System reminder: AUTO mode is active — all tool calls are automatically approved without asking.]"

/** Engineering mode reminder — shared with the eng tool (CLI parity). */
export const ENG_ON_REMINDER =
  "[System reminder: engineering mode is ON — design-before-code enforced. " +
  "Workflow: Requirements doc → Design doc → advisor(type='design') → " +
  "user approval → eng-coder implementation. Code changes go through eng-coder " +
  "subagents only. Advisor calls are NOT per-turn-mandatory — call only at " +
  "flow nodes or when the user asks.]"

/** Typed error for turn-limit exhaustion — consumers can detect and offer "Continue?" prompt */
export class ContinueError extends Error {
  constructor(turns) { super(`Agent reached max turns (${turns}).`); this.turns = turns }
}

export { builtinTools } from "./tools.mjs"

/**
 * Run the agent loop.
 * @param {object} opts - { depth, role, maxTurns } for subagent context
 */
export async function runAgent(provider, cwd, input, callbacks = {}, signal, autoApprove = true, opts = {}) {
  const { depth = 0, role = null, maxTurns: overrideTurns, mcpServers, skills, engState, engDesignReviewed, resume = false } = opts

  // Live autoApprove read (CLI parity: agent.autoApprove is a live field, not a snapshot).
  // The panel passes a getter because approve-all / the AUTO toolbar button flip the flag
  // MID-TURN — a plain boolean snapshot could never see it. The permission gate and the
  // AUTO reminder both re-read it on every iteration.
  const getAuto = typeof autoApprove === "function" ? autoApprove : () => autoApprove

  const agentTools = depth === 0
    ? [taskTool, recentChangesTool, subagentTool, planTool, goalTool, skillTool, verifyTool, timerTool, advisorTool, engTool, consultStartTool, consultCheckTool, consultStopTool]
    : role === "eng-coder"
      ? [taskTool, recentChangesTool, planTool, timerTool, advisorTool, verifyTool] // eng-coder: design review + verify gates
      : [taskTool, recentChangesTool] // subagents get fewer meta-tools

  // MCP tools: idempotent connect + expand into NATIVE tools (CLI parity, MCP.md D1/D2).
  // Top level only; failures never block — each warning is injected as a reminder.
  let mcpTools = []
  const mcpWarnings = []
  if (depth === 0 && Array.isArray(mcpServers) && mcpServers.length > 0) {
    try {
      const { connectMcpServersExpanded } = await import("./mcp.mjs")
      const r = await connectMcpServersExpanded(mcpServers)
      mcpTools = r.tools
      mcpWarnings.push(...r.warnings)
    } catch { /* expansion failure is non-fatal — the model just lacks MCP tools this turn */ }
  }

  // Subagent role-based tool filtering: explore/plan get read-only tools only
  const isReadOnlyRole = depth > 0 && (role === "explore" || role === "plan" || role === "consult")
  const tools = [
    ...(isReadOnlyRole ? builtinTools.filter((t) => t.readonly) : builtinTools),
    ...(specForModel(provider.model).multimodal ? [readImageTool] : []),
    ...agentTools,
    ...mcpTools,
    ...(opts.extraTools ?? []), // caller-injected tools (e.g. consult's main_history)
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
  let cfgShell = null
  let cfgSubagentModel = null
  let cfgSubagentModels = null
  let cfgSubagentTurns = 100
  let cfgMaxTurns = 100
  let cfgConsultModels = []
  let cfgProviders = []
  let cfgWebsearch = { provider: "tavily", apiKey: "" } // structured search; empty key → Bing fallback
  try {
    const raw = loadRaw()
    advisorCfg = raw.agent?.advisor ?? { enabled: false }
    cfgEngineering = raw.agent?.engineering ?? false
    cfgVerifyGuard = raw.agent?.verifyGuard === true // opt-in, CLI parity
    cfgCompactThreshold = raw.agent?.compactThreshold ?? null // null = auto from model context
    cfgProxy = normalizeProxy(raw.proxy) // web tools consult agent.config.proxy (resolveWebProxy)
    cfgShell = typeof raw.shell === "string" && raw.shell ? raw.shell : null // bash tool shell override (CLI parity)
    cfgSubagentModel = raw.agent?.subagentModel ?? null // default subagent model override (CLI parity)
    cfgSubagentModels = raw.agent?.subagentModels ?? {} // per-type subagent model overrides (CLI parity)
    cfgSubagentTurns = raw.agent?.subagentTurns ?? 100 // subagent turn cap (CLI parity)
    cfgMaxTurns = raw.agent?.maxTurns ?? 100
    cfgConsultModels = raw.agent?.consultModels ?? [] // consultation model list (CONSULTATION.md)
    cfgProviders = resolveProviders().providers // for subagent model overrides
    cfgWebsearch = raw.websearch ?? { provider: "tavily", apiKey: "" }
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
    _advisorSession: null,
    _lastAdvisorOutput: null, // full review output from the most recent advisor call (convergence rounds inject it verbatim)
    _engDesignToken: engState?.engDesignToken ?? null,
    _engDesignReviewed: engDesignReviewed === true, // eng-coder children arrive pre-authorized
    _calledAdvisorThisRun: false, _mutatedThisRun: false,
    _lastEngState: engineering, _pendingReminders: [],
    config: {
      advisor: advisorCfg,
      agent: { engineering, subagentModel: cfgSubagentModel, subagentModels: cfgSubagentModels, subagentTurns: cfgSubagentTurns, maxTurns: cfgMaxTurns, verifyGuard: cfgVerifyGuard, compactThreshold: cfgCompactThreshold, consultModels: cfgConsultModels },
      proxy: cfgProxy, shell: cfgShell, providersList: cfgProviders,
      websearch: cfgWebsearch,
    },
  }

  // Live state channel for the parent (eng-coder mutation merge) — the caller gets a
  // reference to the same array, so it stays current as the child touches files.
  if (opts.stateSink) opts.stateSink.touchedFiles = agent._touchedFiles
  const platform = { win32: "Windows", darwin: "macOS", linux: "Linux" }[os.platform()] ?? os.platform()

  // System prompt — engineering mode replaces the standard discipline block with
  // engineering.md (or engineering-sub.md for eng-coder) + project METHODOLOGY.md (CLI parity).
  const engPromptActive = engineering && (depth === 0 || role === "eng-coder")
  const engResult = engPromptActive ? loadEngineeringPrompt(cwd, role) : null
  // consult children: bare system prompt + consult.md overlay — the coding discipline block
  // is irrelevant to a read-only diagnosis and explore.md's persona would CONFLICT with the
  // consultant persona (meta-review D8/D13).
  let base = role === "consult"
    ? SYSTEM_PROMPT
    : engPromptActive
      ? (engResult.prompt ? `${SYSTEM_PROMPT}\n\n${engResult.prompt}` : SYSTEM_PROMPT)
      : `${SYSTEM_PROMPT}\n\n${DISCIPLINE_RULES}`
  if (depth > 0 && role) {
    const overlay = { explore: _EXPLORE, coder: _CODER, plan: _PLAN, "eng-coder": _ENG_CODER, consult: _CONSULT }[role] || ""
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
    // MCP server config (array of { name, command?, args?, env?, url?, wsUrl?, headers? } — shared config.json).
    // Tools are EXPANDED into the tool table (MCP.md D1) — this is informational only.
    if (mcpServers && mcpServers.length > 0) {
      const list = mcpServers.map((cfg) => {
        const desc = cfg.wsUrl ? cfg.wsUrl : cfg.url ? cfg.url : `stdio (${cfg.command} ${(cfg.args ?? []).join(" ")})`
        return `  - ${cfg.name}: ${desc}`
      }).join("\n")
      const toolCount = mcpTools.length
      history.push({ role: "user", content: `[System: MCP servers configured (${toolCount} tools expanded into your toolset — call them directly):\n${list}]` })
    }
    // MCP connection warnings (failures never block — MCP.md D6)
    for (const w of mcpWarnings) {
      history.push({ role: "user", content: `[System reminder: ${w}]` })
    }
    // Skills from .thincoder/skills/
    if (skills && skills.length > 0) {
      const list = skills.map((s) => `### ${s.name}\n${s.content}`).join("\n\n")
      history.push({ role: "user", content: `[System: available skills from .thincoder/skills/ — use the skill tool to load one when relevant. Available skills:\n\n${list}]` })
    }
  }

  if (depth === 0 && freshMachineLine) {
    if (getAuto()) {
      history.push({ role: "user", content: AUTO_REMINDER })
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

  // resume (interrupt continuation): the input is already in history — pushing it
  // again would duplicate the user message (CLI setup.mjs resume parity).
  if (!resume) pushReal(history, fullHistory, { role: "user", content: input })

  // Machine-only injections (editor context, etc.) — pushed to the MACHINE line ONLY,
  // never into fullHistory (CLI parity: automatic context must not pollute the
  // human-readable record or the session-restore display). Marked transient so
  // persistence layers can drop them. Accepts an array OR a single message —
  // collectEditorInjection returns one object, and a bare for...of over it threw
  // "object is not iterable" on every send with an active editor (2211d46 bug).
  const injections = Array.isArray(opts.injections) ? opts.injections : (opts.injections ? [opts.injections] : [])
  for (const inj of injections) {
    if (inj && typeof inj.content === "string") {
      history.push({ role: "user", content: inj.content, transient: true })
    }
  }

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

  try {
  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) { traceStop(`agent loop turn ${turn}: aborted at loop head`) ; throw new DOMException("Aborted", "AbortError") }

    // Context compaction check — only at safe points: history ends with a complete
    // exchange (user input or tool result), never mid-assistant (CLI parity D1).
    const lastRole = history.at(-1)?.role
    if (lastRole === "user" || lastRole === "tool") {
      try {
        // Measured baseline path (CLI parity D3): the last response's prompt_tokens is the
        // true full-context cost; messages appended since are estimated as increments.
        // tools schemas ride along for the pure-estimation overhead; the signal cancels
        // the in-flight summary request on Stop (CLI parity).
        const compacted = await compactHistory(history, systemPrompt, provider, cfgCompactThreshold, {
          lastPromptTokens: agent._lastPromptTokens,
          usageAtLen: agent._usageAtLen,
        }, toolSchemas, signal)
        if (compacted) {
          history.length = 0
          history.push(...compacted)
          // Measured baseline is invalidated along with old history — fall back to estimation
          agent._lastPromptTokens = null
          agent._usageAtLen = null
          agent._compressFailures = 0
          reinjectAfterCompaction(history, agent, getAuto)
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
            reinjectAfterCompaction(history, agent, getAuto)
          }
        }
      }
    }

    // Live AUTO reminder (CLI parity, agent.mjs:158): approve-all / the AUTO button can
    // flip the flag mid-turn, and compaction can drop the earlier reminder. Re-read the
    // live flag every iteration — the model must know AUTO turned on without waiting
    // for the next user message.
    if (getAuto() && !history.some((m) => m.content === AUTO_REMINDER)) {
      history.push({ role: "user", content: AUTO_REMINDER })
    }

    // Flush pending reminders queued by meta-tools (eng enter/exit, etc.)
    if (agent._pendingReminders.length > 0) {
      for (const reminder of agent._pendingReminders) history.push({ role: "user", content: reminder })
      agent._pendingReminders = []
    }

    const messages = [{ role: "system", content: systemPrompt }, ...history]
    traceStop(`turn ${turn}: calling LLM (history ${history.length} msgs)`)
    const response = await chat(provider, {
      messages,
      tools: toolSchemas,
      onToken: depth === 0 ? callbacks.onToken : null,
      onReasoning: callbacks.onReasoning,
      onWait: callbacks.onWait,
      signal,
    })
    traceStop(`turn ${turn}: LLM stream ended`)

    // Interrupt (Ctrl+I, CLI agent.mjs parity): the SSE stream returned the
    // partial result — commit the partial assistant output, inject the user's
    // message, and throw so the outer loop rebuilds the controller and resumes.
    if (response.interrupted) {
      if (response.content) pushReal(history, fullHistory, { role: "assistant", content: response.content })
      history.push({ role: "user", content: `[User interrupt: ${response.interruptMessage}]` })
      const err = new DOMException("Aborted", "AbortError")
      err.reason = { interrupt: true, message: response.interruptMessage }
      throw err
    }

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

      // Pending tasks check (top-level only). Pushed back AT MOST ONCE per task-list
      // state (CLI parity): an unbounded loop stranded the model when a pending item
      // could not be resolved. Updating the list via the task tool resets the budget.
      if (depth === 0) {
        const pending = agent._tasks?.filter((t) => t.status === "pending")
        if (pending?.length && (agent._taskPushbacks ?? 0) < 1) {
          agent._taskPushbacks = (agent._taskPushbacks ?? 0) + 1
          pushReal(history, fullHistory, { role: "assistant", content: response.content })
          history.push({
            role: "user",
            content: `[System reminder: you still have pending tasks: ${pending.map((t) => t.title).join(", ")}. Update their status before finishing — if done, mark done; if not applicable, remove them. (This is your only reminder — if you choose not to, finish anyway.)]`,
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
            const consultHint = agent?.config?.agent?.consultModels?.length
              ? " If you suspect the root-cause hypothesis itself may be wrong, consider consult_start for independent diagnoses before more retries."
              : ""
            history.push({
              role: "user",
              content: `[System reminder: ${MAX_VERIFY_RETRIES} verify attempts exhausted and tests are still failing. In your response to the user, you MUST state explicitly: (1) what tests are still failing, (2) what you tried, (3) what you believe the root cause is. Do not present this as complete — the user needs to know the work is unfinished.${consultHint}]`,
            })
            continue
          }
        }

        // Advisor guard (CLI completion.mjs parity): active by default when
        // advisor.enabled is set (opt-out via guard: false), NEVER in
        // engineering mode (engineering has its own mandatory gates).
        // Cap sync (CLI b74e413): beyond MAX_ADVISOR_ROUNDS the advisor tool
        // refuses reviews (run.mjs convergence cap) — pushing back further
        // would loop forever (fix → pushback → cap-refused call → fix …).
        const advisorCfg = agent.config?.advisor
        const advisorReview = advisorCfg?.enabled && advisorCfg?.guard !== false
        if (advisorReview && !agent.config?.agent?.engineering
            && agent._mutatedThisRun && !agent._calledAdvisorThisRun && hasCodeMutations(agent)
            && advisorPushbacks < MAX_ADVISOR_PUSHBACKS
            && (agent._advisorRound || 0) < MAX_ADVISOR_ROUNDS) {
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

    await executeToolBatches(agent, { response, history, fullHistory, toolByName, getAuto, callbacks, signal, cwd, recentSigs, depth })
    traceStop(`turn ${turn}: tool batches complete`)

    // Ctrl+I interrupt during tool execution (CLI agent.mjs parity): skip committing
    // partial tool results — they'd mislead the model. Inject the interrupt and retry.
    if (signal?.reason?.interrupt) {
      history.push({ role: "user", content: `[User interrupt: ${signal.reason.message}]` })
      continue
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
  } finally {
    // Turn-bound cleanup (CONSULTATION.md): abort any leftover consultation sessions
    // started during this turn — no orphan sub-agents past the turn's end.
    cleanupConsultSessions(agent)
  }
}

