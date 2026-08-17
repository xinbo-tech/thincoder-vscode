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
import { specForModel } from "../specs.mjs"

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
      return `Error: provider "${pick.provider}" has no API key — set it in Settings before flying it in`
    }
    let effortNote = ""
    const withEffort = pick.effort
      ? (() => {
          // Clamp the pool's effort to the model's reasoningEffortEnum — an out-of-enum
          // value makes provider/core throw on EVERY chat call (candidate dies on takeoff).
          // Out-of-enum: DROP the effort entirely (the preset default may ALSO be out-of-enum
          // for this override model).
          const enumList = specForModel(pick.model).reasoningEffortEnum
          if (enumList && !enumList.includes(pick.effort)) {
            effortNote = ` (effort "${pick.effort}" unsupported by ${pick.model}, dropped)`
            const { reasoningEffort: _drop, ...rest } = provider
            return rest
          }
          return { ...provider, reasoningEffort: pick.effort }
        })()
      : provider
    const agentMod = await import("../agent.mjs")
    const runner = ctx.runAgent ?? agentMod.runAgent

    parent._subIdCounter = (parent._subIdCounter ?? 0) + 1
    const subId = parent._subIdCounter
    const tag = label(pick)
    ctx.callbacks?.onSubagent?.({ id: subId, role: "escalate", status: "started", startedAt: Date.now(), model: tag })

    let output = ""
    const sink = {}
    const panel = (chunk) => ctx.callbacks?.onToolPanel?.(`sub:escalate ${tag}`, chunk)

    // No wall-clock watchdog — turn cap only (CLI parity, 2026-08-16): a fixed wall-clock
    // aborts NORMAL-but-slow surgery (two max-effort consultants hit a 10min wall just
    // READING files). Hang protection = FETCH_TIMEOUT (per LLM call) + user Stop (signal
    // propagates directly). Turn-cap continue reuses the panel's onQuestion channel —
    // the SAME y/n card the main agent's question tool uses; continues are UNLIMITED
    // (each gives a fresh budget; Stop is always an option at the prompt).
    const runOpts = (resume) => ({
      depth: 1, role: "coder", // full write path: permission gate, recent-changes tracking
      streamOutput: true, // exempt from the agent.mjs onToken depth gate (consult role parity)
      maxTurns: parent.config?.agent?.subagentTurns ?? 100,
      stateSink: sink,
      resume,
      // Resume hands the child its own conversation back — subagent history is otherwise
      // throwaway per runAgent call (agent.mjs). sink.history is the LIVE array reference.
      ...(resume ? { history: sink.history } : {}),
    })
    for (let resumes = 0; ; resumes++) {
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
        }, ctx.signal ?? null, true, runOpts(resumes > 0))
        // Escalate mutations are the parent's mutations: verify/advisor guards must see them
        mergeChildMutations(parent, sink)
        ctx.callbacks?.onSubagent?.({ id: subId, role: "escalate", status: "done", model: tag })
        return `escalate (${tag})${effortNote} post-op report:\n${report || output.slice(0, 4000)}${touchedFilesNote(sink, ctx.cwd)}`
      } catch (e) {
        // Even a failed surgery may have written files — merge whatever the child touched.
        mergeChildMutations(parent, sink)
        const msg = e?.message ?? String(e)
        // User Stop must propagate (execute-tools.mjs rethrows AbortError — swallowing
        // it keeps the parent running after the user asked to stop).
        if (ctx.signal?.aborted || e?.name === "AbortError") {
          ctx.callbacks?.onSubagent?.({ id: subId, role: "escalate", status: "error", error: msg, model: tag })
          throw e
        }
        // Turn-cap exhaustion is not a crash: offer to continue from the current context
        // (main-agent panel-chat parity — "reached N turns. Continue?"), resuming with
        // resume:true + the child's own history. No onQuestion (headless) or declined →
        // partial-work return. Unlimited continues — the user can Stop at any prompt.
        if (e instanceof agentMod.ContinueError) {
          if (ctx.callbacks?.onQuestion) {
            const go = await ctx.callbacks.onQuestion(
              `飞刀 ${tag} reached ${e.turns} turns (limit). Continue from here?`,
              ["Continue", "Stop"],
            )
            if (go === "Continue") continue
          }
          return `escalate (${tag}) stopped: turn cap reached (${e.turns} turns) — work may be partial; review recent_changes before deciding next steps.\nPartial output: ${output.slice(0, 2000)}${touchedFilesNote(sink, ctx.cwd)}`
        }
        ctx.callbacks?.onSubagent?.({ id: subId, role: "escalate", status: "error", error: msg, model: tag })
        return `escalate (${tag}) error: ${msg}\nPartial output: ${output.slice(0, 2000)}${touchedFilesNote(sink, ctx.cwd)}`
      }
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
