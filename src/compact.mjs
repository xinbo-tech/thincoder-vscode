/**
 * compact.mjs — context compaction (CLI CONTEXT-COMPACTION.md parity)
 * Split out of context.mjs (both files stay under the 500-line hard limit).
 * The unified compaction spec lives in thincoder/docs/design/CONTEXT-COMPACTION.md.
 */
import { chat } from "./provider.mjs"
import { specForModel } from "./config.mjs"
import { safeSliceUTF16 } from "./agent/run-helpers.mjs"
import { performance } from "node:perf_hooks"

// ─── Model-aware compaction thresholds ──────────────────────────

/** Fraction of context window to use as the compaction trigger point.
 *  60% leaves headroom for injected context (git/dir/outline/memory/doc, 30-50K/turn)
 *  AND the model's response (output + reasoning — some models maxOutput 384K).
 *  CLI parity (CONTEXT-COMPACTION.md D2). */
const THRESHOLD_FRACTION = 0.60

/** Estimated token cost of one image part (CLI parity: legacy 256 underestimated real image costs). */
const IMAGE_TOKEN_ESTIMATE = 2000

/** No dedicated head (CLI parity): in multi-task sessions the earliest messages are
 *  typically a COMPLETED earlier task — preserving them verbatim anchored the model's
 *  attention on stale work after compaction. Everything before the tail goes into the
 *  summary (which distinguishes completed vs in-progress work). The tool_calls-extension
 *  below is defensive for a future KEEP_HEAD > 0. */
const KEEP_HEAD = 0

/** After this many consecutive summary failures, degrade to deterministic truncation (CLI parity D6). */
export const COMPRESS_FAILURE_LIMIT = 3

/** Truncation fallback note (used when the summary LLM fails repeatedly; no LLM call). */
const FALLBACK_NOTE =
  "[Context was truncated after repeated summarization failures. " +
  "The middle portion of earlier work was dropped WITHOUT a summary. " +
  "Re-verify any state you need with tools before relying on it.]\n\n"

/** Rough token estimate for a text string — ASCII/4 + non-ASCII/1 (CLI rate.mjs formula). */
function estimateText(s) {
  let nonAscii = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) nonAscii++
  return Math.ceil((s.length - nonAscii) / 4) + nonAscii
}

/**
 * Calculate the compaction threshold for a given model.
 * Uses 60% of the model's actual context window — no arbitrary caps.
 */
function compactionThreshold(provider) {
  const model = provider?.model || ""
  const ctxWindow = specForModel(model).context
  return Math.floor(ctxWindow * THRESHOLD_FRACTION)
}

/**
 * Calculate how many messages to keep after compaction.
 * Scales with context window: ~30 per 100K tokens, capped at 40% of history
 * (CLI parity D4 — replaces the old fixed tail).
 */
function keepTailSize(provider, historyLen) {
  const ctxWindow = specForModel(provider?.model || "").context
  return Math.min(Math.max(10, Math.floor((ctxWindow / 100_000) * 30)), Math.floor(historyLen * 0.4))
}

export const SUMMARIZE_PROMPT = `You are a conversation compressor. Summarize the following agent work log. Write in first person ("I") — these are handover notes to your future self.

Requirements:
- Preserve the user's original request and what task you're working on
- Distinguish COMPLETED vs IN-PROGRESS work: completed tasks get a ONE-LINE recap each (what was done, key outcome); spend the detail budget on unresolved issues, next steps, and the CURRENT task
- The user's most recent request defines the current task — anchor on it. Earlier requests are likely already completed and only need the one-line recap; do NOT preserve them at full fidelity
- Explicitly list FILES CHANGED: every modified file path plus a one-line "why" — so post-compaction work can re-locate what was edited and where
- Preserve design decisions: architecture choices, API contracts, naming conventions, trade-off reasoning
- Explicitly list UNRESOLVED ISSUES / TODOs: anything still open plus the next steps — so post-compaction recovery knows where to resume
- Drop: pleasantries, repetition, fine-grained tool output
- Be honest: mark uncertain items as "unverified"; don't present guesses as facts
- Output as bullet points; err on the long side in the 1M-context era

Work log:
`

/**
 * Estimate token count from message array (CLI parity: reasoning_content + tool_calls + images counted).
 */
function estimateTokens(messages) {
  let tokens = 0
  for (const m of messages) {
    if (typeof m.content === "string") {
      tokens += estimateText(m.content)
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text") tokens += estimateText(part.text)
        else if (part.type === "image_url") tokens += IMAGE_TOKEN_ESTIMATE
      }
    }
    if (typeof m.reasoning_content === "string") tokens += estimateText(m.reasoning_content)
    for (const tc of m.tool_calls ?? []) {
      tokens += estimateText(tc.function?.name ?? "") + estimateText(tc.function?.arguments ?? "")
    }
  }
  return tokens
}

