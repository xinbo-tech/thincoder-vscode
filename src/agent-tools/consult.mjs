/**
 * consult.mjs — multi-model consultation ("会诊", docs/design/CONSULTATION.md).
 *
 * Three tools: consult_start (non-blocking spawn) / consult_check (read the next
 * reply as it arrives) / consult_stop (abort the rest). The mechanism does ZERO
 * judging — the main agent reads replies and verifies with its own tools.
 *
 * Sessions live on the agent object (agent._consultSessions) — runAgent creates a
 * fresh agent per turn, so sessions are naturally turn-bound; runAgent's finally
 * aborts leftovers.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildProvider } from "../extension/presets.mjs"

const PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "consult.md")

function loadConsultPrompt() {
  try { return readFileSync(PROMPT_PATH, "utf8").trim() } catch { return "" }
}

/** Read-only tool injected into consultation children (via runAgent opts.extraTools).
 *  Lets the consultant pull the main agent's conversation history on demand —
 *  the failure trail is first-class evidence, not a retelling. */
export function makeMainHistoryTool(parentAgent) {
  return {
    name: "main_history",
    readonly: true,
    description:
      "Read the main agent's conversation history — what has been tried, the exact errors, recent context. " +
      "Use it to ground your analysis in the actual failure trail instead of guessing.\n" +
      "Parameters:\n" +
      "- limit: Number of recent messages to return (default 20, max 100)",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "Recent messages (default 20, max 100)" } },
    },
    async execute({ limit }) {
      const n = Math.min(Math.max(limit ?? 20, 1), 100)
      const h = parentAgent?.history ?? []
      const slice = h.slice(-n)
      if (slice.length === 0) return "(empty history)"
      return slice
        .map((m) => {
          const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
          return `--- [${m.role}] ---\n${content}`
        })
        .join("\n\n")
    },
  }
}

function consultLabel(m) {
  return `${m.provider}:${m.model}`
}

/** Wake every parked consult_check waiter. */
function wakeWaiters(session) {
  const w = session.waiters.splice(0)
  for (const resolve of w) { try { resolve(false) } catch { /* noop */ } }
}

function settleChild(ctx, session, id, label, ok, payload) {
  if (ok) {
    session.received++
    session.replies.push({ model: label, reply: payload })
    ctx.callbacks?.onSubagent?.({ id: `consult-${id}-${label}`, role: "consult", model: label, status: "answered" })
  } else if (session.stopped) {
    // consult_stop already ran: an aborted child settles as TERMINATED — counted, never
    // enqueued (a "(consultation failed: Aborted)" note after an intentional stop is pure
    // noise the main agent would have to drain; consult_check done still fires via pending--).
    session.terminated = (session.terminated ?? 0) + 1
    ctx.callbacks?.onSubagent?.({ id: `consult-${id}-${label}`, role: "consult", model: label, status: "terminated", error: payload })
  } else {
    session.failed++
    session.replies.push({ model: label, reply: `(consultation failed: ${payload})`, failed: true })
    ctx.callbacks?.onSubagent?.({ id: `consult-${id}-${label}`, role: "consult", model: label, status: "failed", error: payload })
  }
  session.pending--
  wakeWaiters(session)
}

async function runConsultChild(ctx, session, id, m, problem, consultPrompt, ctrl) {
  // Wall-clock ceiling: turn limits count LLM responses, not wall time — a child stuck in
  // a slow tool/provider must not hold consult_check for hours (design review D2).
  const timeoutMs = ctx.agent?.config?.agent?.consultTimeoutMs ?? 300_000
  const watchdog = setTimeout(() => { try { ctrl.abort() } catch { /* already settled */ } }, timeoutMs)
  const label = consultLabel(m)
  try {
    const build = ctx.buildProvider ?? buildProvider // test-injectable (like ctx.runAgent)
    const provider = await build(m.provider)
    if (!provider) throw new Error(`provider "${m.provider}" not configured`)
    // Effort level from the consult entry (MODEL-PICKER-UNIFY §3.3): explicit, model-official
    // default filled by the panel at pick time. Non-thinking models carry effort:null.
    const withEffort = m.effort ? { ...provider, reasoningEffort: m.effort } : provider
    const runner = ctx.runAgent ?? (await import("../agent.mjs")).runAgent
    const task = (consultPrompt ? consultPrompt + "\n\n" : "") + "# Problem\n" + problem
    const result = await runner({ ...withEffort, model: m.model }, ctx.cwd, task, {}, ctrl.signal, true, {
      depth: 1, role: "explore",
      maxTurns: ctx.agent?.config?.agent?.subagentTurns ?? 100,
      extraTools: [makeMainHistoryTool(ctx.agent)],
    })
    settleChild(ctx, session, id, label, true, String(result ?? ""))
  } catch (e) {
    settleChild(ctx, session, id, label, false, e?.message ?? String(e))
  } finally {
    clearTimeout(watchdog)
  }
}

/** Turn-end cleanup (called from runAgent's finally): abort every leftover
 *  consultation controller, wake parked waiters, clear the session map. */
export function cleanupConsultSessions(agent) {
  for (const s of agent._consultSessions?.values() ?? []) {
    for (const c of s.controllers ?? []) { try { c.abort() } catch { /* already settled */ } }
    for (const w of s.waiters?.splice(0) ?? []) { try { w() } catch { /* noop */ } }
  }
  agent._consultSessions?.clear()
}

