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
} from "./agent-tools.mjs"
import { compactHistory, injectContext } from "./context.mjs"
import * as os from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SYSTEM_PROMPT = readFileSync(join(__dirname, "prompts", "system.md"), "utf8")
const DISCIPLINE_RULES = readFileSync(join(__dirname, "prompts", "discipline.md"), "utf8")
const MAIN_OVERLAY = readFileSync(join(__dirname, "prompts", "main.md"), "utf8")
let _EXPLORE, _CODER, _PLAN
try { _EXPLORE = readFileSync(join(__dirname, "prompts", "explore.md"), "utf8") } catch { _EXPLORE = "" }
try { _CODER = readFileSync(join(__dirname, "prompts", "coder.md"), "utf8") } catch { _CODER = "" }
try { _PLAN = readFileSync(join(__dirname, "prompts", "plan.md"), "utf8") } catch { _PLAN = "" }

const DEFAULT_MAX_TURNS = 100
const STALL_WINDOW = 5
const STALL_THRESHOLD = 3
const MAX_VERIFY_PUSHBACKS = 2
const MAX_VERIFY_RETRIES = 3
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

/**
 * Run the agent loop.
 * @param {object} opts - { depth, role, maxTurns } for subagent context
 */
export async function runAgent(provider, cwd, input, callbacks = {}, signal, autoApprove = true, opts = {}) {
  const { depth = 0, role = null, maxTurns: overrideTurns, mcpServers, skills } = opts

  const agentTools = depth === 0
    ? [taskTool, recentChangesTool, subagentTool, planTool, goalTool, skillTool, verifyTool, timerTool]
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

  const agent = {
    _tasks: [], _touchedFiles: [], _planMode: false,
    _goal: null, _provider: provider,
    _verifiedThisRun: false, _pendingTimers: [],
  }
  const platform = { win32: "Windows", darwin: "macOS", linux: "Linux" }[os.platform()] ?? os.platform()

  // System prompt
  let base = `${SYSTEM_PROMPT}\n\n${DISCIPLINE_RULES}`
  if (depth > 0 && role) {
    const overlay = { explore: _EXPLORE, coder: _CODER, plan: _PLAN }[role] || ""
    base = overlay ? `${overlay}\n\n${base}` : base
  }
  const systemPrompt = `${base}${depth === 0 ? `\n\n${MAIN_OVERLAY}` : ""}\n\nOS: ${platform}. Working directory: ${cwd}.`

  // Dual-line history. Top-level runs use PERSISTENT lines passed in via opts (survive across calls,
  // written to the session file by chat-panel): history = machine context (compaction shrinks it),
  // fullHistory = never-compacted human-readable record. Subagents always use throwaway local lines.
  // Old sessions / first turn: seed the machine line from the human line (correctness over tokens).
  const fullHistory = depth === 0 ? (opts.fullHistory ?? (opts.fullHistory = [])) : []
  const history = depth === 0
    ? (opts.history ?? (opts.history = [...fullHistory]))
    : []

  // ─── Context injection (top-level only, fresh machine line only) ────
  // These machine-only injections are transient context; a persistent machine line already carries
  // them from prior turns, so only inject when starting a brand-new (empty) machine line.
  const freshMachineLine = history.length === 0
  if (depth === 0 && freshMachineLine) {
    injectContext(history, cwd, input)
    // MCP server config
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      const list = Object.entries(mcpServers).map(([name, cfg]) =>
        `  - ${name}: ${cfg.command ? `stdio (${cfg.command} ${(cfg.args || []).join(" ")})` : `http (${cfg.url})`}`
      ).join("\n")
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
  const maxTurns = overrideTurns || DEFAULT_MAX_TURNS
  const recentSigs = []
  let guardPushbacks = 0

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    // Context compaction check
    const compacted = await compactHistory(history, systemPrompt, provider)
    if (compacted) {
      history.length = 0
      history.push(...compacted)

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

    const messages = [{ role: "system", content: systemPrompt }, ...history]
    const response = await chat(provider, {
      messages,
      tools: toolSchemas,
      onToken: depth === 0 ? callbacks.onToken : null,
      onReasoning: callbacks.onReasoning,
      onWait: callbacks.onWait,
      signal,
    })

    if (response.usage && depth === 0) callbacks.onUsage?.(response.usage)

    // ─── No tool calls ──────────────────────
    if (response.toolCalls.length === 0) {
      if (!response.content) {
        if (response.reasoning) {
          // Model output only reasoning (thinking) — treat as content
          response.content = response.reasoning
        } else {
          throw new Error("LLM returned empty response.")
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

        // Verify guard — push model to verify mutated files before completion
        if (agent._touchedFiles.length > 0 && !agent._verifiedThisRun && guardPushbacks < MAX_VERIFY_PUSHBACKS) {
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
      }

      pushReal(history, fullHistory, { role: "assistant", content: response.content })
      if (depth === 0) callbacks.onComplete?.(response.content)
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

        // Track mutations — use tool metadata, not a hardcoded list
        if (meta) {
          const { args, tool } = meta
          if (tool && !tool.readonly && !tool.sideEffectExempt) {
            if (args?.path) agent._touchedFiles.push(args.path)
            if (toolName === "verify") agent._verifiedThisRun = true
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

