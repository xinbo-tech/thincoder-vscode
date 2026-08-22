/**
 * git.mjs — Git tool (CLI parity: single `git` tool with action subcommands).
 * diff / status / log follow the CLI implementation byte-for-byte;
 * checkpoint uses the stash-based snapshot mechanism here — the CLI uses v2 full-copy
 * snapshots (thincoder src/git/checkpoint.mjs). Mechanisms are behaviorally equivalent
 * for the model (list/create/rewind/cat); aligning VS Code to the CLI v2 implementation
 * is a tracked follow-up.
 */
import { runGit, truncate } from "./shared.mjs"
import { execSync } from "node:child_process"

export const gitTool = {
  name: "git",
  readonly: false,
  description:
    "Run a git command. Use this to see uncommitted changes, staged changes, diff against a ref, recent commits, show a commit, or manage checkpoints. Only works inside a git repository.\n" +
    "- action='diff': Show unified diff — what changed since last commit. Set staged=true for staged-only diff, ref=<ref> to compare against a specific commit/branch, path=<dir> to scope to a file or directory.\n" +
    "- action='status': Show working tree state — staged, unstaged, untracked files, and conflicts. Returns categorized lists.\n" +
    "- action='log': Show recent commit history. Set count to limit, oneline=true for compact format, path=<file> to see history of one file.\n" +
    "- action='show': Show a commit's details. Set ref=<ref> to inspect a specific commit (default HEAD).\n" +
    "- action='checkpoint': Manage git-based snapshots. Use checkpointAction to choose: list (overview), create (snapshot now), rewind (restore snapshot by id), cat (read a file from a snapshot).\n" +
    "- action='rm': Remove a file from git tracking (keeps the file on disk). path is required.\n" +
    "- action='commit': Commit all staged changes. message is required.\n" +
    "- action='push': Push the current branch to the remote.\n" +
    "filter (optional): only return output lines matching this regular expression (case-insensitive) — for read-only actions (diff/status/log/show).\n\n" +
    "Parameters:\n" +
    "- action (required): diff / status / log / show / checkpoint / rm / commit / push\n" +
    "- staged: (diff) Show staged changes instead of working tree\n" +
    "- path: (diff/log/checkpoint:cat/checkpoint:rewind/rm) File or directory to scope to\n" +
    "- ref: (diff/show) Commit ref (default HEAD)\n" +
    "- count: (log) Number of commits (default 10)\n" +
    "- oneline: (log) One-line-per-commit format\n" +
    "- message: (commit) Commit message — required for commit\n" +
    "- filter: (read-only actions) Regex to filter output lines by\n" +
    "- checkpointAction: (checkpoint) list snapshots / create one / restore by id / read file from snapshot\n" +
    "- checkpointId: (checkpoint) Snapshot id — required for rewind and cat; optional for list (shows file tree)",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["diff", "status", "log", "show", "checkpoint", "rm", "commit", "push"], description: "diff / status / log / show / checkpoint / rm / commit / push" },
      staged: { type: "boolean", description: "(diff) Show staged changes instead of working tree" },
      path: { type: "string", description: "(diff/log/checkpoint:cat/checkpoint:rewind/rm) File or directory to scope to" },
      ref: { type: "string", description: "(diff/show) Commit ref (default HEAD)" },
      count: { type: "number", description: "(log) Number of commits (default 10)" },
      oneline: { type: "boolean", description: "(log) One-line-per-commit format" },
      message: { type: "string", description: "(commit) Commit message — required for commit" },
      filter: { type: "string", description: "(read-only actions) Regex to filter output lines by (case-insensitive)" },
      checkpointAction: { type: "string", enum: ["list", "create", "rewind", "cat"], description: "(checkpoint) list snapshots / create one / restore by id / read file from snapshot" },
      checkpointId: { type: "string", description: "(checkpoint) Snapshot id — required for rewind and cat; optional for list (shows file tree)" },
    },
    required: ["action"],
  },
  async execute(args, ctx) {
    const out = await this._execute(args, ctx)
    return out
  },

  /**
   * 判断某次 git 调用是否只读（供 execute-tools 审批过滤用）。
   * 只读 action 不弹审批：diff/status/log/show + checkpoint 的 list/cat。
   */
  isReadonlyAction(args) {
    if (!args || typeof args.action !== "string") return false
    if (["diff", "status", "log", "show"].includes(args.action)) return true
    if (args.action === "checkpoint") return ["list", "cat"].includes(args.checkpointAction)
    return false // rm/commit/push + checkpoint create/rewind 是写操作
  },

  /** 内部实现：执行各 action。 */
  async _execute(args, ctx) {
    // filter 只在只读 action 上生效
    const applyFilter = (text) => {
      if (!args.filter) return text
      try {
        const re = new RegExp(args.filter, "i")
        const lines = text.split("\n").filter((l) => re.test(l))
        return lines.length ? lines.join("\n") : "(no matching lines)"
      } catch (e) {
        return `filter error: ${e.message}`
      }
    }

    switch (args.action) {
      case "diff": {
        const ref = args.ref ?? "HEAD"
        if (!/^[A-Za-z0-9._/~^@][A-Za-z0-9._/~^@{}-]*$/.test(ref)) throw new Error(`Invalid git ref: ${ref}`)
        const flags = args.staged ? ["--staged"] : []
        const paths = args.path ? [args.path] : []
        const out = runGit(ctx.cwd, ["diff", ...flags, ref, "--", ...paths])
        return truncate(applyFilter(out || "(no changes)"))
      }
      case "status": {
        const porcelain = runGit(ctx.cwd, ["status", "--porcelain"])
        if (!porcelain) return "(clean — no changes)"

        const staged = []
        const unstaged = []
        const untracked = []
        const conflicts = []
        for (const line of porcelain.split("\n")) {
          if (!line) continue
          const clean = line.replace(/\r/g, "")
          const m = clean.match(/^(..?)\s+(.+)$/)
          if (!m) continue
          const [, status, rawFile] = m
          const file = status.includes("R") && rawFile.includes(" -> ") ? rawFile.replace(" -> ", " → ") : rawFile
          const idx = status[0] ?? " "
          const wt = status[1] ?? " "
          if (idx === "U" || wt === "U" || (idx === "A" && wt === "A")) {
            conflicts.push(file)
          } else if (idx === "?" && wt === "?") {
            untracked.push(file)
          } else {
            if (idx !== " " && idx !== "?") staged.push(idx + " " + file)
            if (wt !== " " && wt !== "?") unstaged.push(wt + " " + file)
          }
        }
        const parts = []
        if (staged.length) parts.push("Staged (" + staged.length + "):\n" + staged.join("\n"))
        if (unstaged.length) parts.push("Unstaged (" + unstaged.length + "):\n" + unstaged.join("\n"))
        if (untracked.length) parts.push("Untracked (" + untracked.length + "):\n" + untracked.join("\n"))
        if (conflicts.length) parts.push("Conflicts (" + conflicts.length + "):\n" + conflicts.join("\n"))
        return truncate(applyFilter(parts.join("\n\n")))
      }
      case "log": {
        const parsed = Number.parseInt(args.count, 10)
        const n = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 10
        const isOneline = args.oneline
        const cmdArgs = isOneline
          ? ["log", "-" + n, "--oneline"]
          : ["log", "-" + n, "--format=%h %ad %an %s", "--date=short"]
        if (args.path) cmdArgs.push("--", args.path)
        const out = runGit(ctx.cwd, cmdArgs)
        return truncate(applyFilter(out || "(no commits)"))
      }
      case "show": {
        const ref = args.ref ?? "HEAD"
        if (!/^[A-Za-z0-9._/~^@][A-Za-z0-9._/~^@{}-]*$/.test(ref)) throw new Error(`Invalid git ref: ${ref}`)
        const out = runGit(ctx.cwd, ["show", "--stat", ref])
        return truncate(applyFilter(out || "(no such commit)"))
      }
      case "rm": {
        if (!args.path) return "Error: rm requires path (file to remove from tracking)"
        runGit(ctx.cwd, ["rm", "--cached", "-r", "--", args.path])
        return `Removed from tracking: ${args.path} (file kept on disk)`
      }
      case "commit": {
        if (!args.message) return "Error: commit requires message"
        runGit(ctx.cwd, ["add", "-A"])
        const out = runGit(ctx.cwd, ["commit", "-m", args.message])
        return out || "(commit done)"
      }
      case "push": {
        const out = runGit(ctx.cwd, ["push"])
        return out || "(push done)"
      }
      case "checkpoint": {
        return await checkpointExecute(args, ctx)
      }
      default:
        return `Unknown action '${args.action}'. Use: diff | status | log | show | checkpoint | rm | commit | push`
    }
  },
}

