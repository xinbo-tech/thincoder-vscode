/**
 * agent-tools.mjs — self-discipline tools
 * task, recentChanges, subagent, plan, goal, skill, verify
 */
import * as vscode from "vscode"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

export const taskTool = {
  name: "task",
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

export const recentChangesTool = {
  name: "recent_changes",
  readonly: true,
  description: "Show files modified in this agent run.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    const files = ctx.agent._touchedFiles || []
    if (files.length === 0) return "(no files modified)"
    return files.map((f, i) => `${i + 1}. ${f}`).join("\n")
  },
}

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
    const { runAgent } = await import("./agent.mjs")
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

export const planTool = {
  readonly: true,
  name: "plan",
  description:
    "Enter or exit plan mode. In plan mode, only read-only tools are allowed — useful for exploring code before committing changes.\n" +
    "Parameters:\n" +
    "- action (required): enter | exit",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["enter", "exit"] },
    },
    required: ["action"],
  },
  async execute({ action }, ctx) {
    if (action === "enter") {
      ctx.agent._planMode = true
      return "Plan mode activated — read-only tools only. Exit plan mode before making changes."
    }
    if (action === "exit") {
      ctx.agent._planMode = false
      return "Plan mode deactivated — all tools available."
    }
    return `Error: unknown action "${action}". Use "enter" or "exit".`
  },
}

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

export const skillTool = {
  name: "skill",
  readonly: true,
  description:
    "Load a project skill from .thincoder/skills/. Skills contain reusable instructions.\n" +
    "Parameters:\n" +
    "- action: list (show available) | load (activate one by name)\n" +
    "- name: Skill name (for load)",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "load"] },
      name: { type: "string", description: "Skill name (for load)" },
    },
    required: ["action"],
  },
  async execute({ action, name }, ctx) {
    const skillsDir = join(ctx.cwd, ".thincoder", "skills")
    if (!existsSync(skillsDir)) return "(no .thincoder/skills/ directory in this project)"

    if (action === "list") {
      try {
        const files = readdirSync(skillsDir, { recursive: true }).filter((f) => f.endsWith(".md"))
        if (files.length === 0) return "(no skills found)"
        return files.join("\n")
      } catch (e) {
        return `Error listing skills: ${e.message}`
      }
    }

    if (action === "load" && name) {
      const safeName = name.replace(/[^a-zA-Z0-9_\-]/g, "_")
      const filePath = join(skillsDir, `${safeName}.md`)
      if (!existsSync(filePath)) return `Skill "${name}" not found at .thincoder/skills/${safeName}.md`
      try {
        const content = readFileSync(filePath, "utf8")
        return `Skill loaded: ${name}\n\n${content.slice(0, 8000)}`
      } catch (e) {
        return `Error loading skill: ${e.message}`
      }
    }

    return "Error: use action=list or action=load with name"
  },
}

export const verifyTool = {
  name: "verify",
  description:
    "Run a pre-completion self-check. Runs syntax checks on changed files.\n" +
    "Parameters:\n" +
    "- full: Also run the full test suite (default false)",
  parameters: {
    type: "object",
    properties: {
      full: { type: "boolean", description: "Run full test suite" },
    },
  },
  async execute({ full }, ctx) {
    const files = ctx.agent._touchedFiles || []
    if (files.length === 0) return "(no files modified — nothing to verify)"

    const results = []
    for (const f of files) {
      if (/\.(m?js|cjs)$/.test(f)) {
        try {
          const { execSync } = await import("node:child_process")
          const abs = join(ctx.cwd, f)
          execSync(`node --check "${abs}"`, { encoding: "utf8", timeout: 10000, stdio: "pipe" })
          results.push(`✓ ${f}: syntax OK`)
        } catch (e) {
          results.push(`✗ ${f}: ${(e.stderr || e.message).slice(0, 200)}`)
        }
      } else {
        results.push(`- ${f}: not a JS file, skipped syntax check`)
      }
    }

    if (full) {
      try {
        const { execSync } = await import("node:child_process")
        const testResult = execSync("npm test", { cwd: ctx.cwd, encoding: "utf8", timeout: 60000, stdio: "pipe" })
        results.push(`\n=== Test suite ===\n${testResult.slice(0, 3000)}`)
      } catch (e) {
        results.push(`\n=== Test suite FAILED ===\n${(e.stdout || e.stderr || e.message).slice(0, 2000)}`)
      }
    }

    ctx.agent._verifiedThisRun = true
    ctx.agent._verifyPassed = !results.some((r) => r.startsWith("✗")) && !results.some((r) => r.includes("FAILED"))
    return results.join("\n")
  },
}