/**
 * Compact history with LLM summarization for old messages.
 * Returns a new history array or null if no compaction needed.
 * @param {object} provider - provider config for the summarization LLM call
 * @param {number|null} [explicitThreshold] - config agent.compactThreshold override (null = auto from model)
 * @param {object|null} [baseline] - { lastPromptTokens, usageAtLen } measured prompt-token baseline
 *   from the previous response (CLI parity D3). When present, the trigger check is
 *   baseline + estimation of messages appended since; otherwise pure estimation of system+history.
 * @param {Array|null} [tools] - tool schemas for the pure-estimation overhead (CLI parity):
 *   system prompt AND tools schema are part of every request but not in history — without
 *   them the first-turn/restored estimate under-counts and may never trigger compaction.
 * @param {AbortSignal|null} [signal] - user interrupt (CLI parity). The summary LLM call can
 *   take minutes on slow reasoning models — without the signal, Stop waits for the summary
 *   to finish (or the 10-minute fetch ceiling) before the loop notices the abort.
 * @param {object|null} [callbacks] - { onCompressStart } — fires RIGHT BEFORE the summary LLM
 *   call with { messages: N } (CONTEXT-COMPACTION §7 D-C1: compression lifecycle visibility —
 *   the webview status line; never the summary body). No-op when absent (F4).
 * @param {object|null} [agent] - carrier for completion info (CLI parity): sets
 *   agent._lastCompressInfo = { mode:"summary", tokensFreed, elapsedMs } so the caller's
 *   onCompress renders "Compressed: N tokens freed (Xs)".
 * @throws when the summarization LLM fails — the CALLER counts consecutive failures and
 *   degrades to truncateFallback (CLI parity D6; the heuristic summary is deprecated).
 */
