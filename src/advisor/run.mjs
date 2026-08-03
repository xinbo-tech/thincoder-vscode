/**
 * advisor/run.mjs — advisor execution: tool loop, provider resolution, and the review entry point.
 * VS Code port of thincoder CLI src/advisor/run.mjs (kept in sync with the CLI).
 * Differences from the CLI: tool set uses the VS Code tool implementations (no lsp yet —
 * T19 pending); progress lines are forwarded to the webview tool panel via callbacks.
 */
import { chat } from "../provider.mjs"
import { resolveProviders, findProvider } from "../config-io.mjs"
import { toOpenAISchema, readTool, globTool, grepTool, lsTool, gitTool, codeSearchTool, lspTool } from "../tools/index.mjs"
import { prepareAdvisorMessages } from "./main.mjs"
import { extractPriorIssueTable } from "./history.mjs"

export const MAX_ADVISOR_TURNS = 100
// Mechanical convergence cap — same semantics as the CLI (see CLI advisor/run.mjs).
export const MAX_ADVISOR_ROUNDS = 5

// Context window limits
const MAX_CONTEXT_TOKENS = 120_000
const TOOL_TIMEOUT_MS = 30_000
const REVIEW_TIMEOUT_MS = 300_000

/** Estimate token count from messages (rough: 1 token ≈ 4 chars) */
function estimateTokens(messages) {
  return messages.reduce((sum, msg) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "")
    const toolCalls = msg.tool_calls ? JSON.stringify(msg.tool_calls) : ""
    return sum + Math.ceil((content.length + toolCalls.length) / 4)
  }, 0)
}

/** Compact early messages when context grows too large */
async function compactMessages(messages, _provider) {
  if (messages.length <= 20) return messages
  const system = messages[0]
  const recent = messages.slice(-20)
  const old = messages.slice(1, -20)
  const summary = `Earlier exploration: ${old.length} tool calls completed. Key files examined: ${
    old
      .filter((m) => m.role === "tool")
      .map((m) => m.content?.split("\n")[0]?.slice(0, 50))
      .filter(Boolean)
      .slice(0, 5)
      .join(", ")
  }`
  return [system, { role: "user", content: `[Context compacted] ${summary}` }, ...recent]
}

// The advisor gets read-only exploration tools. The git tool is wrapped to block
// checkpoint create/rewind (CLI parity) — the advisor must not mutate state.
// lsp uses VS Code's native language services (CLI parity — the CLI spawns LSP servers instead).
const advisorGitTool = {
  ...gitTool,
  readonly: true,
  async execute(args, ctx) {
    if (args.action === "checkpoint") {
      if (args.checkpointAction === "create" || args.checkpointAction === "rewind") {
        return "Error: checkpoint create/rewind is disabled in advisor mode. Use diff/status/log only."
      }
    }
    return gitTool.execute(args, ctx)
  },
}
const ADVISOR_TOOLS = [readTool, globTool, grepTool, lsTool, advisorGitTool, lspTool, codeSearchTool]
const ADVISOR_TOOL_SCHEMAS = ADVISOR_TOOLS.map(toOpenAISchema)
const ADVISOR_TOOL_BY_NAME = new Map(ADVISOR_TOOLS.map((t) => [t.name, t]))

/** Compact one-line summary of tool args for panel progress lines. */
function summarizeToolArgs(args) {
  const parts = [args.action, args.path ?? args.pattern ?? args.query].filter((v) => v != null)
  let s = parts.length > 0 ? parts.map(String).join(" ") : JSON.stringify(args)
  s = s.replace(/\s+/g, " ").trim()
  return s.length > 80 ? s.slice(0, 79) + "…" : s
}

/**
 * Run the advisor's tool loop: chat → execute tools → repeat.
 * Stops when the model produces text without tool calls.
 */
