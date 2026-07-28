/**
 * shell.mjs — Shell command execution tool: bash
 */

import { exec } from "node:child_process"
import { BASH_TIMEOUT_MS } from "./shared.mjs"

// Pass all env vars EXCEPT known secret patterns.
// Blacklist approach — whitelisting is too fragile and breaks npm, git SSH, etc.
const SECRET_PATTERNS = /_(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIALS?)(?:_|$)|^(?:NPM_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN|AWS_|AZURE_|GCLOUD_)/i
const SAFE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !SECRET_PATTERNS.test(k))
)
// Always override interactive/pager tools
SAFE_ENV.GIT_PAGER = "cat"
SAFE_ENV.PAGER = "cat"
SAFE_ENV.EDITOR = "true"
SAFE_ENV.TERM = "dumb"

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
    return new Promise((resolve) => {
      const child = exec(command, {
        cwd: ctx.cwd,
        timeout: timeout || BASH_TIMEOUT_MS,
        env: SAFE_ENV,
        maxBuffer: 2 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error && error.killed) {
          resolve(`(killed — timeout ${timeout || BASH_TIMEOUT_MS}ms)`)
          return
        }
        const out = [
          stdout ? `[stdout]:\n${stdout}` : "",
          stderr ? `[stderr]:\n${stderr}` : "",
          `(exit code ${error ? error.code ?? 1 : 0})`,
        ].filter(Boolean).join("\n")
        ctx.callbacks?.onToolPanel?.("bash", out)
        resolve(out)
      })
      // Wire abort signal
      if (ctx.signal) {
        ctx.signal.addEventListener("abort", () => { child.kill() }, { once: true })
        if (ctx.signal.aborted) child.kill()
      }
    })
  },
  outputPanel: true,
}
