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
import * as vscode from "vscode"
import { BASH_TIMEOUT_MS } from "./shared.mjs"

// ─── Terminal modes (A: visible / B: inject) ─────────────────

/** Strip ANSI escape sequences from terminal stream data (colors, cursor moves, OSC). */
// eslint-disable-next-line no-control-regex -- ANSI escape stripping legitimately matches control chars
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
}

/** Mode B — inject: fill the command into the user's terminal WITHOUT running it.
 *  The user reviews and presses Enter. Output is not captured. */
function injectToTerminal(command) {
  const term = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: "ThinCoder" })
  term.show(true) // preserveFocus — don't yank the user's cursor
  term.sendText(command, false)
  return "(injected into the user's terminal — NOT executed. The user reviews and presses Enter. " +
    "No output was captured — do NOT report a result. If the command should run autonomously, omit the terminal parameter.)"
}

/** Pick a terminal with shell integration: prefer the ACTIVE terminal (carries the
 *  user's shell state), else create/reuse a "ThinCoder" terminal and wait briefly
 *  for shell integration to activate. Returns null when unavailable (caller falls
 *  back to the isolated child process). */
async function ensureIntegratedTerminal() {
  const active = vscode.window.activeTerminal
  if (active?.shellIntegration) return active
  let term = vscode.window.terminals.find((t) => t.name === "ThinCoder" && !t.exitStatus)
  if (!term) term = vscode.window.createTerminal({ name: "ThinCoder" })
  if (term.shellIntegration) return term
  const ok = await new Promise((resolve) => {
    let disp = null
    const timer = setTimeout(() => { disp?.dispose(); resolve(false) }, 5000)
    disp = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === term) { clearTimeout(timer); disp.dispose(); resolve(true) }
    })
  })
  return ok ? term : null
}

/** Mode A — visible: execute in the user's terminal via shellIntegration.executeCommand.
 *  The command runs visibly (the user watches it live) and inherits the user's shell
 *  state. Stop/timeout send Ctrl+C to the terminal (no kill API exists for shell-
 *  integration executions). Returns null when shell integration is unavailable. */
async function runInVisibleTerminal(command, timeout, ctx) {
  const term = await ensureIntegratedTerminal()
  if (!term) return null
  term.show(true)
  const execution = term.shellIntegration.executeCommand(command)
  const stream = execution.read()
  let out = ""
  return await new Promise((resolve) => {
    let settled = false
    const finish = (text) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(text)
    }
    const interrupt = () => term.sendText("\x03") // Ctrl+C the foreground process
    const timer = setTimeout(() => {
      interrupt()
      finish(`(killed — timeout ${timeout || BASH_TIMEOUT_MS}ms; interrupted in the terminal)\n[stdout]:\n${out.trim() || "(empty)"}`)
    }, timeout || BASH_TIMEOUT_MS)
    if (ctx.signal) {
      const onAbort = () => { interrupt(); finish(`(stopped)\n[stdout]:\n${out.trim() || "(empty)"}`) }
      if (ctx.signal.aborted) onAbort()
      else ctx.signal.addEventListener("abort", onAbort, { once: true })
    }
    ;(async () => {
      try {
        for await (const chunk of stream) out += stripAnsi(chunk)
        finish(`[stdout]:\n${out.trim() || "(empty)"}\n(exit code unavailable in terminal mode — watch the terminal if it matters)`)
      } catch (e) {
        finish(`Error: terminal execution failed: ${e.message}`)
      }
    })()
  })
}


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
    "- timeout: Timeout in milliseconds (default 120000)\n" +
    "- terminal: \"visible\" runs the command in the user's OWN visible terminal via shell integration — it inherits the user's shell state (current dir, activated venv/conda, env vars) that an isolated child process lacks. \"inject\" fills the command into the terminal WITHOUT running it — the user reviews and presses Enter (use for commands the user should inspect first). Omit for the default isolated child process.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command" },
      timeout: { type: "number", description: "Timeout in ms" },
      terminal: { type: "string", enum: ["visible", "inject"], description: "Run in / inject into the user's terminal" },
    },
    required: ["command"],
  },
  async execute({ command, timeout, terminal }, ctx) {
    // inject: hand the command to the user's terminal WITHOUT running it — the
    // user reviews and presses Enter. No guard snapshot (nothing executes yet;
    // the user's review IS the guard).
    if (terminal === "inject") return injectToTerminal(command)

    // Git destructive commands are NEVER rejected (the model would just find a
    // way around the rejection). Snapshot-then-proceed (CLI parity): every
    // uncommitted file is stashed before the command runs — rollback becomes
    // reversible instead of a data-loss event.
    const guard = GIT_DESTRUCTIVE_RE.test(command)
      ? gitGuardSnapshot(command, ctx.cwd)
      : null

    // visible: run in the user's own terminal via shell integration (inherits
    // the user's shell state). Falls back to the isolated child process when
    // shell integration is unavailable.
    if (terminal === "visible") {
      const out = await runInVisibleTerminal(command, timeout, ctx)
      if (out != null) return guard ? `${guard.notice}\n\n${out}` : out
      // null = shell integration unavailable → fall through to child process
    }

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
