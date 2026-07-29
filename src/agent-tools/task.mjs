/**
 * task.mjs — taskTool
 * Plan and track a task list for complex multi-step work.
 */
export const taskTool = {
  name: "task",
  readonly: true,
  description:
    "Plan and track a task list for complex multi-step work. Each call replaces the entire list. " +
    "Keep exactly one item in_progress at a time. Statuses: pending | in_progress | done.\n" +
    "Parameters:\n" +
    "- items (required): Array of { title: string, status: pending|in_progress|done }",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "done"] },
          },
          required: ["title", "status"],
        },
      },
    },
    required: ["items"],
  },
  async execute({ items }, ctx) {
    ctx.agent._tasks = items
    ctx.callbacks?.onTaskUpdate?.(items)
    const done = items.filter((t) => t.status === "done").length
    const total = items.length
    const inProgress = items.find((t) => t.status === "in_progress")
    return [
      `Task list: ${done}/${total} done`,
      inProgress ? `In progress: ${inProgress.title}` : "",
      items.filter((t) => t.status === "pending").length > 0
        ? `Pending: ${items.filter((t) => t.status === "pending").map((t) => t.title).join(", ")}`
        : "",
    ].filter(Boolean).join("\n")
  },
}
