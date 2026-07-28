/**
 * subagent.mjs — subagentTool
 * Spawn a sub-agent for an independent subtask.
 */
export const subagentTool = {
  name: "subagent",
  description:
    "Spawn a sub-agent for an independent subtask. role: explore (read-only search), plan (architecture design), coder (implementation).\n" +
    "Parameters:\n" +
    "- task (required): Task description\n" +
    "- role (required): explore | plan | coder",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Task description" },
      role: { type: "string", enum: ["explore", "plan", "coder"], description: "Sub-agent role" },
    },
    required: ["task", "role"],
  },
  async execute({ task, role }, ctx) {
    const { runAgent } = await import("../agent.mjs")
    const provider = ctx.agent._provider
    const cwd = ctx.cwd
    const maxTurns = role === "explore" ? 30 : 50

    // Subagent runs without UI callbacks — results are captured
    let output = ""
    try {
      const result = await runAgent(provider, cwd, task, {
        onToken: (t) => { output += t },
        onToolCall: () => {},
        onToolResult: () => {},
        onComplete: () => {},
      }, ctx.signal, true, { depth: 1, role, maxTurns })

      return `Subagent (${role}) completed:\n${result || output.slice(0, 4000)}`
    } catch (e) {
      return `Subagent (${role}) error: ${e.message}\nPartial output: ${output.slice(0, 2000)}`
    }
  },
}
