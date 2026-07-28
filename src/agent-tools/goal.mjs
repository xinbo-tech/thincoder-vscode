/**
 * goal.mjs — goalTool
 * Manage a long-running autonomous goal.
 */
export const goalTool = {
  name: "goal",
  description:
    "Manage a long-running autonomous goal. action=set: create a goal with a verifiable criterion. " +
    "action=complete: mark achieved. action=cancel: abandon.\n" +
    "Parameters:\n" +
    "- action (required): set | complete | cancel\n" +
    "- objective (for set): What to accomplish\n" +
    "- criteria (for set): How completion is PROVEN",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["set", "complete", "cancel"] },
      objective: { type: "string", description: "Goal description (for set)" },
      criteria: { type: "string", description: "Verification criteria (for set)" },
    },
    required: ["action"],
  },
  async execute({ action, objective, criteria }, ctx) {
    if (action === "set") {
      if (!objective) return "Error: objective is required for action=set"
      ctx.agent._goal = { objective, criteria: criteria || "manual verification", status: "active", turnsUsed: 0 }
      return `Goal set: ${objective}\nCriteria: ${criteria || "manual verification"}`
    }
    if (action === "complete") {
      if (!ctx.agent._goal) return "Error: no active goal"
      ctx.agent._goal.status = "completed"
      return `Goal completed: ${ctx.agent._goal.objective}`
    }
    if (action === "cancel") {
      if (!ctx.agent._goal) return "Error: no active goal"
      const obj = ctx.agent._goal.objective
      ctx.agent._goal = null
      return `Goal cancelled: ${obj}`
    }
    return `Error: unknown action "${action}". Use "set", "complete", or "cancel".`
  },
}