async function runAdvisorToolLoop(provider, messages, onOutput, signal, agent, cwd) {
  let turns = 0
  const startTime = Date.now()

  while (true) {
    if (signal?.aborted) return "Advisor: interrupted."

    if (Date.now() - startTime > REVIEW_TIMEOUT_MS) {
      return `Advisor: review timeout after ${Math.round(REVIEW_TIMEOUT_MS / 1000)}s. Partial results may be available. Try again with a narrower scope.`
    }

    if (++turns > MAX_ADVISOR_TURNS) {
      return "Advisor: stopped after " + MAX_ADVISOR_TURNS + " tool rounds — the review appears to be looping. You may retry with a narrower scope."
    }

    // Check context window and compact if needed
    const currentTokens = estimateTokens(messages)
    if (currentTokens > MAX_CONTEXT_TOKENS * 0.8) {
      onOutput?.(`\n[Context compacted: ${currentTokens} tokens → reducing to fit window]\n`)
      messages = await compactMessages(messages, provider)
      if (estimateTokens(messages) > MAX_CONTEXT_TOKENS) {
        return `Advisor: context window limit reached (${currentTokens} tokens). Review incomplete — too many tool calls. Try a narrower scope.`
      }
    }

    const response = await chat(provider, {
      messages,
      tools: ADVISOR_TOOL_SCHEMAS,
      signal: (signal && !signal.aborted) ? signal : null,
      onToken: onOutput ?? null,
      onReasoning: null,
    })

    // No tool calls — this is the final review text
    if (!response.toolCalls?.length) {
      if (!response.content?.trim()) return "Advisor: (empty response — review was inconclusive)"
      return response.content.trim()
    }

    // Push assistant message with tool calls
    messages.push({
      role: "assistant",
      content: response.content || null,
      tool_calls: response.toolCalls.map((tc) => ({
        id: tc.id, type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    })

    // Execute each tool call
    for (const tc of response.toolCalls) {
      const tool = ADVISOR_TOOL_BY_NAME.get(tc.name)
      let args = {}
      let parseError = null
      try {
        args = JSON.parse(tc.arguments || "{}")
      } catch (e) {
        parseError = `Error: invalid JSON in tool arguments: ${e.message}\nRaw arguments: ${(tc.arguments || "").slice(0, 200)}`
      }

      if (parseError) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: parseError })
        continue
      }

      onOutput?.(`\n→ ${tc.name} ${summarizeToolArgs(args)}\n`)
      let result
      if (!tool) {
        result = `Error: unknown tool "${tc.name}". Available: ${[...ADVISOR_TOOL_BY_NAME.keys()].join(", ")}`
      } else {
        // Execute with timeout
        try {
          const toolPromise = tool.execute(args, { cwd, agent, signal })
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`tool timeout after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS)
          )
          result = await Promise.race([toolPromise, timeoutPromise])
        } catch (e) {
          const errorType = e.message.includes("timeout") ? "timeout"
            : e.message.includes("ENOENT") ? "file_not_found"
            : e.message.includes("permission") ? "permission_denied"
            : "execution_error"
          result = `Error (${errorType}): ${e.message}`
        }
      }
      if (typeof result !== "string") result = JSON.stringify(result)

      // Line-aware truncation: preserve line integrity
      const MAX_RESULT_CHARS = 12_000
      if (result.length > MAX_RESULT_CHARS) {
        const lines = result.split("\n")
        let truncated = ""
        let charCount = 0
        let keptLines = 0

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (charCount + line.length + 1 > MAX_RESULT_CHARS) break
          truncated += line + "\n"
          charCount += line.length + 1
          keptLines++
        }

        const remainingLines = lines.length - keptLines
        result = (
          truncated +
          `\n… (truncated: ${remainingLines} more lines, ${result.length} chars total)\n` +
          `To see more content, use: read(path, offset=${keptLines}, limit=200)`
        )
      }

      messages.push({ role: "tool", tool_call_id: tc.id, content: result })
    }
  }
}

/** Resolve the advisor's provider: config advisor.provider/model when set, otherwise the main agent's provider (CLI parity). */
export function resolveAdvisorProvider(agent) {
  const cfg = agent.config?.advisor
  if (cfg?.provider) {
    try {
      const { providers } = resolveProviders()
      const provider = findProvider(providers, cfg.provider)
      const result = cfg.model ? { ...provider, model: cfg.model } : { ...provider }
      if (cfg.thinking === null) result.thinking = undefined  // explicitly off
      else if (cfg.thinking !== undefined) result.thinking = cfg.thinking
      if (cfg.reasoningEffort !== undefined) result.reasoningEffort = cfg.reasoningEffort
      return result
    } catch (e) {
      console.warn(`[advisor] resolveAdvisorProvider: ${e.message}`)
    }
  }
  const provider = { ...agent._provider }
  if (cfg?.model) provider.model = cfg.model
  if (cfg?.thinking === null) provider.thinking = undefined
  else if (cfg?.thinking !== undefined) provider.thinking = cfg.thinking
  if (cfg?.reasoningEffort !== undefined) provider.reasoningEffort = cfg.reasoningEffort
  return provider
}

/** Extract unfixed issues from prior review text */
function extractUnfixedIssues(priorText) {
  if (!priorText) return []
  const lines = priorText.split("\n")
  return lines
    .filter((line) => /\|\s*\d+\s*\|/.test(line))
    .filter((line) => !/fixed|resolved|done|✓|✔/i.test(line))
    .map((line) => line.replace(/\|/g, "").trim())
    .filter(Boolean)
    .slice(0, 10)
}

/**
 * Run an advisor review. reviewType: "code" (default) or "design". Returns review text.
 * @param {string|null} [designToken] — injected into the design-review prompt; the advisor echoes it only on approval.
 * @param {string[]|null} [documents] — design review: explicit list of doc paths; code review: acceptance-criteria docs.
 * @param {string[]|null} [paths] — code review: files/directories to review.
 */
export async function runAdvisorReview(agent, reviewType, callbacks, designToken = null, documents = null, paths = null) {
  const onOutput = callbacks?.onOutput
  const signal = callbacks?.signal
  const cfg = agent.config?.advisor
  const startTime = Date.now()

  // Engineering mode overrides advisor toggle — reviews are mandatory regardless
  if (!cfg?.enabled && !agent.config?.agent?.engineering) {
    return "Advisor: not enabled (set advisor.enabled in config.json)."
  }

  // Mechanical convergence cap — refuse further reviews once the protocol has run its rounds.
  if (reviewType !== "design" && (agent._advisorRound || 0) >= MAX_ADVISOR_ROUNDS) {
    const prior = extractPriorIssueTable(agent.history)
    const unfixed = prior ? extractUnfixedIssues(prior.text) : []

    let message = `Advisor: convergence cap reached after ${MAX_ADVISOR_ROUNDS} rounds.\n`
    if (unfixed.length > 0) {
      message += `\nUnresolved issues from prior rounds:\n${unfixed.map((i) => `- ${i}`).join("\n")}\n`
    } else {
      message += "\nAll prior issues appear resolved.\n"
    }
    message += "\nOptions:\n1. Accept current state and proceed\n2. Manually review specific concerns with read/grep\n3. Start a new session to reset the advisor"

    return message
  }

  const provider = resolveAdvisorProvider(agent)
  // Advisor always works in the agent's cwd — scope is defined by paths/documents.
  const advisorCwd = agent.cwd

  const messages = prepareAdvisorMessages(agent, reviewType, designToken, documents, paths)

  try {
    const result = await runAdvisorToolLoop(provider, messages, onOutput, signal, agent, advisorCwd)

    // Log review statistics for observability
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    const toolCallCount = messages.filter((m) => m.role === "tool").length
    const tokensUsed = estimateTokens(messages)
    onOutput?.(`\n[advisor] Review completed: ${elapsed}s, ${toolCallCount} tool calls, ~${Math.round(tokensUsed / 1000)}k tokens\n`)

    // Only persist the session on success — timeout/interrupt/empty results
    // would poison the next review call.
    if (!result.trimStart().startsWith("Advisor:")) {
      agent._advisorSession = reviewType === "design" ? null : messages
    } else {
      agent._advisorSession = null
    }
    return result
  } catch (e) {
    if (e.name === "AbortError" && signal?.reason?.interrupt) throw e

    const errorType = e.message.includes("rate limit") || e.message.includes("429") ? "rate limit"
      : e.message.includes("timeout") ? "timeout"
      : e.message.includes("network") || e.message.includes("ECONNREFUSED") ? "network"
      : e.message.includes("context length") ? "context_too_long"
      : "unknown"

    const retryAdvice = errorType === "rate limit"
      ? "Wait a moment and retry. Consider using a cheaper model for advisor."
      : errorType === "timeout"
        ? "The model took too long. Try with a narrower scope."
        : errorType === "context_too_long"
          ? "Reduce the scope (fewer files/paths) or use a model with larger context window."
          : "You may retry or proceed to verify manually."

    agent._advisorSession = null // failed review: don't keep a half-built conversation
    return `Advisor: review failed (${errorType}) — ${e.message || "unknown error"}. ${retryAdvice}`
  }
}
