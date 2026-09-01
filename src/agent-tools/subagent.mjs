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
          description: "The sub-agent role — see the tool description for the role capability matrix. Exact spelling required.",
        },
        suffix: "In engineering mode, use role='eng-coder' for implementation (coder is disabled).",
      }
    : {
        role: {
          type: "string",
          enum: ["explore", "plan", "coder"],
          description: "The sub-agent role — see the tool description for the role capability matrix. Exact spelling required.",
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

/**
 * Resolve the design-token slot for an eng-coder spawn (2026-09-01 multi-design, FR3,
 * CLI parity): designId given → exact slot; omitted → exactly ONE slot must exist
 * (multiple slots refuse rather than guess — T16). The HMAC/TTL check itself stays in
 * validateDesignToken (unchanged). Mirror-cleared + slots present = engineering mode
 * re-entered (eng.mjs reset) → stale slots must not resurrect tokens.
 */
export function resolveDesignSlot(parent, designIdArg) {
  const slots = parent._engDesignTokens
  const hasSlots = slots instanceof Map && slots.size > 0
  const legacy = parent._engDesignToken
  if (!legacy && hasSlots) {
    throw new Error("Design tokens were reset (engineering mode was re-entered) — run advisor with type='design' again and spawn with the fresh designId+token pair.")
  }
  if (designIdArg) {
    if (!hasSlots || !slots.has(designIdArg)) {
      throw new Error(`designId not found — no approved design review holds this id. Run advisor with type='design' again and pass the designId echoed with the token. (session holds ${hasSlots ? slots.size : 0} approved design slot(s))`)
    }
    return { token: slots.get(designIdArg) }
  }
  if (hasSlots && slots.size > 1) {
    throw new Error(`Multiple approved designs in this session (${slots.size}) — pass the designId parameter (echoed with each token) to choose which design this eng-coder spawn belongs to.`)
  }
  if (hasSlots && slots.size === 1) return { token: [...slots.values()][0] }
  if (legacy) return { token: legacy } // single-slot mirror fallback (pre-multi-slot sessions)
  throw new Error("Invalid or missing design token — run advisor with type='design' first and pass the returned token as designToken.")
}

export const subagentTool = {
  name: "subagent",
  sideEffectExempt: true, // subagent mutations are tracked by the child, not the parent
  description:
    "Spawn a sub-agent to handle an independent subtask in an isolated context. The sub-agent returns only its final report. Spawn MULTIPLE subagents in the SAME response for parallel work—they run concurrently.\n" +
    "Why delegate? A sub-agent runs in its own isolated context — its reads, searches, tool calls and edits never enter your history or pollute your window; only its final report comes back. Delegation keeps your working context lean (you see the whole session, not the child's noise) and the child single-mindedly focused on one task. Parallel children run concurrently, saving wall-clock time. Every coder/eng-coder child carries its own verify + advisor self-review discipline — handed-off work is already verified before you read a word of it.\n\n" +
    "Available roles (which roles are exposed depends on the active mode — see Mode filtering below):\n" +
    "- explore — read-only search & analysis. Toolset: the read/search family (grep, read, glob, code_search, doc_search, repo_outline, lsp, tree...). Receives git context auto-injected (branch, recent commits, working-tree state) when the project is a git repo. Its report must list what it searched and what it did NOT find. Fast — specify thoroughness in the task: quick / medium / thorough (default medium).\n" +
    "- plan — read-only implementation planning. Same read/search toolset; NEVER edits files. Returns a step-by-step plan for the parent to execute.\n" +
    "- coder — full implementation. The parent's complete read/write/execute toolset plus verify and advisor for self-review. Its final report must include a delivery transparency table with one row per task requirement (Done / Simplified / Not done — no deferred column).\n" +
    "- eng-coder — engineering-mode coder (available only in engineering mode, replacing coder). Same full toolset as coder plus the design-driven methodology overlay; REQUIRES a valid designToken arg obtained from a passed advisor(type='design') review. The advisor's Approved reply also echoes a designId — pass it as the designId arg: required to pick between designs when several approved reviews are active, optional for a single design. The delivery report echoes the designId back for the audit fix round.\n" +
    "Mode filtering: normal mode exposes explore/plan/coder; engineering mode exposes explore/plan/eng-coder. The schema enum reflects the active mode.\n\n" +
    "Writing the prompt:\n" +
    "- The sub-agent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\n" +
    "- Put exact paths and commands in the prompt when you know them. The sub-agent should not search for things you already know.\n" +
    "- Do not delegate understanding: if the task hinges on a file path or line number, find it yourself first and write it into the prompt.\n" +
    "- Once a sub-agent is running, leave that scope to it: don't redo its searches in parallel, and don't abandon it midway to finish manually.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Task description" },
      role: { type: "string", enum: ["explore", "plan", "coder", "eng-coder"], description: "The sub-agent role — see the tool description for the role capability matrix. Exact spelling required." },
      model: { type: "string", description: "Provider/model override for this sub-agent: 'provider:model', a provider name from config, or a model name on the parent's provider. Defaults to the agent.subagentModel config, then the parent's provider. Useful for offloading heavy work to a cheaper model." },
      designToken: { type: "string", description: "Required when role='eng-coder': the token returned by advisor(type='design') after the design review passed. Without a valid token, eng-coder cannot modify files." },
      designId: { type: "string", description: "Optional when role='eng-coder': the designId echoed with the approved token by advisor(type='design'). Required to pick between designs when several approved reviews are active in the session — each eng-coder carries its own designId+token pair so parallel implementations never overwrite each other. Optional for a single design." },
    },
    required: ["task", "role"],
  },
  async execute({ task, role, designToken, designId, model }, ctx) {
    const { runAgent } = await import("../agent.mjs")
    const parent = ctx.agent
    const cwd = ctx.cwd

    // Role normalization + whitelist (2026-08-25, coder-leak fix): the runtime gates below
    // used exact string comparison — a variant role ("Coder", " coder") bypassed BOTH gates
    // and fell through to full-tool/no-overlay (a full-write coder without design review).
    // Schema enums are advisory; providers don't enforce them. Fail closed on anything that
    // isn't an exact known role.
    const ROLES = new Set(["explore", "plan", "coder", "eng-coder"])
    if (!ROLES.has(role)) {
      throw new Error(`Unknown subagent role: ${JSON.stringify(role)}. Valid roles: explore, plan, coder, eng-coder (exact spelling).`)
    }
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
    // 2026-09-01: multi-design slots — the token is located by designId (exact slot,
    // single-slot fallthrough); HMAC/TTL validation itself is unchanged (CLI parity).
    let issuedToken
    if (role === "eng-coder") {
      issuedToken = resolveDesignSlot(parent, designId).token
      if (!issuedToken || designToken !== issuedToken || !validateDesignToken(designToken)) {
        throw new Error("Invalid or missing design token — run advisor with type='design' first and pass the returned token as designToken.")
      }
    }

    // Turn cap from shared config (CLI parity)
    const maxTurns = parent.config?.agent?.subagentTurns ?? 100
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
        // designId rides the delivery report (2026-09-01, CLI parity): the audit fix
        // round re-spawns with the SAME designId+token — the parent copies it from here.
        const designIdNote = role === "eng-coder"
          ? `\ndesignId: ${designId ?? "(single-design session — designId optional)"} — reuse this designId with the same designToken (from the approved advisor type='design' review) when re-spawning this eng-coder for an audit fix round.`
          : ""
        return `Subagent (${role}) completed:\n${result || output.slice(0, 4000)}${designIdNote}`
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
          // declined eng-coder delivery still carries its designId — the fix round
          // re-spawns with the same slot (2026-09-01, CLI parity).
          const capNote = role === "eng-coder" ? `\ndesignId: ${designId ?? "(single-design session — designId optional)"} — reuse it (with the same designToken) when re-spawning this eng-coder.` : ""
          return `Subagent (${role}) stopped: turn cap reached (${e.turns} turns) — work may be partial; review recent_changes before deciding next steps.\nPartial output: ${output.slice(0, 2000)}${capNote}`
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
