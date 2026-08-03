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
    "Run a git command. Use this to see uncommitted changes, staged changes, diff against a ref, recent commits, or manage checkpoints. Only works inside a git repository.\n" +
    "- action='diff': Show unified diff — what changed since last commit. Set staged=true for staged-only diff, ref=<ref> to compare against a specific commit/branch, path=<dir> to scope to a file or directory.\n" +
    "- action='status': Show working tree state — staged, unstaged, untracked files, and conflicts. Returns categorized lists.\n" +
    "- action='log': Show recent commit history. Set count to limit, oneline=true for compact format, path=<file> to see history of one file.\n" +
    "- action='checkpoint': Manage git-based snapshots. Use checkpointAction to choose: list (overview), create (snapshot now), rewind (restore snapshot by id), cat (read a file from a snapshot).\n\n" +
    "Parameters:\n" +
    "- action (required): diff / status / log / checkpoint\n" +
    "- staged: (diff) Show staged changes instead of working tree\n" +
    "- path: (diff/log/checkpoint:cat/checkpoint:rewind) File or directory to scope to\n" +
    "- ref: (diff) Compare against this ref (default HEAD)\n" +
    "- count: (log) Number of commits (default 10)\n" +
    "- oneline: (log) One-line-per-commit format\n" +
    "- checkpointAction: (checkpoint) list snapshots / create one / restore by id / read file from snapshot\n" +
    "- checkpointId: (checkpoint) Snapshot id — required for rewind and cat; optional for list (shows file tree)",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["diff", "status", "log", "checkpoint"], description: "diff / status / log / checkpoint" },
      staged: { type: "boolean", description: "(diff) Show staged changes instead of working tree" },
      path: { type: "string", description: "(diff/log/checkpoint:cat/checkpoint:rewind) File or directory to scope to" },
      ref: { type: "string", description: "(diff) Compare against this ref (default HEAD)" },
      count: { type: "number", description: "(log) Number of commits (default 10)" },
      oneline: { type: "boolean", description: "(log) One-line-per-commit format" },
      checkpointAction: { type: "string", enum: ["list", "create", "rewind", "cat"], description: "(checkpoint) list snapshots / create one / restore by id / read file from snapshot" },
      checkpointId: { type: "string", description: "(checkpoint) Snapshot id — required for rewind and cat; optional for list (shows file tree)" },
    },
    required: ["action"],
  },
  async execute(args, ctx) {
    switch (args.action) {
      case "diff": {
        const ref = args.ref ?? "HEAD"
        if (!/^[A-Za-z0-9._/~^@][A-Za-z0-9._/~^@{}-]*$/.test(ref)) throw new Error(`Invalid git ref: ${ref}`)
        const flags = args.staged ? ["--staged"] : []
        const paths = args.path ? [args.path] : []
        const out = runGit(ctx.cwd, ["diff", ...flags, ref, "--", ...paths])
        return truncate(out || "(no changes)")
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
        return truncate(parts.join("\n\n"))
      }
      case "log": {
        const n = Math.min(Math.max(1, args.count ?? 10), 200)
        const isOneline = args.oneline
        const cmdArgs = isOneline
          ? ["log", "-" + n, "--oneline"]
          : ["log", "-" + n, "--format=%h %ad %an %s", "--date=short"]
        if (args.path) cmdArgs.push("--", args.path)
        const out = runGit(ctx.cwd, cmdArgs)
        return truncate(out || "(no commits)")
      }
      case "checkpoint": {
        return await checkpointExecute(args, ctx)
      }
      default:
        return `Unknown action '${args.action}'. Use: diff | status | log | checkpoint`
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
    // Auto-snapshot current state first so rewind is reversible
    const autoMsg = `thincoder-auto-${Date.now()}`
    exec(`git stash push --include-untracked -m "${autoMsg}"`)
    if (path) {
      const stashRef = `stash@{${id}}`
      const files = exec(`git stash show --name-only "${stashRef}"`).trim()
      if (!files) return `Checkpoint ${id} has no tracked file changes.`
      const match = files.split("\n").find((f) => f === path || f.endsWith(`/${path}`))
      if (!match) return `File "${path}" not found in checkpoint ${id}. Available: ${files}`
      exec(`git checkout "${stashRef}" -- "${match}"`)
      return `Restored "${match}" from checkpoint ${id}. Auto-snapshot created: ${autoMsg}`
    }
    exec(`git stash apply "stash@{${id}}"`)
    return `Restored checkpoint ${id}. Auto-snapshot created before rewind: ${autoMsg}`
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
