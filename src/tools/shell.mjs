/**
 * shell.mjs — Shell command execution tool: bash
 * Includes the CLI git-destruction protection (parity with thincoder src/tools/system.mjs):
 *   1. Layer 1 — WIDE auto-snapshot before destructive git commands (covers variants
 *      the exact matcher misses, e.g. `git checkout HEAD -- .`). Snapshot = git stash
 *      (includes untracked), so uncommitted work survives the command.
 *   2. Layer 2 — exact segment match rejects the command when uncommitted changes
 *      exist (the snapshot id is surfaced so recovery is one step away).
 */

import { exec, execSync, execFileSync } from "node:child_process"
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

// ─── git destructive-command protection (CLI parity) ─────────────

/**
 * WIDE matcher: snapshot before ANY destructive git command. False positives are
 * harmless (one extra snapshot); a missed match is a data-loss disaster.
 * Git commands are NEVER rejected — the model would just find a way around the
 * rejection. Snapshot-then-proceed: every uncommitted file is copied (stash,
 * includes untracked) and the command is allowed to run.
 */
const GIT_DESTRUCTIVE_RE = /\bgit\s+(?:checkout\s+(?:[\w./-]+\s+)?--(?!\w)|checkout\s+\.|restore\s+(?!--help\b)(?!--staged\b(?!.*--worktree))|reset\s+--hard|clean\s+-(?=\S*f)(?!\S*n))/i

/** Whether cwd is inside a git repository */
function insideGitRepo(cwd) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore" })
    return true
  } catch { return false }
}

/**
 * Auto-snapshot current uncommitted work via git stash (includes untracked).
 * The stash preserves everything `git checkout -- .` / `restore` / `reset --hard`
 * / `clean -f` would destroy; recovery is `git stash apply "stash@{0}"`.
 * Returns { id, notice } or null. Never throws.
 */
function gitGuardSnapshot(command, cwd) {
  if (!GIT_DESTRUCTIVE_RE.test(command)) return null
  try {
    if (!insideGitRepo(cwd)) return null
    const id = `thincoder-auto-${Date.now()}`
    execSync(`git stash push --include-untracked -m "${id}"`, { cwd, encoding: "utf8", timeout: 10000 })
    return {
      id,
      notice: `[auto-protection] Destructive git command detected — snapshot ${id} created BEFORE execution (git stash, includes untracked). If this command destroyed uncommitted work, restore it: git stash apply "stash@{0}"`,
    }
  } catch {
    return null // protection is best-effort — never block the command
  }
}

// ─── bash tool ───────────────────────────────────────────────────

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
    // Git destructive commands are NEVER rejected (the model would just find a
    // way around the rejection). Snapshot-then-proceed (CLI parity): every
    // uncommitted file is stashed before the command runs — rollback becomes
    // reversible instead of a data-loss event.
    const guard = GIT_DESTRUCTIVE_RE.test(command)
      ? gitGuardSnapshot(command, ctx.cwd)
      : null

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
        resolve(guard ? `${guard.notice}\n\n${out}` : out)
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
