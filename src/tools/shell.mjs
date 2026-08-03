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
 */
const GIT_DESTRUCTIVE_RE = /\bgit\s+(?:checkout\s+(?:[\w./-]+\s+)?--(?!\w)|checkout\s+\.|restore\s+(?!--help\b)|reset\s+--hard|clean\s+-\w*[fd])/i

/** Split a command into segments by shell separators (CLI parity). */
function shellSegments(command) {
  return command.split(/&&|\|\||>>|\$\(|[;|\n<>]|`|[(]/)
}

/** Exact matcher: is this segment a destructive git command? (CLI parity) */
function isDestructiveGitSegment(seg) {
  if (!/^\s*git\s/.test(seg)) return false
  if (/\scheckout\s+(?:--|\.(?:\s|$))/.test(seg)) return true
  if (/\sreset\s+--hard\b/.test(seg)) return true
  if (/\sclean\s+-\S*f/.test(seg)) return true
  if (/\srestore\s/.test(seg) && (/--worktree/.test(seg) || !/--staged/.test(seg))) return true
  return false
}

/** Whether cwd is inside a git repository */
function insideGitRepo(cwd) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore" })
    return true
  } catch { return false }
}

/** git status --porcelain ("" when clean or not a repo) */
function gitStatusPorcelain(cwd) {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch { return "" }
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
    // ── git protection (CLI parity: reject exact destructive matches when
    //    uncommitted changes exist). The REJECT path does not snapshot — the
    //    command never runs, so the working tree is untouched and nothing can be
    //    lost. The ALLOWED variant path snapshots first (stash preserves what the
    //    command is about to destroy).
    const hasDestructiveSeg = shellSegments(command).some(isDestructiveGitSegment)
    let guard = null
    if (hasDestructiveSeg) {
      if (!insideGitRepo(ctx.cwd)) {
        throw new Error(`Refusing destructive git command: not a git repository: ${ctx.cwd}`)
      }
      const status = gitStatusPorcelain(ctx.cwd)
      if (status) {
        throw new Error(
          `Refusing destructive git command: uncommitted changes exist.\n` +
          `First create a checkpoint (action=checkpoint) to protect current work, then commit or stash before the destructive operation.\n` +
          `(If uncommitted work was already lost, recover from the latest auto-snapshot: checkpoint action=list, then action=rewind.)\n\n${status}`
        )
      }
      // No uncommitted changes → nothing to lose → allow (CLI parity)
    } else if (GIT_DESTRUCTIVE_RE.test(command)) {
      // Variant the exact matcher misses (e.g. `git checkout HEAD -- .`):
      // snapshot protects the work, command is allowed to run.
      guard = gitGuardSnapshot(command, ctx.cwd)
    }

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
