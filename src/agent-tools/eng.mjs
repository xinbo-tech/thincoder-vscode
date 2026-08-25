/**
 * eng tool: enter/exit engineering mode (VS Code port, kept in sync with CLI).
 * In engineering mode the agent follows design-before-code methodology.
 * The flag persists to the shared config.json (CLI persistRaw parity).
 */
import { ENG_ON_REMINDER } from "../agent.mjs"
import { persistRaw } from "../config-io.mjs"

export const engTool = {
  name: "eng",
  description:
    "Enter or exit engineering mode. In engineering mode, follow design-before-code: write a design document, run advisor design review, get user approval, then implement via eng-coder subagents.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["enter", "exit"], description: "Enter or exit engineering mode" },
    },
    required: ["action"],
  },
  readonly: true,
  async execute(args, ctx) {
    ctx.agent.config.agent ??= {}
    if (args.action === "exit") {
      ctx.agent.config.agent.engineering = false
      ctx.agent._engDesignToken = null   // stale token from prior design review invalidated
      ctx.agent._engDesignReviewed = false // reset gate state
      ctx.agent._advisorRound = 0          // reset convergence budget
      ctx.agent._touchedFiles = []         // clear mutation tracking
      ctx.agent._mutatedThisRun = false
      ctx.agent._lastEngState = false
      ctx.agent._pendingReminders = ctx.agent._pendingReminders ?? []
      ctx.agent._pendingReminders.push(
        "[System reminder: engineering mode is now OFF — standard discipline applied. Changes go through the normal workflow.]")
      persistEngineering(false)
      return "Engineering mode exited. Standard discipline now applies. You may edit files directly."
    }
    if (args.action === "enter") {
      // Idempotent enter (v2 2026-08-25): already on → no-op (standing tokens survive a
      // redundant defensive eng(enter)); only a real off→on requires a fresh review.
      if (ctx.agent.config.agent.engineering) {
        return "Engineering mode already active. Existing design tokens stay valid."
      }
      ctx.agent.config.agent.engineering = true
      ctx.agent._engDesignToken = null   // off→on transition requires a fresh design review
      ctx.agent._lastEngState = true
      ctx.agent._pendingReminders = ctx.agent._pendingReminders ?? []
      ctx.agent._pendingReminders.push(ENG_ON_REMINDER)
      persistEngineering(true)
      return "Engineering mode activated. Design-before-code enforced: write a design document in docs/, run advisor with type='design', get user approval, then implement via eng-coder subagents."
    }
    return "Invalid action: expected 'enter' or 'exit'"
  },
}

/** Persist the engineering flag into the shared config.json (CLI persistRaw parity). */
function persistEngineering(enabled) {
  try {
    persistRaw((raw) => {
      raw.agent = raw.agent && typeof raw.agent === "object" ? raw.agent : {}
      raw.agent.engineering = enabled
    })
  } catch { /* config unreadable — in-memory state still holds for this run */ }
}