export async function compactHistory(history, systemPrompt, provider, explicitThreshold = null, baseline = null, tools = null, signal = null, callbacks = null, agent = null) {
  const threshold = explicitThreshold != null ? explicitThreshold : compactionThreshold(provider)
  const overhead = estimateText(systemPrompt) + (tools ? estimateText(JSON.stringify(tools)) : 0)
  const total = baseline?.lastPromptTokens != null
    ? baseline.lastPromptTokens + estimateTokens(history.slice(baseline.usageAtLen ?? history.length))
    : overhead + estimateTokens(history)
  if (total < threshold) return null

  // Keep a model-aware number of recent messages — keepTailSize already caps at 40% of history
  const keepCount = keepTailSize(provider, history.length)
  if (history.length - keepCount <= 1) {
    // No middle section to summarize (history too short, typically one giant message) —
    // degrade to deterministic per-message shrinking (CLI parity D6). Shrink keeps the array
    // LENGTH unchanged (same indices, no note inserted) — the caller uses that to distinguish
    // it from a rebuild and must NOT reset the end-of-run distillation boundary.
    return shrinkOversized(history)
  }

  // Head protection: the head must not end with dangling tool_calls — when an assistant
  // message declares tool_calls, all its tool responses stay in head (CLI parity D5).
  let headEnd = KEEP_HEAD
  if (history[headEnd - 1]?.role === "assistant" && history[headEnd - 1].tool_calls?.length) {
    while (headEnd < history.length && history[headEnd].role === "tool") headEnd++
  }

  // Tail protection: ensure the cut point doesn't split tool_calls from their tool responses.
  // If a message in the tail is a tool message whose assistant was in oldMessages,
  // pull that assistant into the tail (avoids protocol 400: orphan tool messages).
  let tailStart = history.length - keepCount
  const tailToolIds = new Set()
  for (let i = tailStart; i < history.length; i++) {
    if (history[i].role === "tool") tailToolIds.add(history[i].tool_call_id)
  }
  for (let i = tailStart - 1; i >= headEnd; i--) {
    const m = history[i]
    if (m.role === "assistant" && m.tool_calls?.some((tc) => tailToolIds.has(tc.id))) {
      tailStart = i
      break
    }
  }
  // Skip orphan tool messages at the new tail boundary (tool whose assistant was pulled in above)
  while (tailStart > headEnd && history[tailStart].role === "tool") {
    tailStart++
  }
    // REVERSE protection (2026-08-16): if the tail opens with an assistant declaring
    // tool_calls whose tool results were cut just before tailStart, extend tailStart
    // back over them — dangling tool_calls in the sent history 400 on strict providers.
    if (history[tailStart]?.role === "assistant" && history[tailStart].tool_calls?.length) {
      const needIds = new Set(history[tailStart].tool_calls.map((tc) => tc.id))
      const haveIds = new Set()
      for (let i = tailStart + 1; i < history.length && history[i].role === "tool"; i++) {
        haveIds.add(history[i].tool_call_id)
      }
      if (needIds.size > 0 && [...needIds].some((id) => !haveIds.has(id))) {
        let back = tailStart - 1
        while (back >= headEnd && history[back]?.role === "tool") back--
        // include the missing tool results (they sit contiguously before the assistant)
        tailStart = back + 1
      }
    }
  
  if (tailStart <= headEnd) return null

  const oldMessages = history.slice(headEnd, tailStart)
  const recentMessages = history.slice(tailStart)

  // Serialize old messages for the summary LLM
  const serialized = oldMessages
    .map((m) => {
      let prefix = `[${m.role}]`
      if (m.tool_calls) prefix += ` [called tools: ${m.tool_calls.map((tc) => tc.function?.name ?? tc.name).join(", ")}]`
      const cap = m.role === "user" ? 8000 : 2000
      // Multimodal messages (array content): extract the TEXT parts — the image itself
      // can't be summarized, but accompanying text must not be silently lost (CLI parity).
      let text = ""
      if (typeof m.content === "string") text = m.content
      else if (Array.isArray(m.content)) text = m.content.filter((p) => p?.type === "text").map((p) => p.text ?? "").join(" ")
      return `${prefix} ${safeSliceUTF16(text, cap)}`
    })
    .join("\n")

  if (!provider) {
    throw new Error("compaction: no provider available for summarization")
  }
  // Silent by design (D11): no streaming callbacks — the compaction process must not reach the frontend.
  // The signal rides along (CLI parity): Stop cancels the in-flight summary instead of
  // waiting for it to finish.
  // Compression visibility (CONTEXT-COMPACTION §7 D-C1/D-C3): the frontend learns the
  // compression STARTED right before the LLM call ("Compressing context… / summarizing
  // N messages" status line) — only the lifecycle is surfaced, never the summary body.
  // N = the number of history messages being summarized.
  callbacks?.onCompressStart?.({ messages: oldMessages.length })
  const startedAt = performance.now()
  const resp = await chat({ ...provider, thinking: null, reasoningEffort: null }, {
    messages: [{ role: "user", content: SUMMARIZE_PROMPT + serialized }],
    signal: signal ?? null,
  })
  const summary = resp.content || ""

  const result = [
    ...history.slice(0, headEnd), // head (empty by default — KEEP_HEAD=0, CLI parity)
    {
      role: "user",
      content:
        "[Context was automatically compacted. Below is a summary of earlier work. " +
        "Treat it as notes, not proof — trust its conclusions (don't redo what it reports as done) " +
        "but re-verify transient state with tools. Check memory_search for any missing decisions.]\n\n" +
        `<handoff_notes>\n${summary}\n</handoff_notes>`,
    },
    {
      role: "assistant",
      content: "Understood. I'll continue from these notes, re-verifying anything transient.",
    },
    ...recentMessages,
  ]

  // Completion info for the compression status line (D-C2/D-C3): tokens freed = the
  // pre-compression prompt estimate (`total` — the value that tripped the threshold,
  // incl. system/tools overhead) minus the post-compression estimate on the same basis.
  // Elapsed = the summary call + splice duration. agent.mjs forwards this to onCompress.
  if (agent) {
    agent._lastCompressInfo = {
      mode: "summary",
      tokensFreed: Math.max(0, Math.round(total - (estimateTokens(result) + overhead))),
      elapsedMs: performance.now() - startedAt,
    }
  }
  return result
}

/**
 * Deterministic truncation fallback (CLI compressFallback parity): drops the middle
 * WITHOUT an LLM call, keeping head + a blunt note + tail. Returns a new array or null.
 */
