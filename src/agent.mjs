/**
 * agent.mjs — Agent loop for VS Code context.
 * Full thincoder feature set: subagents, plan mode, goal tracking, verify guard.
 * Setup (tools/config/prompt/history/injection) lives in agent/setup.mjs.
 */
import { chat } from "./provider.mjs"
import { specForModel } from "./specs.mjs"
import { compactHistory, truncateFallback, COMPRESS_FAILURE_LIMIT } from "./compact.mjs"
import { cleanupConsultSessions } from "./agent-tools/consult.mjs"
import { traceStop } from "./extension/stop-trace.mjs"
import {
  MAX_ADVISOR_PUSHBACKS, MAX_VERIFY_PUSHBACKS, MAX_VERIFY_RETRIES, MAX_EMPTY_RETRIES,
  configuredMaxTurns, hasCodeMutations,
  pushReal, agentState, reinjectAfterCompaction,
} from "./agent/run-helpers.mjs"
import { MAX_ADVISOR_ROUNDS } from "./advisor/run.mjs"
import { executeToolBatches } from "./agent/execute-tools.mjs"
import { setupAgentRun, AUTO_REMINDER } from "./agent/setup.mjs"

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
  const depth = opts.depth ?? 0
  const role = opts.role ?? null
  const overrideTurns = opts.maxTurns

  // Live autoApprove read (CLI parity: agent.autoApprove is a live field, not a snapshot).
  // The panel passes a getter because approve-all / the AUTO toolbar button flip the flag
  // MID-TURN — a plain boolean snapshot could never see it. The permission gate and the
  // AUTO reminder both re-read it on every iteration.
  const getAuto = typeof autoApprove === "function" ? autoApprove : () => autoApprove

  const { agent, history, fullHistory, toolByName, toolSchemas, cfgVerifyGuard, cfgCompactThreshold, systemPrompt } =
    await setupAgentRun({ provider, cwd, input, opts, depth, role, getAuto })

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
      // onToken gate: depth 0 always; consult children are exempt so their OUTPUT streams
      // into the consultation panel (consult-UI review 2026-08-15). Escalates opt
      // in via opts.streamOutput (three-way review 2026-08-16 — a long surgery is silent
      // without it). Other subagents never pass onToken, so their behavior is unchanged.
      onToken: depth === 0 || role === "consult" || opts.streamOutput === true ? callbacks.onToken : null,
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

        // Advisor guard (CLI completion.mjs parity): OPT-IN ONLY
        // (advisor.guard === true, default OFF — 2026-08-21 semantic
        // refactor), NEVER in engineering mode (engineering has its own
        // mandatory gates). The advisor tool itself is always available.
        // Cap sync (CLI b74e413): beyond MAX_ADVISOR_ROUNDS the advisor tool
        // refuses reviews (run.mjs convergence cap) — pushing back further
        // would loop forever (fix → pushback → cap-refused call → fix …).
        const advisorCfg = agent.config?.advisor
        const advisorReview = advisorCfg?.guard === true
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

    // Machine-line warning (ARCHITECTURE.md §285-287): tell the model some of its tool
    // calls were dropped (non-standard provider format) so it does not assume they ran.
    if (response.droppedToolCalls > 0) {
      history.push({
        role: "user",
        content: `[System reminder: ${response.droppedToolCalls} malformed tool_calls from the provider response were dropped (non-standard provider format).]`,
      })
    }

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
