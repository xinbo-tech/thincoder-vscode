/**
 * escalate.mjs — 飞刀 (the "flying knife", docs/design/ESCALATE.md)
 *
 * Hand an implementation task to a STRONGER model — like a hospital flying in an
 * outside expert surgeon: the expert arrives, operates personally (WRITE access),
 * hands back the post-op report, leaves. Complementary to consult (parallel
 * READ-ONLY opinions for judgment calls).
 *
 * Candidate pool = consultModels rows with surgeon:true (the panel's 飞刀 hook).
 * The tool is only registered when the pool is non-empty (agent.mjs).
 */
import { buildProvider } from "../extension/presets.mjs"

const label = (m) => `${m.provider}:${m.model}`

export const escalateTool = {
  name: "escalate",
  sideEffectExempt: true, // the child's mutations are tracked and reviewed, like subagent
  description:
    "Hand an implementation task to a stronger model (飞刀 — a flown-in expert surgeon). " +
    "It gets WRITE access and does the work itself — reads, edits, runs tests — then returns " +
    "a post-op report (what changed, why, verification). You review the report and report to " +
    "the user. Use it when YOU judge the task calls for stronger hands (complex multi-file " +
    "refactoring, an intractable bug, intricate algorithm work — or work beyond your " +
    "comfortable ability). Early or late, your judgment; the cost is one expert run, " +
    "comparable to doing it yourself. For parallel READ-ONLY opinions use consult_start instead.\n" +
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
    // Depth guard: a surgeon must not fly in another surgeon (ESCALATE.md §1.3 US-F5)
    if ((ctx.depth ?? 0) > 0) return "Error: escalate is only available at depth 0 (the surgeon's work cannot be delegated again)"
    // All consult models are surgeon candidates (decision 2026-08-16: the 飞刀 hook checkbox
    // was removed — every configured consultant can fly in; fewer knobs, less mental load).
    const pool = parent?.config?.agent?.consultModels ?? []
    if (pool.length === 0) return "Error: no surgeon candidates — configure at least one consult model (agent.consultModels)"

    const pick = model
      ? pool.find((m) => label(m) === model)
      : pool[0]
    if (!pick) {
      return `Error: "${model}" is not a consult candidate. Available: ${pool.map(label).join(", ")}`
    }

    const build = ctx.buildProvider ?? buildProvider // test-injectable (consult.mjs parity)
    const provider = await build(pick.provider)
    if (!provider) return `Error: provider "${pick.provider}" not configured`
    const withEffort = pick.effort ? { ...provider, reasoningEffort: pick.effort } : provider
    const runner = ctx.runAgent ?? (await import("../agent.mjs")).runAgent

    parent._subIdCounter = (parent._subIdCounter ?? 0) + 1
    const subId = parent._subIdCounter
    const tag = label(pick)
    ctx.callbacks?.onSubagent?.({ id: subId, role: "surgeon", status: "started", startedAt: Date.now(), model: tag })

    let output = ""
    const sink = {}
    const panel = (chunk) => ctx.callbacks?.onToolPanel?.(`sub:surgeon ${tag}`, chunk)
    try {
      const report = await runner({ ...withEffort, model: pick.model }, ctx.cwd, task, {
        onToken: (t) => { output += t },
        onToolCall: (name, args) => panel({ kind: "tool", text: name + " " + (JSON.stringify(args) || "").slice(0, 120) }),
        onToolResult: (name, text) => panel({ kind: "tool", text: "→ " + String(text ?? "").slice(0, 80).replace(/\n/g, " ") }),
        onComplete: () => {},
        onQuestion: ctx.callbacks?.onQuestion ?? null,
      }, ctx.signal, true, {
        depth: 1, role: "coder", // full write path: permission gate, recent-changes tracking
        maxTurns: parent.config?.agent?.subagentTurns ?? 100,
        stateSink: sink,
      })
      // Surgeon mutations are the parent's mutations: verify/advisor guards must see them
      mergeMutations(parent, sink)
      ctx.callbacks?.onSubagent?.({ id: subId, role: "surgeon", status: "done", model: tag })
      return `Surgeon (${tag}) post-op report:\n${report || output.slice(0, 4000)}`
    } catch (e) {
      mergeMutations(parent, sink)
      ctx.callbacks?.onSubagent?.({ id: subId, role: "surgeon", status: "error", error: e?.message ?? String(e), model: tag })
      return `Surgeon (${tag}) error: ${e?.message ?? e}\nPartial output: ${output.slice(0, 2000)}`
    }
  },
}

/** The child's touched files become the parent's bookkeeping (subagent.mjs parity):
 *  verify/advisor guards on the parent must see delegated file changes. */
function mergeMutations(parent, sink) {
  const touched = sink?.touchedFiles ?? []
  if (touched.length === 0) return
  parent._mutatedThisRun = true
  for (const abs of touched) {
    if (!parent._touchedFiles.includes(abs)) parent._touchedFiles.push(abs)
  }
}