export function truncateFallback(history, provider) {
  const keepCount = keepTailSize(provider, history.length)
  let headEnd = KEEP_HEAD
  if (history[headEnd - 1]?.role === "assistant" && history[headEnd - 1].tool_calls?.length) {
    while (headEnd < history.length && history[headEnd].role === "tool") headEnd++
  }
  let tailStart = history.length - keepCount
  const tailToolIds = new Set()
  for (let i = tailStart; i < history.length; i++) {
    if (history[i].role === "tool") tailToolIds.add(history[i].tool_call_id)
  }
  for (let i = tailStart - 1; i >= headEnd; i--) {
    const m = history[i]
    if (m.role === "assistant" && m.tool_calls?.some((tc) => tailToolIds.has(tc.id))) {
      tailStart = i
      break
    }
  }
  while (tailStart > headEnd && history[tailStart].role === "tool") tailStart++
    // REVERSE protection (2026-08-16): if the tail opens with an assistant declaring
    // tool_calls whose tool results were cut just before tailStart, extend tailStart
    // back over them — dangling tool_calls in the sent history 400 on strict providers.
    if (history[tailStart]?.role === "assistant" && history[tailStart].tool_calls?.length) {
      const needIds = new Set(history[tailStart].tool_calls.map((tc) => tc.id))
      const haveIds = new Set()
      for (let i = tailStart + 1; i < history.length && history[i].role === "tool"; i++) {
        haveIds.add(history[i].tool_call_id)
      }
      if (needIds.size > 0 && [...needIds].some((id) => !haveIds.has(id))) {
        let back = tailStart - 1
        while (back >= headEnd && history[back]?.role === "tool") back--
        // include the missing tool results (they sit contiguously before the assistant)
        tailStart = back + 1
      }
    }
  
  if (tailStart <= headEnd) return null
  return [
    ...history.slice(0, headEnd),
    { role: "user", content: FALLBACK_NOTE },
    { role: "assistant", content: "Understood. I'll continue from these notes, re-verifying anything transient." },
    ...history.slice(tailStart),
  ]
}

/** Hard truncation limit for a single message body (CLI shrinkOversized parity). */
const OVERSIZE_CONTENT_LIMIT = 8_000

/**
 * Deterministic shrinking: last resort when there is no middle section to summarize
 * (history too short) but the threshold is exceeded. Truncates user/tool message bodies
 * exceeding OVERSIZE_CONTENT_LIMIT to a stub — keeps reasoning_content and tool_calls
 * structure intact (no protocol 400 risk). Returns a new array or null if nothing shrank.
 */
export function shrinkOversized(history, limit = OVERSIZE_CONTENT_LIMIT) {
  let shrunk = false
  const out = history.map((m) => ({ ...m }))
  for (const m of out) {
    if ((m.role !== "user" && m.role !== "tool") || typeof m.content !== "string") continue
    if (m.content.length <= limit) continue
    const keepHead = Math.min(Math.floor(limit * 0.5), 4000)
    const keepTail = Math.min(Math.floor(limit * 0.25), 2000)
    m.content =
      m.content.slice(0, keepHead) +
      `\n[... ${m.content.length - keepHead - keepTail} chars truncated — single message too large for context window ...]\n` +
      m.content.slice(-keepTail)
    shrunk = true
  }
  return shrunk ? out : null
}

// ─── End-of-run exploration distillation (AGENT-LOOP §13 + CONTEXT-COMPACTION §5, 2026-08-23) ───
// The main agent's machine line is flooded by inline step-by-step exploration (read/grep/...).
// At run end we distill THIS run's exploration tool-results into one semantic summary note that
// replaces them in the machine line (history); the human line (fullHistory, a separate array) is
// never touched. Same semantics as thincoder/src/context.mjs — the VOICE line is the CLI.

/** Read-only knowledge tools counted as "exploration" (execute writes files → never exploration). */
export const EXPLORE_TOOLS = new Set([
  "read", "grep", "glob", "ls", "code_search", "doc_search", "repo_outline",
])

/** Summary prompt for turning a burst of exploration results into a semantic summary. */
export const EXPLORE_SUMMARY_PROMPT = `You are distilling exploration tool results. Summarize the following read-only codebase exploration into a compact semantic summary for the main agent's own context.

Requirements:
- Capture WHAT was discovered, WHERE (which files / directories / symbols), and the KEY CONCLUSIONS — do not list tool calls mechanically
- Keep actionable facts the main agent needs to continue: code locations, function names, file paths, structure, and open questions the exploration raised
- Drop raw tool-output noise, repeated lines, and verbatim file dumps — keep only what must be remembered
- Be honest: mark anything not actually verified as "unverified"; do not present guesses as facts
- Use bullet points; aim for information completeness, not a hard word limit

Exploration log:
`

/** tool_calls name across both stored shapes ({function:{name}} and flat {name}). */
function toolCallName(tc) {
  return tc?.function?.name ?? tc?.name ?? ""
}

