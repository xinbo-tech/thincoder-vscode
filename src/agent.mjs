/**
 * agent.mjs — Agent loop for VS Code context.
 * Full thincoder feature set: subagents, plan mode, goal tracking, verify guard.
 */

import { chat } from "./provider.mjs"
import { specForModel } from "./specs.mjs"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { builtinTools, toOpenAISchema, readImageTool } from "./tools.mjs"
import {
  taskTool, recentChangesTool, subagentTool,
  planTool, goalTool, skillTool, verifyTool,
} from "./agent-tools.mjs"
import { compactHistory, buildRepoOutline, injectContext } from "./context.mjs"
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
const MAX_TOOL_RESULT = 8000 // chars — truncate large results to prevent context explosion

export { builtinTools } from "./tools.mjs"

/**
 * Run the agent loop.
 * @param {object} opts - { depth, role, maxTurns } for subagent context
 */
export async function runAgent(provider, cwd, input, callbacks = {}, signal, autoApprove = true, opts = {}) {
  const { depth = 0, role = null, maxTurns: overrideTurns, mcpServers } = opts

  const agentTools = depth === 0
    ? [taskTool, recentChangesTool, subagentTool, planTool, goalTool, skillTool, verifyTool]
    : [taskTool, recentChangesTool] // subagents get fewer meta-tools

  const tools = [...builtinTools, ...(specForModel(provider.model).multimodal ? [readImageTool] : []), ...agentTools]
  const toolSchemas = tools.map(toOpenAISchema)
  const toolByName = new Map(tools.map((t) => [t.name, t]))

  const agent = {
    _tasks: [], _touchedFiles: [], _planMode: false,
    _goal: null, _provider: provider,
    _verifiedThisRun: false,
  }
  const platform = { win32: "Windows", darwin: "macOS", linux: "Linux" }[os.platform()] ?? os.platform()

  // System prompt
  let base = `${SYSTEM_PROMPT}\n\n${DISCIPLINE_RULES}`
  if (depth > 0 && role) {
    const overlay = { explore: _EXPLORE, coder: _CODER, plan: _PLAN }[role] || ""
    base = overlay ? `${overlay}\n\n${base}` : base
  }
  const systemPrompt = `${base}${depth === 0 ? `\n\n${MAIN_OVERLAY}` : ""}\n\nOS: ${platform}. Working directory: ${cwd}.`

  const history = []

  // ─── Context injection (top-level only) ────
  if (depth === 0) {
    injectContext(history, cwd, input)
    // MCP server config
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      const list = Object.entries(mcpServers).map(([name, cfg]) =>
        `  - ${name}: ${cfg.command ? `stdio (${cfg.command} ${(cfg.args || []).join(" ")})` : `http (${cfg.url})`}`
      ).join("\n")
      history.push({ role: "user", content: `[System: configured MCP servers (use mcp tool to connect):\n${list}]` })
    }
  }

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

  history.push({ role: "user", content: input })

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
    const compacted = compactHistory(history, systemPrompt)
    if (compacted) {
      history.length = 0
      history.push(...compacted)
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
          history.push({ role: "assistant", content: response.content })
          history.push({
            role: "user",
            content: `[System reminder: you still have pending tasks: ${pending.map((t) => t.title).join(", ")}. Update their status before finishing.]`,
          })
          continue
        }

        // Verify guard pushback
        if (agent._touchedFiles.length > 0 && !agent._verifiedThisRun && guardPushbacks < MAX_VERIFY_PUSHBACKS) {
          guardPushbacks++
          history.push({ role: "assistant", content: response.content })
          history.push({
            role: "user",
            content: "[System reminder: you modified files but haven't verified. Before finishing: call verify to run syntax checks. If verify reports failures, fix them and run verify again.]",
          })
          continue
        }
      }

      history.push({ role: "assistant", content: response.content })
      if (depth === 0) callbacks.onComplete?.(response.content)
      return response.content
    }

    // ─── Tool calls ─────────────────────────
    history.push({
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

    // Group tool calls into batches — consecutive readonly tools run in parallel
    const batches = []
    for (const tc of response.toolCalls) {
      const tool = toolByName.get(tc.name)
      if (tool?.readonly && batches.length > 0) {
        const last = batches[batches.length - 1]
        if (last.every((item) => item.tool?.readonly)) { last.push({ tc, tool }); continue }
      }
      batches.push([{ tc, tool }])
    }

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

        // Permission gate
        const mutationTools = new Set(["write", "edit", "insert_after", "apply_patch", "delete", "bash"])
        if (!autoApprove && tool && mutationTools.has(toolName) && depth === 0 && callbacks.onPermissionRequired) {
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

        if (depth === 0) callbacks.onToolCall?.(toolName, args)

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

        // Truncate
        if (result.length > MAX_TOOL_RESULT) {
          result = result.slice(0, MAX_TOOL_RESULT) + `\n... (truncated ${result.length - MAX_TOOL_RESULT} chars)`
        }

        return {
          tool_call_id: tc.id, toolName, content: result,
          meta: { args, tool, tc },
        }
      }

      const results = await Promise.all(batch.map(runOne))

      for (const r of results) {
        const { tool_call_id, toolName, content, multimodal, meta } = r

        if (multimodal) {
          history.push({ role: "tool", tool_call_id, content: multimodal.text })
          history.push({ role: "user", content: [{ type: "text", text: multimodal.text }, ...multimodal.images] })
          if (depth === 0) callbacks.onToolResult?.(toolName, multimodal.text)
        } else {
          history.push({ role: "tool", tool_call_id, content })
          if (depth === 0) callbacks.onToolResult?.(toolName, content)
        }

        // Track mutations
        if (meta) {
          const { args, tool } = meta
          if (tool && !tool.readonly) {
            const mutators = ["write", "edit", "insert_after", "apply_patch", "delete"]
            if (mutators.includes(toolName) && args.path) {
              agent._touchedFiles.push(args.path)
            }
            if (toolName === "verify") {
              agent._verifiedThisRun = true
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

    // Goal injection
    if (agent._goal?.status === "active") {
      agent._goal.turnsUsed = (agent._goal.turnsUsed ?? 0) + 1
      history.push({
        role: "user",
        content: `[System reminder: goal active — "${agent._goal.objective}". Turns used: ${agent._goal.turnsUsed}. Complete with the goal tool when criteria are met.]`,
      })
    }
  }

  throw new Error(`Agent reached max turns (${maxTurns}).`)
}

