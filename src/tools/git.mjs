/**
 * git.mjs — Git and checkpoint tools: git_diff, git_status, git_log, checkpoint
 */

import { execSync } from "node:child_process"

export const gitDiffTool = {
  readonly: true,
  name: "git_diff",
  description: "Show git diff (unified format). Use to see uncommitted changes.",
  parameters: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Show staged changes" },
      path: { type: "string", description: "File or directory to diff" },
    },
  },
  async execute({ staged, path: filePath }, ctx) {
    try {
      const args = ["--no-pager", "diff"]
      if (staged) args.push("--staged")
      if (filePath) args.push(filePath)
      const result = execSync(`git ${args.join(" ")}`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
      return result || "(no changes)"
    } catch (e) {
      return `git diff error: ${e.stderr || e.message}`
    }
  },
}

export const gitStatusTool = {
  readonly: true,
  name: "git_status",
  description: "Show git status — staged, unstaged, untracked files.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    try {
      const result = execSync("git status --short", { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
      return result || "(working tree clean)"
    } catch (e) {
      return `git status error: ${e.stderr || e.message}`
    }
  },
}

export const gitLogTool = {
  readonly: true,
  name: "git_log",
  description: "Show recent git commit history.",
  parameters: {
    type: "object",
    properties: {
      count: { type: "number", description: "Number of commits (default 10)" },
      path: { type: "string", description: "File or directory" },
      oneline: { type: "boolean", description: "One-line format" },
    },
  },
  async execute({ count, path: filePath, oneline }, ctx) {
    try {
      const args = ["--no-pager", "log", oneline ? "--oneline" : "", `-${count || 10}`]
      if (filePath) args.push("--", filePath)
      const result = execSync(`git ${args.filter(Boolean).join(" ")}`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
      return result || "(no commits)"
    } catch (e) {
      return `git log error: ${e.stderr || e.message}`
    }
  },
}

export const checkpointTool = {
  name: "checkpoint",
  description:
    "List, create, and restore workspace snapshots (checkpoints). Git repositories only.\n" +
    "Parameters:\n" +
    "- action (required): \"list\" | \"create\" | \"rewind\" | \"cat\"\n" +
    "- id: snapshot id (required for rewind and cat; optional for list — when given, shows the file tree inside that snapshot)\n" +
    "- path: for rewind — restore only this single file; for cat — read this file's content from the snapshot",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "create", "rewind", "cat"], description: "list snapshots / create one now / restore a snapshot by id / read a file's content from a snapshot" },
      id: { type: "string", description: "Snapshot id (required for rewind and cat; optional for list — shows file tree of that snapshot)" },
      path: { type: "string", description: "Restore only this single file from the checkpoint (tracked or untracked). Other files are left untouched." },
    },
    required: ["action"],
  },
  async execute({ action, id, path }, ctx) {
    try {
      if (action === "list") {
        if (id) {
          const files = execSync(`git stash show --name-only "stash@{${id}}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 5000 })
          return files || "(empty snapshot)"
        }
        const result = execSync("git stash list", { cwd: ctx.cwd, encoding: "utf8", timeout: 5000 })
        return result || "(no snapshots)"
      }
      if (action === "create") {
        const msg = `thincoder-${Date.now()}`
        execSync(`git stash push --include-untracked -m "${msg}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
        return `Snapshot created: ${msg}`
      }
      if (action === "rewind") {
        if (id === undefined) return "Error: rewind requires an id parameter (snapshot index from list)"
        // Auto-snapshot current state first so rewind is reversible
        const autoMsg = `thincoder-auto-${Date.now()}`
        execSync(`git stash push --include-untracked -m "${autoMsg}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
        if (path) {
          // Restore a single file from the snapshot
          const stashRef = `stash@{${id}}`
          const files = execSync(`git stash show --name-only "${stashRef}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 5000 }).trim()
          if (!files) return `Snapshot ${id} has no tracked file changes.`
          const match = files.split("\n").find((f) => f === path || f.endsWith(`/${path}`))
          if (!match) return `File "${path}" not found in snapshot ${id}. Available: ${files}`
          execSync(`git checkout "${stashRef}" -- "${match}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
          return `Restored "${match}" from snapshot ${id}. Auto-snapshot created: ${autoMsg}`
        }
        // Full restore: apply the target stash
        execSync(`git stash apply "stash@{${id}}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
        return `Restored snapshot ${id}. Auto-snapshot created before rewind: ${autoMsg}`
      }
      if (action === "cat") {
        if (id === undefined) return "Error: cat requires an id parameter"
        if (!path) return "Error: cat requires a path parameter"
        // Read a file from the snapshot
        const stashRef = `stash@{${id}}`
        const files = execSync(`git stash show --name-only "${stashRef}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 5000 }).trim()
        if (!files) return `Snapshot ${id} has no tracked file changes.`
        const match = files.split("\n").find((f) => f === path || f.endsWith(`/${path}`))
        if (!match) return `File "${path}" not found in snapshot ${id}.`
        return execSync(`git show "${stashRef}:${match}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 })
      }
      return `Error: unknown action "${action}". Use "list", "create", "rewind", or "cat".`
    } catch (e) {
      return `checkpoint error: ${e.stderr || e.message}`
    }
  },
}
