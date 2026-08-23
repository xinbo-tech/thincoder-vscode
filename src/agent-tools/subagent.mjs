/**
 * subagent.mjs — subagentTool
 * Spawn a sub-agent for an independent subtask.
 * Engineering mode: role='eng-coder' requires a valid design token from advisor(type='design').
 */
import { validateDesignToken } from "./advisor.mjs"

/**
 * Mode-dependent subagent role schema field (CLI setup.mjs parity). The role enum is
 * mutually exclusive per mode: normal mode advertises "coder", engineering mode
 * advertises "eng-coder". The schema filter is the FIRST line of defense — the model
 * never sees the disabled role as legal; the runtime throws in execute() stay as the
 * hard gate. Returns { role, suffix }: `role` replaces parameters.properties.role
 * wholesale; `suffix` appends to the tool-level description ("" in normal mode).
 */
export function modeRoleField(engineering) {
  return engineering
    ? {
        role: {
          type: "string",
          enum: ["explore", "plan", "eng-coder"],
          description: "Sub-agent role: 'explore' (read-only search/analysis), 'plan' (read-only implementation planning), 'eng-coder' (engineering coder — strict methodology, design-driven). 'coder' is disabled in engineering mode.",
        },
        suffix: "In engineering mode, use role='eng-coder' for implementation (coder is disabled).",
      }
    : {
        role: {
          type: "string",
          enum: ["explore", "plan", "coder"],
          description: "Sub-agent role: 'explore' (read-only search/analysis), 'plan' (read-only implementation planning), or 'coder' (full implementation). 'eng-coder' is disabled in normal mode.",
        },
        suffix: "",
      }
}

/**
 * Effective subagent model override for a role (CLI parity):
 * priority — subagent tool `model` arg > config.agent.subagentModels[role] > config.agent.subagentModel > null (inherit parent).
 */
export function effectiveSubagentModel(parent, role, modelArg) {
  if (modelArg) return modelArg
  const cfg = parent.config?.agent ?? {}
  return cfg.subagentModels?.[role] ?? cfg.subagentModel ?? null
}

/**
 * Resolve the sub-agent's provider from a model override string (CLI parity).
 * "provider:model" → named provider + model; "provider" → named provider;
 * "model" → parent's provider with a different model; null → parent's provider.
 * Keys come from config.json only (env vars are not a key source).
 */
export function resolveChildProvider(parent, modelArg) {
  if (!modelArg) return { ...parent._provider }
  const providers = parent.config?.providersList ?? []
  const withKey = (p) => (p.apiKey?.trim() ? { ...p, apiKey: p.apiKey.trim() } : { ...p })
  if (modelArg.includes(":")) {
    const [pname, mname] = modelArg.split(":")
    const p = providers.find((x) => x.name === pname)
    if (!p) throw new Error(`subagent model: unknown provider "${pname}" (available: ${providers.map((x) => x.name).join(", ") || "none"})`)
    return { ...withKey(p), model: mname || p.model }
  }
  const byName = providers.find((x) => x.name === modelArg)
  if (byName) return withKey(byName)
  return { ...parent._provider, model: modelArg }
}

