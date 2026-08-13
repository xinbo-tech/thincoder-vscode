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

/** Kill the whole process tree of a spawned child (CLI parity): Windows uses
 *  taskkill /T /F (tree + force), POSIX kills the process group. Plain
 *  child.kill() only reaps the direct child — grandchildren (npm test's
 *  subprocesses, etc.) would leak. */
function killProcessTree(child) {
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }) } catch { /* already gone */ }
  } else {
    try { process.kill(-child.pid, "SIGKILL") } catch { /* */ }
    try { child.kill("SIGKILL") } catch { /* fallback if group kill fails */ }
  }
}
SAFE_ENV.EDITOR = "true"
SAFE_ENV.TERM = "dumb"
// Windows: force UTF-8 for Python child output (CLI parity — cmd GBK would garble)
if (process.platform === "win32") SAFE_ENV.PYTHONIOENCODING = "utf-8"

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
    // Bound the stash list (20 max) — guard snapshots must not accumulate on disk
    try {
      const list = execSync("git stash list", { cwd, encoding: "utf8", timeout: 5000 })
      const count = list.trim() ? list.trim().split("\n").length : 0
      for (let i = count; i > 20; i--) {
        execSync(`git stash drop "stash@{${i - 1}}"`, { cwd, encoding: "utf8", stdio: "ignore", timeout: 5000 })
      }
    } catch { /* pruning is best-effort */ }
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
      let settled = false
      const finish = (out) => {
        if (settled) return
        settled = true
        // Output shows in the in-conversation tool card (finishTool auto-expands
        // it) — NOT the side tool panel (that duplication read as an intrusive
        // overlay; reported as jarring).
        resolve(guard ? `${guard.notice}\n\n${out}` : out)
      }
      // Shell override from config (CLI parity). Windows + default cmd: force UTF-8
      // code page for this child — cmd emits GBK bytes otherwise, which the UTF-8
      // capture turns into mojibake (reported win11 encoding pain).
      const shell = ctx.agent?.config?.shell ?? null
      const effectiveCommand = process.platform === "win32" && !shell
        ? `chcp 65001 >nul && ${command}`
        : command
      const child = exec(effectiveCommand, {
        cwd: ctx.cwd,
        timeout: timeout || BASH_TIMEOUT_MS,
        env: SAFE_ENV,
        maxBuffer: 2 * 1024 * 1024,
        ...(shell ? { shell } : {}),
      }, (error, stdout, stderr) => {
        if (error && error.name === "AbortError") {
          finish(`(stopped)`)
          return
        }
        if (error && error.killed) {
          finish(`(killed — timeout ${timeout || BASH_TIMEOUT_MS}ms)`)
          return
        }
        const out = [
          stdout ? `[stdout]:\n${stdout}` : "",
          stderr ? `[stderr]:\n${stderr}` : "",
          `(exit code ${error ? error.code ?? 1 : 0})`,
        ].filter(Boolean).join("\n")
        finish(out)
      })
      // Stop: resolve IMMEDIATELY on abort (don't wait for stdio pipes to close —
      // exec's callback hangs when a grandchild survives the kill). Kill the WHOLE
      // process tree (CLI killProcessTree parity: Windows taskkill /T /F, POSIX
      // group-kill) so grandchildren (npm test's subprocesses, etc.) don't leak.
      if (ctx.signal) {
        const onAbort = () => { killProcessTree(child); finish("(stopped)") }
        if (ctx.signal.aborted) onAbort()
        else ctx.signal.addEventListener("abort", onAbort, { once: true })
      }
      // exec's callback waits for the stdio pipes to close. A BACKGROUND child
      // (start /b, &, …) inherits them, so the callback never fires and the tool
      // hangs until the timeout — resolve after a grace period instead (CLI parity).
      child.once("exit", () => {
        setTimeout(() => {
          finish(
            "(background) the shell exited but a child process still holds the output pipe — output may be incomplete; the process may still be running\n" +
            "[stdout]:\n(empty)"
          )
        }, 1000)
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