export const consultStartTool = {
  name: "consult_start",
  readonly: false,
  sideEffectExempt: true,
  description:
    "Start a parallel multi-model consultation for a hard problem you are stuck on (repeated failures, no headway). " +
    "Several configured models (agent.consultModels) analyze the same problem INDEPENDENTLY and in parallel. " +
    "Non-blocking: returns immediately with a consult id. Then call consult_check(id) to read each reply as it " +
    "arrives, judge/verify it yourself with your own tools, and call consult_stop(id) once a reply is good enough.\n" +
    "Parameters:\n" +
    "- problem (required): a brief — the symptom, what you already tried (failure trail), and entry-point files. " +
    "Do NOT paste raw error logs; consultants pull the main session history themselves via their main_history tool.",
  parameters: {
    type: "object",
    properties: { problem: { type: "string", description: "Problem brief (symptom + failure trail + entry files)" } },
    required: ["problem"],
  },
  async execute({ problem }, ctx) {
    if (typeof problem !== "string" || !problem.trim()) return "Error: problem is required and must be a non-empty string"
    const agent = ctx.agent
    if (!agent) return "Error: consult requires an agent context"
    const models = agent.config?.agent?.consultModels ?? []
    if (!Array.isArray(models) || models.length === 0)
      return "Consultation is not configured — add agent.consultModels ([{ provider, model }], up to 5) to ~/.thincoder/config.json"
    if (models.length > 5) return `Error: consultModels supports at most 5 models (got ${models.length})`

    agent._consultSessions ??= new Map()
    const id = String((agent._consultIdCounter = (agent._consultIdCounter ?? 0) + 1))
    const session = {
      id, controllers: [], replies: [], pending: 0, waiters: [],
      failed: 0, terminated: 0, stopped: false, received: 0, total: models.length,
      models: models.map(consultLabel),
    }
    agent._consultSessions.set(id, session)

    const consultPrompt = loadConsultPrompt()
    for (const m of models) {
      session.pending++
      const ctrl = new AbortController()
      session.controllers.push(ctrl)
      if (ctx.signal) {
        if (ctx.signal.aborted) ctrl.abort()
        else ctx.signal.addEventListener("abort", () => ctrl.abort(), { once: true })
      }
      const label = consultLabel(m)
      ctx.callbacks?.onSubagent?.({ id: `consult-${id}-${label}`, role: "consult", model: label, status: "started", startedAt: Date.now() })
      // Fire and forget — each child settles itself into the session queue.
      runConsultChild(ctx, session, id, m, problem, consultPrompt, ctrl)
    }
    return JSON.stringify({ id, models: session.models })
  },
}

export const consultCheckTool = {
  name: "consult_check",
  readonly: true,
  description:
    "Read the NEXT consultation reply (whichever model answered first). Blocks until a reply arrives or all models " +
    "have settled. The reply is raw and unjudged — verify/adopt it with your own tools. When done is true, no more " +
    "replies are coming.\n" +
    "Parameters:\n" +
    "- id (required): the consult id from consult_start",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Consult id" } },
    required: ["id"],
  },
  async execute({ id }, ctx) {
    const s = ctx.agent?._consultSessions?.get(String(id))
    if (!s) return JSON.stringify({ error: "unknown consult id" })
    const abortAll = () => { for (const c of s.controllers) { try { c.abort() } catch { /* noop */ } } }
    if (ctx.signal?.aborted) abortAll()

    for (;;) {
      if (s.replies.length > 0) {
        const r = s.replies.shift()
        return JSON.stringify({
          reply: r.reply, model: r.model, failedReply: r.failed === true,
          received: s.received,
      failed: s.failed,
      terminated: s.terminated ?? 0, total: s.total,
          done: s.replies.length === 0 && s.pending === 0,
        })
      }
      if (s.pending === 0) {
        return JSON.stringify({ done: true, received: s.received, failed: s.failed, total: s.total })
      }
      const stopped = await new Promise((resolve) => {
        function cleanup() {
          const i = s.waiters.indexOf(w)
          if (i >= 0) s.waiters.splice(i, 1)
          ctx.signal?.removeEventListener("abort", onAbort)
        }
        function w() { cleanup(); resolve(false) }
        function onAbort() { cleanup(); abortAll(); resolve(true) }
        s.waiters.push(w)
        if (ctx.signal) {
          if (ctx.signal.aborted) { onAbort(); return }
          ctx.signal.addEventListener("abort", onAbort, { once: true })
        }
      })
      if (stopped) return JSON.stringify({ done: true, stopped: true, received: s.received, failed: s.failed, total: s.total })
    }
  },
}

export const consultStopTool = {
  name: "consult_stop",
  readonly: false,
  sideEffectExempt: true,
  description:
    "Terminate the still-running consultations of a session once a reply is good enough — saves tokens and time. " +
    "Already-answered replies stay available for consult_check.\n" +
    "Parameters:\n" +
    "- id (required): the consult id from consult_start",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Consult id" } },
    required: ["id"],
  },
  async execute({ id }, ctx) {
    const s = ctx.agent?._consultSessions?.get(String(id))
    if (!s) return JSON.stringify({ error: "unknown consult id" })
    const n = s.pending
    s.stopped = true
    for (const c of s.controllers) { try { c.abort() } catch { /* already settled */ } }
    return JSON.stringify({ stopped: n })
  },
}