/** Tool that produced a tool-result message (falls back to its owner assistant's tool_call). */
function toolResultName(msg, ownerToolCalls) {
  if (typeof msg?.name === "string" && msg.name) return msg.name
  const owner = (ownerToolCalls ?? []).find((tc) => tc.id === msg?.tool_call_id)
  return owner ? toolCallName(owner) : ""
}

/**
 * Find the pure-exploration "assistant(tool_calls)→tool…" pair blocks added since `start`.
 * A block is explorable only when EVERY tool call AND every tool result in it is an exploration
 * tool — mixed blocks (read + edit in one turn) stay untouched, or we'd orphan the edit pairing.
 */
function findExplorationBlocks(history, start) {
  const blocks = []
  let i = start
  while (i < history.length) {
    const m = history[i]
    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      let j = i + 1
      while (j < history.length && history[j]?.role === "tool") j++
      const toolMsgs = history.slice(i + 1, j)
      const allCallsExplore = m.tool_calls.every((tc) => EXPLORE_TOOLS.has(toolCallName(tc)))
      const allResultsExplore = toolMsgs.length > 0 && toolMsgs.every((t) => EXPLORE_TOOLS.has(toolResultName(t, m.tool_calls)))
      if (allCallsExplore && allResultsExplore) {
        blocks.push({ start: i, end: j, messages: history.slice(i, j), toolCount: toolMsgs.length })
      }
      i = j
    } else {
      i++
    }
  }
  return blocks
}

/** Serialize a batch of exploration messages for the summary LLM (same shape as compaction serialization). */
function serializeExplorationMessages(messages) {
  const cap = 8000 // exploration results ARE the signal to distill — generous cap (quality-first, N1)
  return messages
    .map((m) => {
      const toolNote = m.tool_calls ? ` [called tools: ${m.tool_calls.map(toolCallName).join(", ")}]` : ""
      let text = ""
      if (typeof m.content === "string") text = m.content
      else if (Array.isArray(m.content)) text = m.content.filter((p) => p?.type === "text").map((p) => p.text ?? "").join(" ")
      return `[${m.role}]${toolNote} ${safeSliceUTF16(text, cap)}`
    })
    .join("\n")
}

/**
 * Core (shared) distillation: replace the pure-exploration pair blocks added since `runStartLen`
 * with a single "[Exploration summary]" note placed where the first block was. Returns a NEW
 * history array, or null when there is nothing to shrink (<3 exploration results / LLM failure).
 * Pairing-safe: whole assistant→tool blocks are removed, so no orphan tool_calls/tool can survive.
 */
async function distillExplorations(history, runStartLen, provider, signal) {
  const start = runStartLen ?? 0
  if (!Array.isArray(history) || history.length - start < 2) return null
  const blocks = findExplorationBlocks(history, start)
  const resultCount = blocks.reduce((n, b) => n + b.toolCount, 0)
  if (resultCount < 3) return null

  const serialized = blocks.map((b) => serializeExplorationMessages(b.messages)).join("\n")

  let summary
  try {
    // Silent by design (D11): thinking:null and no stream callbacks — this internal
    // distillation must not reach the frontend. (compactHistory parity: signal rides along.)
    const resp = await chat({ ...provider, thinking: null, reasoningEffort: null }, {
      messages: [{ role: "user", content: EXPLORE_SUMMARY_PROMPT + serialized }],
      signal: signal ?? null,
    })
    summary = resp?.content
  } catch {
    return null // N3: never block the run's return or lose history — original results stay
  }
  if (!summary) return null

  const drop = new Set()
  for (const b of blocks) for (let k = b.start; k < b.end; k++) drop.add(k)
  const note = { role: "user", content: "[Exploration summary]\n" + summary }
  const next = []
  let inserted = false
  for (let k = 0; k < history.length; k++) {
    if (drop.has(k)) {
      if (!inserted) { next.push(note); inserted = true }
      continue
    }
    next.push(history[k])
  }
  return next
}

/**
 * End-of-run exploration distillation — ASYNC since 2026-08-25 (SEND-STALL-DISTILL): runAgent
 * fires it AFTER onComplete (never awaited inside the turn); the NEXT runAgent awaits it before
 * pushing its user input, so the summary lands in the machine line before the next LLM call.
 * Shrinks the MACHINE line only — the caller keeps fullHistory untouched. Returns a NEW array,
 * or null when nothing shrank (<3 exploration results or the LLM failed). Mirrors CLI
 * summarizeRunExplorations; only the call shape differs (this end passes the machine line
 * explicitly, like compactHistory).
 */
export async function summarizeRunExplorations(history, runStartLen, provider, signal) {
  return distillExplorations(history, runStartLen, provider, signal)
}