/** Stash-based checkpoint sub-actions (parameter names aligned to CLI: checkpointAction/checkpointId). */
async function checkpointExecute({ checkpointAction: sub, checkpointId: id, path }, ctx) {
  const exec = (cmd) => {
    try {
      return execSync(cmd, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
    } catch (e) {
      throw new Error((e.stderr || e.message || "").trim(), { cause: e })
    }
  }
  if (!sub) return "checkpoint: missing checkpointAction — use: list | create | rewind | cat"

  if (sub === "create") {
    const msg = `thincoder-${Date.now()}`
    exec(`git stash push --include-untracked -m "${msg}"`)
    return `Checkpoint ${msg} created`
  }
  if (sub === "rewind") {
    if (id === undefined) throw new Error("checkpointId is required for rewind — use checkpointAction=list to see snapshot ids")
    // Full restore is disabled (CLI parity): as dangerous as `git checkout -- .`.
    if (!path) throw new Error("path is required for rewind — full restore is disabled (as dangerous as `git checkout -- .`). Restore files individually.")
    // Auto-snapshot current state first so rewind is reversible
    const autoMsg = `thincoder-auto-${Date.now()}`
    exec(`git stash push --include-untracked -m "${autoMsg}"`)
    const stashRef = `stash@{${id}}`
    const files = exec(`git stash show --name-only "${stashRef}"`).trim()
    if (!files) return `Checkpoint ${id} has no tracked file changes.`
    const match = files.split("\n").find((f) => f === path || f.endsWith(`/${path}`))
    if (!match) return `File "${path}" not found in checkpoint ${id}. Available: ${files}`
    exec(`git checkout "${stashRef}" -- "${match}"`)
    return `Restored "${match}" from checkpoint ${id}. Auto-snapshot created: ${autoMsg}`
  }
  if (sub === "cat") {
    if (id === undefined) throw new Error("checkpointId is required for cat — use checkpointAction=list to see snapshot ids")
    if (!path) throw new Error("path is required for cat — specify which file to read")
    const stashRef = `stash@{${id}}`
    const files = exec(`git stash show --name-only "${stashRef}"`).trim()
    if (!files) return `Checkpoint ${id} has no tracked file changes.`
    const match = files.split("\n").find((f) => f === path || f.endsWith(`/${path}`))
    if (!match) return `File "${path}" not found in checkpoint ${id}.`
    return exec(`git show "${stashRef}:${match}"`)
  }
  if (sub === "list") {
    const out = exec("git stash list").trim()
    if (!out) return "(no checkpoints yet — one is auto-created before each user task)"
    if (id !== undefined) {
      const files = exec(`git stash show --name-only "stash@{${id}}"`).trim()
      return files || "(empty checkpoint)"
    }
    return out
  }
  throw new Error(`Unknown checkpoint action: ${sub}. Use: list | create | rewind | cat`)
}
