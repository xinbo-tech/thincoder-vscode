/**
 * shell.mjs — Shell command execution tool: bash
 */

import { execSync } from "node:child_process"
import { BASH_TIMEOUT_MS } from "./shared.mjs"

export const bashTool = {
  name: "bash",
  description:
    "Execute a shell command and return stdout+stderr.\n" +
    "Parameters:\n" +
    "- command (required): Shell command to execute\n" +
    "- timeout: Timeout in milliseconds (default 120000)",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command" },
      timeout: { type: "number", description: "Timeout in ms" },
    },
    required: ["command"],
  },
  async execute({ command, timeout }, ctx) {
    try {
      const opts = { cwd: ctx.cwd, encoding: "utf8", timeout: timeout || BASH_TIMEOUT_MS, stdio: "pipe", env: process.env }
      const result = execSync(command, opts)
      return `[stdout]:\n${result}\n\n(exit code 0)`
    } catch (e) {
      const stdout = e.stdout?.toString() || ""
      const stderr = e.stderr?.toString() || ""
      return [
        stdout ? `[stdout]:\n${stdout}` : "",
        stderr ? `[stderr]:\n${stderr}` : "",
        `(exit code ${e.status ?? 1})`,
      ].filter(Boolean).join("\n")
    }
  },
}