export const subagentTool = {
  name: "subagent",
  sideEffectExempt: true, // subagent mutations are tracked by the child, not the parent
  description:
    "Spawn a sub-agent for an independent subtask. role: explore (read-only search — specify thoroughness in the task: quick / medium / thorough (default medium)), plan (architecture design), coder (implementation), eng-coder (engineering-mode coder — design-driven, requires designToken).\n" +
    "Parameters:\n" +
    "- task (required): Task description\n" +
    "- role (required): explore | plan | coder | eng-coder\n" +
    "- designToken (required for eng-coder): token from advisor(type='design') after design review passed",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Task description" },
      role: { type: "string", enum: ["explore", "plan", "coder", "eng-coder"], description: "Sub-agent role" },
      model: { type: "string", description: "Provider/model override for this sub-agent: 'provider:model', a provider name from config, or a model name on the parent's provider. Defaults to the agent.subagentModel config, then the parent's provider. Useful for offloading heavy work to a cheaper model." },
      designToken: { type: "string", description: "Required when role='eng-coder': the token returned by advisor(type='design') after the design review passed. Without a valid token, eng-coder cannot modify files." },
    },
    required: ["task", "role"],
  },
  async execute({ task, role, designToken, model }, ctx) {
    const { runAgent } = await import("../agent.mjs")
    const parent = ctx.agent
    const cwd = ctx.cwd

    // Role is mutually exclusive per mode: normal mode → "coder", engineering mode → "eng-coder" (CLI parity)
    if (parent.config?.agent?.engineering && role === "coder") {
      throw new Error("Engineering mode: use role='eng-coder' for implementation tasks.")
    }
    if (!parent.config?.agent?.engineering && role === "eng-coder") {
      throw new Error("Engineering mode is not active — use role='coder' for implementation tasks.")
    }

    // Provider/model override: tool `model` arg > subagentModels[role] > subagentModel > parent provider (CLI parity)
    const provider = resolveChildProvider(parent, effectiveSubagentModel(parent, role, model))

    // eng-coder token gate: the design review must have passed and the caller must
    // present the exact token advisor issued — otherwise the child is not authorized to code.
    if (role === "eng-coder") {
      const issued = parent._engDesignToken
      if (!issued || designToken !== issued || !validateDesignToken(designToken)) {
        throw new Error("Invalid or missing design token — run advisor with type='design' first and pass the returned token as designToken.")
      }
    }

    // Turn cap from shared config (CLI parity); explore stays capped lower (read-only search)
    const maxTurns = role === "explore"
      ? Math.min(30, parent.config?.agent?.subagentTurns ?? 100)
      : parent.config?.agent?.subagentTurns ?? 100
    parent._subIdCounter = (parent._subIdCounter ?? 0) + 1
    const subId = parent._subIdCounter

    ctx.callbacks?.onSubagent?.({ id: subId, role, status: "started", startedAt: Date.now(), model: provider.model ?? null })

    // Subagent runs without MAIN-CONVERSATION callbacks — results are captured.
    // onQuestion: the child's question tool must surface in the panel like the parent's.
    // onToolCall/onToolResult/onToken/onReasoning: forwarded to the toolPanel channel as a
    // live activity stream (subagent visibility — the user watches WHAT the child
    // reads/runs/thinks/says, not just a dot). The channel name carries #subId so each
    // invocation gets its OWN block (webview _subBlocks keys by name). subId is fixed
    // before the turn-cap continue loop below — a resume reuses it, so continuation
    // chunks keep streaming into the SAME block instead of opening a new one.
    // stateSink receives the child's live mutation state (runAgent fills it every turn).
    let output = ""
    const sink = {}
    const panel = (chunk) => ctx.callbacks?.onToolPanel?.(`sub:${role}#${subId}`, chunk)
    const agentMod = await import("../agent.mjs")
    const baseOpts = {
      depth: 1, role, maxTurns,
      streamOutput: true, // exempt from the agent.mjs onToken depth gate (escalate parity)
      engState: { enabled: parent.config?.agent?.engineering ?? false, engDesignToken: parent._engDesignToken },
      engDesignReviewed: role === "eng-coder", // token verified above → child may write files
      stateSink: sink,
    }
    // Turn-cap continue loop (escalate parity): hitting the cap asks the user through
    // the panel's question card — unlimited continues, each with a fresh budget and the
    // child's own history (resume:true, opts.history=sink.history). Declined / headless
    // (no onQuestion) → partial-work return.
    for (let resume = false; ; resume = true) {
      try {
        const result = await runAgent(provider, cwd, task, {
          onToken: (t) => { output += t; panel({ kind: "text", text: t }) },
          onReasoning: (r) => panel({ kind: "think", text: r }),
          onToolCall: (name, args) => panel({ kind: "tool", text: name + " " + (JSON.stringify(args) || "").slice(0, 120) }),
          onToolResult: (name, text) => panel({ kind: "tool", text: "→ " + String(text ?? "").slice(0, 80).replace(/\n/g, " ") }),
          onComplete: () => {},
          onQuestion: ctx.callbacks?.onQuestion ?? null,
        }, ctx.signal, true, { ...baseOpts, resume, ...(resume ? { history: sink.history } : {}) })

        mergeChildMutations(parent, sink)

        ctx.callbacks?.onSubagent?.({ id: subId, role, status: "done" })
        return `Subagent (${role}) completed:\n${result || output.slice(0, 4000)}`
      } catch (e) {
        // Max-turns exhaustion may still have written files — merge whatever the child touched
        if (role === "eng-coder") mergeChildMutations(parent, sink)
        if (e instanceof agentMod.ContinueError) {
          if (ctx.callbacks?.onQuestion) {
            const go = await ctx.callbacks.onQuestion(
              `Subagent (${role}) reached ${e.turns} turns (limit). Continue from here?`,
              ["Continue", "Stop"],
            )
            if (go === "Continue") continue
          }
          ctx.callbacks?.onSubagent?.({ id: subId, role, status: "error", error: `turn cap reached (${e.turns} turns) — work may be partial` })
          return `Subagent (${role}) stopped: turn cap reached (${e.turns} turns) — work may be partial; review recent_changes before deciding next steps.\nPartial output: ${output.slice(0, 2000)}`
        }
        ctx.callbacks?.onSubagent?.({ id: subId, role, status: "error", error: e.message })
        return `Subagent (${role}) error: ${e.message}\nPartial output: ${output.slice(0, 2000)}`
      }
    }
  },
}

/**
 * Merge a child's mutations into the parent's bookkeeping
 * (CLI mergeChildMutations parity): the parent's advisor/verify guards must see
 * delegated file changes. Fresh code → fresh convergence budget: a verify/advisor
 * pass earned on the pre-delegation code is stale the moment the child writes.
 * Shared by subagent (eng-coder) and escalate — three-way review
 * 2026-08-16: escalate's local copy skipped the resets, letting surgery bypass
 * the parent's verify/advisor gates.
 */
export function mergeChildMutations(parent, sink) {
  const touched = sink?.touchedFiles ?? []
  if (touched.length === 0) return
  parent._mutatedThisRun = true
  for (const abs of touched) {
    if (!parent._touchedFiles.includes(abs)) parent._touchedFiles.push(abs)
  }
  if (parent._calledAdvisorThisRun) parent._calledAdvisorThisRun = false
  if (parent._verifiedThisRun) {
    parent._verifiedThisRun = false
    parent._verifyPassed = undefined
  }
  parent._advisorRound = 0
  parent._advisorSession = null
}
