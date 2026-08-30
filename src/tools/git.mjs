/**
 * git.mjs — Git tool (CLI parity: single `git` tool with action subcommands).
 * diff / status / log follow the CLI implementation byte-for-byte;
 * checkpoint uses the stash-based snapshot mechanism here — the CLI uses v2 full-copy
 * snapshots (thincoder src/git/checkpoint.mjs). Mechanisms are behaviorally equivalent
 * for the model (list/create/rewind/cat); aligning VS Code to the CLI v2 implementation
 * is a tracked follow-up.
 */
import { runGit, truncate } from "./shared.mjs"
import { execSync, execFileSync } from "node:child_process"
import { resolve, relative, isAbsolute, sep } from "node:path"

/** Run git and report failure (stderr + exit code) instead of swallowing it.
 *  Used by write ops (commit/push/rm) where runGit's silent "" would masquerade
 *  as success (CLI parity: runGitStrict). config = `-c` overrides (proxy). */
function runGitStrict(cwd, cmdArgs, config = []) {
  try {
    const out = execFileSync("git", [...config, ...cmdArgs], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().replace(/\r/g, "")
    return { ok: true, out }
  } catch (e) {
    return { ok: false, out: String(e.stdout || "").trim(), err: String(e.stderr || e.message || "").trim() }
  }
}

/** Validate a git ref / branch / tag / remote name (no option injection, no whitespace). */
function validateRef(ref, what = "git ref") {
  if (!/^[A-Za-z0-9._/~^@][A-Za-z0-9._/~^@{}-]*$/.test(ref)) throw new Error(`Invalid ${what}: ${ref}`)
  return ref
}

/** Normalize args.config into `-c key=value` pairs (git -c overrides, e.g. a proxy). */
function gitConfigArgs(config) {
  if (config == null) return []
  if (!Array.isArray(config)) throw new Error("config must be an array of \"key=value\" strings")
  const out = []
  for (const c of config) {
    if (typeof c !== "string" || !c.trim() || c.includes("\n")) throw new Error(`invalid git -c config entry: ${String(c).slice(0, 60)}`)
    out.push("-c", c)
  }
  return out
}

/** True when `abs` is inside `root` (handles `..` and cross-drive, which relative()
 *  returns as an absolute path on Windows). */
function isInside(root, abs) {
  const rel = relative(root, abs)
  if (isAbsolute(rel)) return false
  return rel !== ".." && !rel.startsWith(".." + sep)
}

/** Resolve workdir relative to cwd, asserting it stays within the workspace. */
function resolveBaseDir(cwd, workdir) {
  if (!workdir || typeof workdir !== "string") return cwd
  const abs = resolve(cwd, workdir)
  if (!isInside(cwd, abs)) throw new Error(`workdir escapes the workspace: ${workdir}`)
  return abs
}

/** Snapshot the working tree before a destructive op — NON-destructive: `git stash create`
 *  builds a stash commit of the tracked changes WITHOUT cleaning the working tree (unlike
 *  `git stash push`, which would wipe the very changes the op is about to touch), then
 *  `git stash store` records it as a recoverable stash entry. Best-effort — a snapshot
 *  failure must not block the op (the approval layer is the real gate).
 *  Note: `git stash create` covers TRACKED changes only (CLI createCheckpoint also copies
 *  untracked files) — the destructive ops this guards (reset --hard / restore / checkout)
 *  don't touch untracked files, so the gap is acceptable. The `thincoder-guard-` prefix
 *  keeps these entries distinguishable from task checkpoints in `git stash list`. */
async function snapshotBefore(ctx, label) {
  try {
    const sha = execFileSync("git", ["stash", "create"], { cwd: ctx.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    if (!sha) return "" // no tracked changes to snapshot
    execFileSync("git", ["stash", "store", "-m", `thincoder-guard-${Date.now()}`, sha], { cwd: ctx.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return `[snapshot created before ${label}]\n`
  } catch {
    return ""
  }
}

/** Run git PRESERVING per-line leading whitespace — porcelain " M"/"M " staged/unstaged markers
 *  are significant (runGit trims the whole output's leading space, corrupting an unstaged-first-line). */
function runGitRaw(cwd, cmdArgs, config = []) {
  try {
    return execFileSync("git", [...config, ...cmdArgs], { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).replace(/\r/g, "").replace(/\n$/, "")
  } catch (e) {
    return String(e.stdout || "").replace(/\r/g, "")
  }
}

export const gitTool = {
  name: "git",
  readonly: false,
  description:
    "Run a git command. Only works inside a git repository.\n" +
    "- action='diff': unified diff (staged=true for staged-only, ref=<ref>, path=<dir> to scope). - 'status': staged/unstaged/untracked/conflicts. - 'log': recent commits (count, oneline, path). - 'show': a commit's details (ref).\n" +
    "- 'add': stage files (path, or -A all). - 'commit': stage + commit (message, path for granular). - 'rm': untrack a file (path, kept on disk).\n" +
    "- 'push'/'fetch'/'pull': sync with remote (remote, ref=branch/tag, tags=true for --tags).\n" +
    "- 'tag'/'branch'/'stash': manage them (tagAction/branchAction/stashAction: list/create/delete/switch, push/pop/list).\n" +
    "- 'checkout'/'restore': switch to ref, or restore a file (path). - 'reset': soft/mixed/hard (hard snapshots first). - 'revert'/'merge'/'cherry-pick': ref.\n" +
    "- 'checkpoint': snapshots (checkpointAction: list/create/rewind/cat).\n" +
    "- 'ls-remote': light remote-ref check — which refs a remote has (read-only, network). remote=<origin>, ref=<branch/tag> optional; config for a proxy.\n\n" +
    "**Route to git instead of bash:** `git status`→status, `git log`→log, `git diff`→diff, `git show`→show, `git add`→add, `git rm`→rm, `git commit -m`→commit, `git push <remote> <branch> <tag>`→push, `git tag`→tag, `git branch`→branch, `git checkout`→checkout, `git restore`→restore, `git stash`→stash, `git fetch/pull`→fetch/pull, `git reset`→reset, `git revert`→revert, `git merge`→merge, `git cherry-pick`→cherry-pick, `git ls-remote`→ls-remote.\n\n" +
    "Parameters:\n" +
    "- action (required): diff / status / log / show / checkpoint / add / rm / commit / push / tag / branch / checkout / restore / stash / fetch / pull / reset / revert / merge / cherry-pick / ls-remote\n" +
    "- path: (diff/log/add/commit/checkout/restore/rm) file/dir to scope/stage/restore\n" +
    "- ref: (show/diff/checkout/reset/revert/merge/cherry-pick) commit/branch/ref; (push/pull/fetch) branch or tag (space-separated for multiple)\n" +
    "- name: (branch/tag) the branch or tag name — remote: (push/fetch/pull) remote name — tags: (push) push all tags\n" +
    "- workdir: run git in this workspace subdirectory (monorepo / multi-repo). Confined to the workspace. Default: cwd\n" +
    "- config: (network actions push/fetch/pull/ls-remote) git -c overrides, e.g. [\"http.proxy=http://10.2.2.112:3128\"] for blocked remotes\n" +
    "- staged: (diff/restore) staged copy — count/oneline: (log) — message: (commit/stash) — filter: (read-only) output-line regex\n" +
    "- mode: (reset) soft/mixed/hard — tagAction/branchAction/stashAction: the sub-action\n" +
    "- checkpointAction / checkpointId: (checkpoint) sub-action / snapshot id",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["diff", "status", "log", "show", "checkpoint", "add", "rm", "commit", "push", "tag", "branch", "checkout", "restore", "stash", "fetch", "pull", "reset", "revert", "merge", "cherry-pick", "ls-remote"], description: "diff / status / log / show / checkpoint / add / rm / commit / push / tag / branch / checkout / restore / stash / fetch / pull / reset / revert / merge / cherry-pick / ls-remote" },
      staged: { type: "boolean", description: "(diff) Show staged changes instead of working tree; (restore) restore the staged copy" },
      path: { type: "string", description: "(diff/log/add/commit/checkout/restore/checkpoint:cat/rewind/rm) File or directory to scope to / stage / restore" },
      ref: { type: "string", description: "(diff/show/checkout/reset/revert/merge/cherry-pick/tag:create/branch:create) Commit/branch/ref; (push/pull/fetch) the branch or tag (space-separated for multiple)" },
      count: { type: "number", description: "(log) Number of commits (default 10)" },
      oneline: { type: "boolean", description: "(log) One-line-per-commit format" },
      message: { type: "string", description: "(commit) Commit message — required for commit; (stash:push) stash message" },
      filter: { type: "string", description: "(read-only actions) Regex to filter output lines by (case-insensitive)" },
      name: { type: "string", description: "(branch/tag) The branch or tag name (create/delete/switch)" },
      remote: { type: "string", description: "(push/fetch/pull) Remote name (e.g. origin). Default: current upstream" },
      workdir: { type: "string", description: "Run git in this workspace subdirectory (monorepo / multi-repo). Confined to the workspace. Default: cwd" },
      config: { type: "array", items: { type: "string" }, description: "(network actions: push/fetch/pull/ls-remote) git -c overrides, e.g. [\"http.proxy=http://10.2.2.112:3128\"] for blocked remotes" },
      tags: { type: "boolean", description: "(push) Also push all tags (--tags)" },
      mode: { type: "string", enum: ["soft", "mixed", "hard"], description: "(reset) reset mode — hard snapshots the tree first + needs confirmation" },
      tagAction: { type: "string", enum: ["list", "create", "delete"], description: "(tag) list tags / create one / delete one" },
      branchAction: { type: "string", enum: ["list", "create", "delete", "switch"], description: "(branch) list branches / create / delete / switch to one" },
      stashAction: { type: "string", enum: ["push", "pop", "list"], description: "(stash) push (stash now) / pop (apply+drop) / list" },
      checkpointAction: { type: "string", enum: ["list", "create", "rewind", "cat"], description: "(checkpoint) list snapshots / create one / restore by id / read file from snapshot" },
      checkpointId: { type: "string", description: "(checkpoint) Snapshot id — required for rewind and cat; optional for list (shows file tree)" },
    },
    required: ["action"],
  },
  async execute(args, ctx) {
    // workdir: run git in a workspace subdirectory (monorepo / multi-repo) — shadow ctx.cwd so
    // every action + snapshotBefore + checkpoint resolves against it, confined to the workspace.
    if (args.workdir) ctx = { ...ctx, cwd: resolveBaseDir(ctx.cwd, args.workdir) }
    const out = await this._execute(args, ctx)
    return out
  },

  /**
   * 判断某次 git 调用是否只读（供 execute-tools 审批过滤用）。
   * 只读 action 不弹审批：diff/status/log/show + checkpoint 的 list/cat。
   */
  isReadonlyAction(args) {
    if (!args || typeof args.action !== "string") return false
    if (["diff", "status", "log", "show", "ls-remote"].includes(args.action)) return true
    if (args.action === "checkpoint") return ["list", "cat"].includes(args.checkpointAction)
    if (args.action === "tag") return args.tagAction === "list"
    if (args.action === "branch") return args.branchAction === "list"
    if (args.action === "stash") return args.stashAction === "list"
    return false // add/rm/commit/push/fetch/pull/reset/revert/merge/cherry-pick/checkout/restore + tag/branch/stash 写操作
  },

  /** 内部实现：执行各 action。 */
  async _execute(args, ctx) {
    // 判断是否只读（供审批过滤用）——ls-remote 是只读网络检查
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
    const cfgArgs = gitConfigArgs(args.config)

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
        // Preserve per-line leading whitespace — porcelain " M"/"M " staged/unstaged markers are significant.
        const porcelain = runGitRaw(ctx.cwd, ["status", "--porcelain"])
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
        const r = runGitStrict(ctx.cwd, ["rm", "--cached", "-r", "--", args.path])
        return r.ok ? `Removed from tracking: ${args.path} (file kept on disk)` : `git rm failed: ${r.err || r.out}`
      }
      case "commit": {
        if (!args.message) return "Error: commit requires message"
        // Granular staging when path given (only stage these); otherwise stage all (add -A).
        const add = runGitStrict(ctx.cwd, args.path ? ["add", "--", args.path] : ["add", "-A"])
        if (!add.ok) return `git add failed: ${add.err || add.out || "(no output)"}`
        const commit = runGitStrict(ctx.cwd, ["commit", "-m", args.message])
        if (!commit.ok) return `git commit failed: ${commit.err || "(no output)"}`
        return commit.out || "(commit done)"
      }
      case "push": {
        const cmdArgs = ["push"]
        if (args.remote) cmdArgs.push(validateRef(args.remote, "remote"))
        if (args.ref) for (const r of args.ref.split(/\s+/).filter(Boolean)) cmdArgs.push(validateRef(r, "ref"))
        if (args.tags) cmdArgs.push("--tags")
        const r = runGitStrict(ctx.cwd, cmdArgs, cfgArgs)
        return r.ok ? (r.out || "(push done)") : `git push failed: ${r.err || r.out || "(no output)"}`
      }
      case "ls-remote": {
        // Lightweight remote-ref check — read-only network action, config for proxy.
        const cmdArgs = ["ls-remote"]
        if (args.remote) cmdArgs.push(validateRef(args.remote, "remote"))
        if (args.ref) for (const r of args.ref.split(/\s+/).filter(Boolean)) cmdArgs.push(validateRef(r, "ref"))
        const out = runGit(ctx.cwd, cmdArgs, cfgArgs)
        if (!out) return "(no refs / remote unreachable)"
        return truncate(applyFilter(out))
      }
      case "add": {
        // Granular staging: stage `path` when given, else all changes (add -A).
        const cmdArgs = args.path ? ["add", "--", args.path] : ["add", "-A"]
        const r = runGitStrict(ctx.cwd, cmdArgs)
        return r.ok ? (r.out || `Staged ${args.path || "all changes"}`) : `git add failed: ${r.err || r.out}`
      }
      case "tag": {
        const sub = args.tagAction
        if (sub === "list") return truncate(applyFilter(runGit(ctx.cwd, ["tag", "-l"]) || "(no tags)"))
        if (sub === "create") {
          if (!args.name) return "Error: tag create requires name"
          validateRef(args.name, "tag")
          const cmdArgs = ["tag", args.name]
          if (args.ref) cmdArgs.push(validateRef(args.ref))
          const r = runGitStrict(ctx.cwd, cmdArgs)
          return r.ok ? `Tag ${args.name} created` : `git tag failed: ${r.err || r.out}`
        }
        if (sub === "delete") {
          if (!args.name) return "Error: tag delete requires name"
          validateRef(args.name, "tag")
          const snap = await snapshotBefore(ctx, `tag delete ${args.name}`)
          const r = runGitStrict(ctx.cwd, ["tag", "-d", args.name])
          return r.ok ? snap + `Tag ${args.name} deleted` : `git tag -d failed: ${r.err || r.out}`
        }
        return "Error: tag requires tagAction — use: list | create | delete"
      }
      case "branch": {
        const sub = args.branchAction
        if (sub === "list") return truncate(applyFilter(runGit(ctx.cwd, ["branch", "--all", "-vv"]) || "(no branches)"))
        if (sub === "create") {
          if (!args.name) return "Error: branch create requires name"
          validateRef(args.name, "branch")
          const cmdArgs = ["branch", args.name]
          if (args.ref) cmdArgs.push(validateRef(args.ref))
          const r = runGitStrict(ctx.cwd, cmdArgs)
          return r.ok ? `Branch ${args.name} created` : `git branch failed: ${r.err || r.out}`
        }
        if (sub === "switch") {
          if (!args.name) return "Error: branch switch requires name"
          validateRef(args.name, "branch")
          const r = runGitStrict(ctx.cwd, ["checkout", args.name])
          return r.ok ? `Switched to branch ${args.name}` : `git checkout ${args.name} failed: ${r.err || r.out}`
        }
        if (sub === "delete") {
          if (!args.name) return "Error: branch delete requires name"
          validateRef(args.name, "branch")
          const snap = await snapshotBefore(ctx, `branch delete ${args.name}`)
          const r = runGitStrict(ctx.cwd, ["branch", "-d", args.name])
          return r.ok ? snap + `Branch ${args.name} deleted` : `git branch -d failed: ${r.err || r.out}`
        }
        return "Error: branch requires branchAction — use: list | create | delete | switch"
      }
      case "checkout": {
        if (args.path) {
          // Restore file from index (discards working-tree changes to it) — destructive: snapshot first.
          const snap = await snapshotBefore(ctx, `checkout -- ${args.path}`)
          const r = runGitStrict(ctx.cwd, ["checkout", "--", args.path])
          return r.ok ? snap + `Restored ${args.path}` : `git checkout -- ${args.path} failed: ${r.err || r.out}`
        }
        if (args.ref) {
          validateRef(args.ref, "ref")
          const r = runGitStrict(ctx.cwd, ["checkout", args.ref])
          return r.ok ? (r.out || `Checked out ${args.ref}`) : `git checkout ${args.ref} failed: ${r.err || r.out}`
        }
        return "Error: checkout requires ref (branch/commit) or path (file to restore)"
      }
      case "restore": {
        if (!args.path) return "Error: restore requires path"
        const snap = await snapshotBefore(ctx, `restore ${args.path}`)
        const cmdArgs = ["restore"]
        if (args.staged) cmdArgs.push("--staged")
        cmdArgs.push("--", args.path)
        const r = runGitStrict(ctx.cwd, cmdArgs)
        return r.ok ? snap + `Restored ${args.path}` : `git restore failed: ${r.err || r.out}`
      }
      case "stash": {
        const sub = args.stashAction
        if (sub === "list") return truncate(applyFilter(runGit(ctx.cwd, ["stash", "list"]) || "(no stashes)"))
        if (sub === "push") {
          const cmdArgs = ["stash", "push"]
          if (args.message) cmdArgs.push("-m", args.message)
          const r = runGitStrict(ctx.cwd, cmdArgs)
          return r.ok ? (r.out || "Stashed") : `git stash push failed: ${r.err || r.out}`
        }
        if (sub === "pop") {
          const snap = await snapshotBefore(ctx, "stash pop")
          const r = runGitStrict(ctx.cwd, ["stash", "pop"])
          return r.ok ? snap + (r.out || "Popped") : `git stash pop failed: ${r.err || r.out}`
        }
        return "Error: stash requires stashAction — use: push | pop | list"
      }
      case "fetch": {
        const cmdArgs = ["fetch"]
        if (args.remote) cmdArgs.push(validateRef(args.remote, "remote"))
        if (args.ref) cmdArgs.push(validateRef(args.ref, "ref"))
        const r = runGitStrict(ctx.cwd, cmdArgs, cfgArgs)
        return r.ok ? (r.out || "(fetch complete — no output)") : `git fetch failed: ${r.err || r.out}`
      }
      case "pull": {
        const cmdArgs = ["pull"]
        if (args.remote) cmdArgs.push(validateRef(args.remote, "remote"))
        if (args.ref) cmdArgs.push(validateRef(args.ref, "ref"))
        const r = runGitStrict(ctx.cwd, cmdArgs, cfgArgs)
        return r.ok ? (r.out || "(pull complete — no output)") : `git pull failed: ${r.err || r.out}`
      }
      case "reset": {
        const mode = args.mode ?? "mixed"
        if (!["soft", "mixed", "hard"].includes(mode)) return "Error: reset mode must be soft | mixed | hard"
        let snap = ""
        if (mode === "hard") snap = await snapshotBefore(ctx, "reset --hard") // destructive: drops working-tree changes
        const cmdArgs = ["reset", `--${mode}`]
        if (args.ref) cmdArgs.push(validateRef(args.ref))
        const r = runGitStrict(ctx.cwd, cmdArgs)
        return r.ok ? snap + (r.out || `Reset (${mode}) complete`) : `git reset failed: ${r.err || r.out}`
      }
      case "revert": {
        const ref = validateRef(args.ref ?? "HEAD")
        const r = runGitStrict(ctx.cwd, ["revert", "--no-edit", ref])
        return r.ok ? (r.out || `Reverted ${ref}`) : `git revert failed: ${r.err || r.out}`
      }
      case "merge": {
        if (!args.ref) return "Error: merge requires ref (branch/commit to merge)"
        validateRef(args.ref, "ref")
        const r = runGitStrict(ctx.cwd, ["merge", "--no-edit", args.ref])
        return r.ok ? (r.out || `Merged ${args.ref}`) : `git merge failed: ${r.err || r.out} — resolve conflicts, then commit`
      }
      case "cherry-pick": {
        if (!args.ref) return "Error: cherry-pick requires ref (commit)"
        validateRef(args.ref, "ref")
        const r = runGitStrict(ctx.cwd, ["cherry-pick", args.ref])
        return r.ok ? (r.out || `Cherry-picked ${args.ref}`) : `git cherry-pick failed: ${r.err || r.out}`
      }
      case "checkpoint": {
        return await checkpointExecute(args, ctx)
      }
      default:
        return `Unknown action '${args.action}'. Use: diff | status | log | show | checkpoint | add | rm | commit | push | tag | branch | checkout | restore | stash | fetch | pull | reset | revert | merge | cherry-pick`
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
