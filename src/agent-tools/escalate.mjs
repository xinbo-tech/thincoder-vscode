/**
 * escalate.mjs — 飞刀 (the "flying knife", docs/design/ESCALATE.md)
 *
 * Hand an implementation task to a STRONGER model — like a hospital flying in an
 * outside expert (飞刀): the expert arrives, operates personally (WRITE access),
 * hands back the post-op report, leaves. Complementary to consult (parallel
 * READ-ONLY opinions for judgment calls).
 *
 * Candidate pool = all consultModels rows (the 飞刀 hook was removed 2026-08-16).
 * The tool is only registered when the pool is non-empty (agent.mjs).
 */
import { isAbsolute, relative } from "node:path"
import { buildProvider } from "../extension/presets.mjs"
import { mergeChildMutations } from "./subagent.mjs"

const label = (m) => `${m.provider}:${m.model}`

export const escalateTool = {
  name: "escalate",
  sideEffectExempt: true, // the child's mutations are tracked and reviewed, like subagent
  description:
    // Terminology map FIRST (2026-08-16): three words for one thing confused models into
    // two names for one thing (escalate vs surgeon, now unified to escalate) confused models
    // MODULE instead of calling it. Pin the mapping before anything else.
    "TERMINOLOGY (one word for one thing): 'escalate' is the ONLY name — the tool, and the " +
    "role of the expert sub-agent it spawns, are both called 'escalate'; 飞刀 is the Chinese " +
    "alias. When the user says 飞刀 / escalate / 'fly in <model>', call THIS tool directly — " +
    "never via a script importing this module. " +
    "Hand an implementation task to a stronger model (飞刀 — a flown-in expert). " +
    "It gets WRITE access and does the work itself — reads, edits, runs tests — then returns " +
    "a post-op report (what changed, why, verification). You review the report and report to " +
    "the user. Use it when YOU judge the task calls for stronger hands (complex multi-file " +
    "refactoring, an intractable bug, intricate algorithm work — or work beyond your " +
    "comfortable ability). Early or late, your judgment; the cost is one expert run, " +
    "comparable to doing it yourself. For parallel READ-ONLY opinions use consult_start instead. " +
    // Direct-call guard (2026-08-16): a main agent that has just been READING escalate.mjs's
    // source tends to write a node script that imports it instead of calling the tool —
    // it anchors on "module" and forgets the tool is in ITS OWN table. Say it plainly.
    "Call this tool directly when the user says '飞刀' / 'fly in <model>' — do NOT write a " +
    "script that imports the escalate module; you ARE the main agent and the tool is in your table. " +
    "Not available in engineering mode (implementation goes through eng-coder subagents there).\n" +
    "Parameters:\n" +
    "- task (required): the task description — goal, constraints, entry files, acceptance criteria\n" +
    "- model (optional): pick a specific consultant as 'provider:model'; default = the first consult model",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Task description with acceptance criteria" },
      model: { type: "string", description: "Candidate 'provider:model' from the consult models (optional)" },
    },
    required: ["task"],
  },
  async execute({ task, model }, ctx) {
    const parent = ctx.agent
    // Depth guard: an escalate must not fly in another escalate (ESCALATE.md §1.3 US-F5)
    if ((ctx.depth ?? 0) > 0) return "Error: escalate is only available at depth 0 (an escalate's work cannot be delegated again)"
    // Engineering-mode backdoor guard (three-way review 2026-08-16): an escalate IS a
    // coder sub-agent — subagent.mjs forbids role='coder' in engineering mode, and an
    // unconditional coder escalate would bypass the design-token discipline. Fail closed
    // and point at the engineering path, same as subagent does.
    if (parent?.config?.agent?.engineering) {
      return "Error: engineering mode is ON — escalate is unavailable (it spawns a coder sub-agent, which engineering mode forbids). Use subagent with role='eng-coder' and a designToken from advisor(type='design') instead."
    }
    // All consult models are escalate candidates (decision 2026-08-16: the 飞刀 hook checkbox
    // was removed — every configured consultant can fly in; fewer knobs, less mental load).
    const pool = parent?.config?.agent?.consultModels ?? []
    if (pool.length === 0) return "Error: no escalate candidates — configure at least one consult model (agent.consultModels)"

    // Model-pick tolerance: withPool lists candidates as "provider:model (effort)" —
    // a model that copies the listing verbatim must still match (strip the suffix).
    const wanted = typeof model === "string" ? model.replace(/\s+\([^)]*\)\s*$/, "").trim() : model
    const pick = wanted
      ? pool.find((m) => label(m) === wanted)
      : pool[0]
    if (!pick) {
      return `Error: "${model}" is not a consult candidate. Available: ${pool.map(label).join(", ")}`
    }

    const build = ctx.buildProvider ?? buildProvider // test-injectable (consult.mjs parity)
    const provider = await build(pick.provider)
    if (!provider) return `Error: provider "${pick.provider}" not configured`
    // Key precheck: fail BEFORE the child spawns, not at its first chat call — an
    // auth failure there would surface as an escalate crash, misdiagnosing the cause.
    if (!provider.apiKey?.trim()) {
      return `Error: provider "${pick.provider}" has no API key — set it in Settings (or THINCODER_API_KEY) before flying it in`
    }
    const withEffort = pick.effort ? { ...provider, reasoningEffort: pick.effort } : provider
    const agentMod = await import("../agent.mjs")
    const runner = ctx.runAgent ?? agentMod.runAgent

    parent._subIdCounter = (parent._subIdCounter ?? 0) + 1
    const subId = parent._subIdCounter
    const tag = label(pick)
    ctx.callbacks?.onSubagent?.({ id: subId, role: "escalate", status: "started", startedAt: Date.now(), model: tag })

    // Wall-clock ceiling (consult.mjs runConsultChild parity): turn limits count LLM
    // responses, not wall time — an escalate stuck in a slow tool/provider must not
    // hold the parent forever. Independent controller cascaded with the user's Stop.
    const timeoutMs = parent?.config?.agent?.consultTimeoutMs ?? 600_000
    let timedOut = false // watchdog kills settle as TIMEOUT, not a provider failure
    const ctrl = new AbortController()
    const watchdog = setTimeout(() => {
      timedOut = true
      try { ctrl.abort() } catch { /* already settled */ }
    }, timeoutMs)
    if (ctx.signal) {
      if (ctx.signal.aborted) ctrl.abort()
      else ctx.signal.addEventListener("abort", () => ctrl.abort(), { once: true })
    }

    let output = ""
    const sink = {}
    const panel = (chunk) => ctx.callbacks?.onToolPanel?.(`sub:escalate ${tag}`, chunk)
    try {
      const report = await runner({ ...withEffort, model: pick.model }, ctx.cwd, task, {
        // Full reasoning + output stream (consult-UI parity): a long surgery is silent
        // without it — the panel shows WHAT the expert is thinking, not just tool calls.
        onToken: (t) => { output += t; panel({ kind: "text", text: String(t ?? "") }) },
        onReasoning: (r) => panel({ kind: "think", text: String(r ?? "") }),
        onToolCall: (name, args) => panel({ kind: "tool", text: name + " " + (JSON.stringify(args) || "").slice(0, 120) }),
        onToolResult: (name, text) => panel({ kind: "tool", text: "→ " + String(text ?? "").slice(0, 80).replace(/\n/g, " ") }),
        onComplete: () => {},
        onQuestion: ctx.callbacks?.onQuestion ?? null,
      }, ctrl.signal, true, {
        depth: 1, role: "coder", // full write path: permission gate, recent-changes tracking
        streamOutput: true, // exempt from the agent.mjs onToken depth gate (consult role parity)
        maxTurns: parent.config?.agent?.subagentTurns ?? 100,
        stateSink: sink,
      })
      // Escalate mutations are the parent's mutations: verify/advisor guards must see them
      mergeChildMutations(parent, sink)
      ctx.callbacks?.onSubagent?.({ id: subId, role: "escalate", status: "done", model: tag })
      return `escalate (${tag}) post-op report:\n${report || output.slice(0, 4000)}${touchedFilesNote(sink, ctx.cwd)}`
    } catch (e) {
      // Even a failed surgery may have written files — merge whatever the child touched.
      mergeChildMutations(parent, sink)
      const msg = e?.message ?? String(e)
      ctx.callbacks?.onSubagent?.({ id: subId, role: "escalate", status: "error", error: msg, model: tag })
      // User Stop must propagate (execute-tools.mjs rethrows AbortError — swallowing
      // it keeps the parent running after the user asked to stop). The watchdog's own
      // abort is NOT a user stop: it settles below as a timeout report.
      if (ctx.signal?.aborted || (!timedOut && e?.name === "AbortError")) throw e
      // Turn-cap exhaustion is not a crash: the escalate may be nearly done — the
      // parent must review what landed instead of blind-retrying.
      if (e instanceof agentMod.ContinueError) {
        return `escalate (${tag}) stopped: turn cap reached (${e.turns} turns) — work may be partial; review recent_changes before deciding next steps.\nPartial output: ${output.slice(0, 2000)}${touchedFilesNote(sink, ctx.cwd)}`
      }
      // Timeout reads as timeout — "error: Aborted" would read as a provider crash.
      const note = timedOut
        ? `timed out after ${Math.round(timeoutMs / 60000)}min (agent.consultTimeoutMs)`
        : msg
      return `escalate (${tag}) error: ${note}\nPartial output: ${output.slice(0, 2000)}${touchedFilesNote(sink, ctx.cwd)}`
    } finally {
      clearTimeout(watchdog)
    }
  },
}

/** Relative touched-file list appended to every return (sink paths are absolute). */
function touchedFilesNote(sink, cwd) {
  const touched = sink?.touchedFiles ?? []
  if (touched.length === 0) return ""
  const shown = touched.map((f) => {
    const r = relative(cwd ?? process.cwd(), f)
    return r && !r.startsWith("..") && !isAbsolute(r) ? r : f
  })
  return `\nTouched files: ${shown.join(", ")}`
}
