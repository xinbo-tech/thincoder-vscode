import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { checklistTool, pendingItems } from "../src/tools/checklist.mjs"
import { lintTool } from "../src/tools/linter.mjs"
import { timerTool } from "../src/agent-tools/timer.mjs"

let tmp, cwd
const ctx = () => ({ cwd })

function setup() {
  tmp = mkdtempSync(join(tmpdir(), "thincoder-vscode-tools-test-"))
  cwd = tmp
}
function cleanup() { rmSync(tmp, { recursive: true, force: true }) }

describe("checklist — persistent tree checklist (ported from CLI)", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("add assigns sequential root IDs (T1, T2)", () => {
    const r1 = checklistTool.execute({ action: "add", item: "first" }, ctx())
    const r2 = checklistTool.execute({ action: "add", item: "second" }, ctx())
    assert.match(r1, /T1: first/)
    assert.match(r2, /T2: second/)
  })

  it("add with parent creates child ID (T1.1)", () => {
    checklistTool.execute({ action: "add", item: "root" }, ctx())
    const r = checklistTool.execute({ action: "add", item: "child", parent: "T1" }, ctx())
    assert.match(r, /T1\.1: child/)
    assert.match(r, /under T1/)
  })

  it("add with unknown parent errors", () => {
    const r = checklistTool.execute({ action: "add", item: "x", parent: "T99" }, ctx())
    assert.match(r, /Error: parent 'T99' not found/)
  })

  it("add without item errors", () => {
    const r = checklistTool.execute({ action: "add" }, ctx())
    assert.match(r, /Error: 'item' is required/)
  })

  it("list renders tree with status marks", () => {
    checklistTool.execute({ action: "add", item: "root" }, ctx())
    checklistTool.execute({ action: "add", item: "child", parent: "T1" }, ctx())
    checklistTool.execute({ action: "mark", index: 2, status: "in_progress" }, ctx())
    const out = checklistTool.execute({ action: "list" }, ctx())
    assert.match(out, /- \[ \] T1: root/)
    assert.match(out, / {2}- \[~\] T1\.1: child/)
  })

  it("list on empty returns placeholder", () => {
    assert.equal(checklistTool.execute({ action: "list" }, ctx()), "(checklist is empty)")
  })

  it("mark in_progress updates status", () => {
    checklistTool.execute({ action: "add", item: "task" }, ctx())
    const r = checklistTool.execute({ action: "mark", index: 1, status: "in_progress" }, ctx())
    assert.match(r, /Marked T1 pending → in_progress/)
    const pending = pendingItems(cwd)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].status, "in_progress")
  })

  it("mark done archives to checklist-done.md and removes from list", () => {
    checklistTool.execute({ action: "add", item: "task" }, ctx())
    checklistTool.execute({ action: "mark", index: 1, status: "done" }, ctx())
    assert.equal(checklistTool.execute({ action: "list" }, ctx()), "(checklist is empty)")
    assert.equal(pendingItems(cwd).length, 0)
    const doneFile = join(cwd, ".thincoder", "checklist-done.md")
    assert.ok(existsSync(doneFile))
    assert.match(readFileSync(doneFile, "utf8"), /- \[x\] T1: task/)
  })

  it("mark with out-of-range index errors", () => {
    const r = checklistTool.execute({ action: "mark", index: 5, status: "done" }, ctx())
    assert.match(r, /Error: index 5 out of range/)
  })

  it("mark with invalid status errors", () => {
    checklistTool.execute({ action: "add", item: "t" }, ctx())
    const r = checklistTool.execute({ action: "mark", index: 1, status: "bogus" }, ctx())
    assert.match(r, /Error: 'status' is required/)
  })

  it("mark no-op when status unchanged", () => {
    checklistTool.execute({ action: "add", item: "t" }, ctx())
    const r = checklistTool.execute({ action: "mark", index: 1, status: "pending" }, ctx())
    assert.match(r, /Already pending/)
  })

  it("unknown action errors", () => {
    const r = checklistTool.execute({ action: "nope" }, ctx())
    assert.match(r, /Error: unknown action/)
  })

  it("T-cl-1 mark by id 精确命中中部条目，头部无关条目不误标", () => {
    mkdirSync(join(cwd, ".thincoder"), { recursive: true })
    writeFileSync(join(cwd, ".thincoder", "checklist.md"),
      "- [ ] T1: alpha\n- [ ] T2: beta\n- [ ] T63: gamma\n- [ ] T3: delta\n")
    const r = checklistTool.execute({ action: "mark", id: "T63", status: "done" }, ctx())
    assert.match(r, /Marked T63 .*→ done/)
    const content = readFileSync(join(cwd, ".thincoder", "checklist.md"), "utf8")
    assert.doesNotMatch(content, /T63/)
    assert.match(content, /T1: alpha/)
    assert.match(content, /T2: beta/)
    assert.match(content, /T3: delta/)
    assert.match(readFileSync(join(cwd, ".thincoder", "checklist-done.md"), "utf8"), /T63: gamma/)
  })

  it("T-cl-2 add 返回的 id 可直接用于 mark id 闭环", () => {
    const added = checklistTool.execute({ action: "add", item: "闭环任务" }, ctx())
    const m = added.match(/Added: \[ \] (T\d+): 闭环任务/)
    assert.ok(m, `add 返回应含 id: ${added}`)
    const r = checklistTool.execute({ action: "mark", id: m[1], status: "done" }, ctx())
    assert.match(r, new RegExp(`Marked ${m[1]} .*→ done`))
    assert.equal(checklistTool.execute({ action: "list" }, ctx()), "(checklist is empty)")
  })

  it("T-cl-3 同时给 id 和 index 时按 id 命中，忽略 index", () => {
    mkdirSync(join(cwd, ".thincoder"), { recursive: true })
    writeFileSync(join(cwd, ".thincoder", "checklist.md"), "- [ ] T1: first\n- [ ] T63: second\n")
    const r = checklistTool.execute({ action: "mark", id: "T63", index: 1, status: "done" }, ctx())
    assert.match(r, /Marked T63 .*→ done/)
    const content = readFileSync(join(cwd, ".thincoder", "checklist.md"), "utf8")
    assert.match(content, /T1: first/)
    assert.doesNotMatch(content, /T63/)
  })

  it("T-cl-4 仅给 index（无 id）沿用 flat[index-1] 命中", () => {
    mkdirSync(join(cwd, ".thincoder"), { recursive: true })
    writeFileSync(join(cwd, ".thincoder", "checklist.md"), "- [ ] T1: first\n- [ ] T2: second\n")
    const r = checklistTool.execute({ action: "mark", index: 2, status: "in_progress" }, ctx())
    assert.match(r, /Marked T2 .*→ in_progress/)
    const content = readFileSync(join(cwd, ".thincoder", "checklist.md"), "utf8")
    assert.match(content, /- \[ \] T1: first/)
    assert.match(content, /- \[~\] T2: second/)
  })

  it("T-cl-5 非连续 ID（T17/T19/T21）add 两条根条目分配 T22/T23 不撞号", () => {
    mkdirSync(join(cwd, ".thincoder"), { recursive: true })
    writeFileSync(join(cwd, ".thincoder", "checklist.md"), "- [ ] T17: a\n- [ ] T19: b\n- [ ] T21: c\n")
    const r1 = checklistTool.execute({ action: "add", item: "新一" }, ctx())
    const r2 = checklistTool.execute({ action: "add", item: "新二" }, ctx())
    assert.match(r1, /Added: \[ \] T22: 新一/)
    assert.match(r2, /Added: \[ \] T23: 新二/)
    const content = readFileSync(join(cwd, ".thincoder", "checklist.md"), "utf8")
    assert.match(content, /T17: a/)
    assert.match(content, /T19: b/)
    assert.match(content, /T21: c/)
    assert.match(content, /T22: 新一/)
    assert.match(content, /T23: 新二/)
    assert.doesNotMatch(content, /T18/)
    assert.doesNotMatch(content, /T20/)
  })

  it("T-cl-6 前缀累积 T15: T15: T15: 归一为单一前缀", () => {
    mkdirSync(join(cwd, ".thincoder"), { recursive: true })
    writeFileSync(join(cwd, ".thincoder", "checklist.md"), "- [ ] T15: T15: T15: 文本\n")
    checklistTool.execute({ action: "mark", id: "T15", status: "in_progress" }, ctx())
    const content = readFileSync(join(cwd, ".thincoder", "checklist.md"), "utf8")
    assert.match(content, /- \[~\] T15: 文本/)
    assert.doesNotMatch(content, /T15: T15/)
  })

  it("T-cl-7 历史无 id 行多次 parse→write 后 ID 一次性分配不漂移", () => {
    mkdirSync(join(cwd, ".thincoder"), { recursive: true })
    writeFileSync(join(cwd, ".thincoder", "checklist.md"), "- [ ] 无id一\n- [ ] 无id二\n")
    checklistTool.execute({ action: "list" }, ctx())
    const afterFirst = readFileSync(join(cwd, ".thincoder", "checklist.md"), "utf8")
    assert.match(afterFirst, /T1: 无id一/)
    assert.match(afterFirst, /T2: 无id二/)
    checklistTool.execute({ action: "mark", id: "T1", status: "in_progress" }, ctx())
    checklistTool.execute({ action: "list" }, ctx())
    const afterMore = readFileSync(join(cwd, ".thincoder", "checklist.md"), "utf8")
    assert.match(afterMore, /T1: 无id一/)
    assert.match(afterMore, /T2: 无id二/)
    assert.doesNotMatch(afterMore, /T3/)
  })

  it("T-cl-8 父 done 子树全 done → 递归归档（层级保留）", () => {
    mkdirSync(join(cwd, ".thincoder"), { recursive: true })
    writeFileSync(join(cwd, ".thincoder", "checklist.md"),
      "- [ ] T1: parent\n  - [x] T1.1: child1\n  - [x] T1.2: child2\n")
    const r = checklistTool.execute({ action: "mark", id: "T1", status: "done" }, ctx())
    assert.match(r, /Marked T1 .*→ done/)
    const content = readFileSync(join(cwd, ".thincoder", "checklist.md"), "utf8")
    assert.doesNotMatch(content, /T1/)
    const done = readFileSync(join(cwd, ".thincoder", "checklist-done.md"), "utf8")
    assert.match(done, /- \[x\] T1: parent/)
    assert.match(done, /\n {2}- \[x\] T1\.1: child1/)
    assert.match(done, /\n {2}- \[x\] T1\.2: child2/)
  })

  it("T-cl-9 父 done 子树有 pending → 拒绝（父子都不归档不删除）", () => {
    mkdirSync(join(cwd, ".thincoder"), { recursive: true })
    writeFileSync(join(cwd, ".thincoder", "checklist.md"),
      "- [ ] T1: parent\n  - [ ] T1.1: child1\n")
    const r = checklistTool.execute({ action: "mark", id: "T1", status: "done" }, ctx())
    assert.match(r, /先处理子任务/)
    const content = readFileSync(join(cwd, ".thincoder", "checklist.md"), "utf8")
    assert.match(content, /T1: parent/)
    assert.match(content, /T1\.1: child1/)
    assert.ok(!existsSync(join(cwd, ".thincoder", "checklist-done.md")), "done 文件不应生成")
  })

  it("T-cl-10 归档最大号后 add 不复用 ID（T62 → T63）", () => {
    mkdirSync(join(cwd, ".thincoder"), { recursive: true })
    writeFileSync(join(cwd, ".thincoder", "checklist.md"), "- [ ] T62: last\n")
    checklistTool.execute({ action: "mark", id: "T62", status: "done" }, ctx())
    const r = checklistTool.execute({ action: "add", item: "新条目" }, ctx())
    assert.match(r, /Added: \[ \] T63: 新条目/)
  })

  it("T-cl-11 无 ID 根条目自动分配不撞 done 文件归档 ID（done 有 T11 → 得 T12）", () => {
    mkdirSync(join(cwd, ".thincoder"), { recursive: true })
    writeFileSync(join(cwd, ".thincoder", "checklist.md"), "- [ ] T10: 十\n- [ ] 无id条目\n")
    writeFileSync(join(cwd, ".thincoder", "checklist-done.md"), "- [x] T11: 已归档\n")
    checklistTool.execute({ action: "list" }, ctx()) // 触发 parse → assignIds 落盘
    const content = readFileSync(join(cwd, ".thincoder", "checklist.md"), "utf8")
    assert.match(content, /T10: 十/)
    assert.match(content, /T12: 无id条目/)          // 跳过 done 文件的 T11
    assert.doesNotMatch(content, /T11: 无id条目/)   // 不撞归档 ID
  })
})

describe("lint — language-aware cascade (ported from CLI)", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("fast path: reports Syntax OK for valid JS", async () => {
    const f = join(cwd, "ok.mjs")
    writeFileSync(f, "export const x = 1\n")
    const r = await lintTool.execute({ path: f }, ctx())
    assert.match(r, /Syntax OK/)
  })

  it("fast path: reports syntax error for invalid JS", async () => {
    const f = join(cwd, "bad.mjs")
    writeFileSync(f, "export const = \n")
    const r = await lintTool.execute({ path: f }, ctx())
    assert.match(r, /Syntax error/)
  })

  it("fast path: rejects non-JS-family file", async () => {
    const f = join(cwd, "a.txt")
    writeFileSync(f, "hello\n")
    const r = await lintTool.execute({ path: f }, ctx())
    assert.match(r, /only JS\/TS-family files supported/)
  })

  it("no path and no touched file returns guidance", async () => {
    const r = await lintTool.execute({}, { cwd, agent: { _touchedFiles: [] } })
    assert.match(r, /no file specified and no recently modified file/)
  })

  it("falls back to most recently touched file when path omitted", async () => {
    const f = join(cwd, "touched.mjs")
    writeFileSync(f, "export const y = 2\n")
    const r = await lintTool.execute({}, { cwd, agent: { _touchedFiles: ["touched.mjs"] } })
    assert.match(r, /Syntax OK/)
  })

  it("full cascade: eslint finds no issues in this repo (config present)", async () => {
    // Run inside the vscode repo itself which has eslint.config.mjs
    const repoCwd = join(import.meta.dirname, "..")
    const f = join(repoCwd, "src", "tools", "linter.mjs")
    const r = await lintTool.execute({ path: f, full: true }, { cwd: repoCwd })
    assert.match(r, /eslint: no issues/)
  })
})

describe("timer — thinking-budget timer (ported from CLI)", () => {
  it("pushes a pending timer onto agent._pendingTimers", () => {
    const agent = {}
    const before = Date.now()
    const r = timerTool.execute({ seconds: 60 }, { agent })
    assert.match(r, /Timer set for 60 seconds/)
    assert.equal(agent._pendingTimers.length, 1)
    const t = agent._pendingTimers[0]
    assert.ok(t.expiresAt >= before + 60000 && t.expiresAt <= Date.now() + 60000)
    assert.match(t.message, /Time's up \(60s\)/)
  })

  it("uses a custom message when provided", () => {
    const agent = {}
    timerTool.execute({ seconds: 5, message: "custom reminder" }, { agent })
    assert.equal(agent._pendingTimers[0].message, "custom reminder")
  })

  it("initializes _pendingTimers if absent (lazy)", () => {
    const agent = { _pendingTimers: undefined }
    timerTool.execute({ seconds: 1 }, { agent })
    assert.ok(Array.isArray(agent._pendingTimers))
  })

  it("is readonly and side-effect-exempt (does not trigger verify guard)", () => {
    assert.equal(timerTool.readonly, true)
    assert.equal(timerTool.sideEffectExempt, true)
  })
})

describe("edit — literal replacement contract (no $-interpolation)", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("new_string with $& is inserted LITERALLY (regression: string replace corrupted files)", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    const f = join(cwd, "a.mjs")
    writeFileSync(f, "const x = 1\n")
    const marker = "const re = s.replace(/a/g, " + String.fromCharCode(34, 36, 38, 34) + ")"
    const r = await editTool.execute({ path: "a.mjs", old_string: "const x = 1", new_string: marker }, ctx())
    assert.match(r, /Replaced 1 occurrence/)
    assert.equal(readFileSync(f, "utf8"), marker + "\n")
  })

  it("replace_all with $-patterns replaces every occurrence literally", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    const f = join(cwd, "b.mjs")
    writeFileSync(f, "a\na\n")
    const marker = ["$", "&", "$", "1"].join("")
    const r = await editTool.execute({ path: "b.mjs", old_string: "a", new_string: marker, replace_all: true }, ctx())
    assert.match(r, /Replaced 2 occurrence/)
    assert.equal(readFileSync(f, "utf8"), marker + "\n" + marker + "\n")
  })
})

describe("hashline_edit — content-hash addressing (ported from CLI)", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("replaces a single line by hash", async () => {
    const { hashlineEditTool } = await import("../src/tools/file.mjs")
    const { hashLine } = await import("../src/tools/shared.mjs")
    const f = join(cwd, "a.txt")
    writeFileSync(f, "line one\nline two\nline three\n")
    const h = hashLine("line two")
    const r = await hashlineEditTool.execute({ path: "a.txt", old_hashes: [h], new_content: "replaced" }, ctx())
    assert.match(r, /replaced 1 line\(s\) at L2/)
    assert.equal(readFileSync(f, "utf8"), "line one\nreplaced\nline three\n")
  })

  it("replaces a contiguous block by hash sequence", async () => {
    const { hashlineEditTool } = await import("../src/tools/file.mjs")
    const { hashLine } = await import("../src/tools/shared.mjs")
    const f = join(cwd, "b.txt")
    writeFileSync(f, "a\nb\nc\nd\n")
    const r = await hashlineEditTool.execute({
      path: "b.txt",
      old_hashes: [hashLine("b"), hashLine("c")],
      new_content: "x\ny",
    }, ctx())
    assert.match(r, /replaced 2 line\(s\) at L2 with 2 line\(s\)/)
    assert.equal(readFileSync(f, "utf8"), "a\nx\ny\nd\n")
  })

  it("reports missing hash sequence with current hashes", async () => {
    const { hashlineEditTool } = await import("../src/tools/file.mjs")
    const f = join(cwd, "c.txt")
    writeFileSync(f, "only\n")
    await assert.rejects(
      () => hashlineEditTool.execute({ path: "c.txt", old_hashes: ["deadbeef00aa"], new_content: "x" }, ctx()),
      /Hash sequence not found/,
    )
  })

  it("rejects ambiguous matches with position details", async () => {
    const { hashlineEditTool } = await import("../src/tools/file.mjs")
    const { hashLine } = await import("../src/tools/shared.mjs")
    const f = join(cwd, "d.txt")
    writeFileSync(f, "same\nsame\nsame\n")
    await assert.rejects(
      () => hashlineEditTool.execute({ path: "d.txt", old_hashes: [hashLine("same")], new_content: "x" }, ctx()),
      /matches 3 positions/,
    )
  })
})

describe("git — unified tool (CLI parity: action subcommands)", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("builtin registry exposes git as a single tool (no git_diff/status/log/checkpoint)", async () => {
    const { builtinTools } = await import("../src/tools/index.mjs")
    const names = builtinTools.map((t) => t.name)
    assert.ok(names.includes("git"))
    assert.ok(!names.includes("git_diff"))
    assert.ok(!names.includes("git_status"))
    assert.ok(!names.includes("git_log"))
    assert.ok(!names.includes("checkpoint"))
    assert.ok(names.includes("hashline_edit"))
  })

  it("diff/status/log run against a real repo", async () => {
    const { gitTool } = await import("../src/tools/git.mjs")
    const { execSync } = await import("node:child_process")
    execSync("git init -q", { cwd })
    execSync('git config user.email t@t && git config user.name t', { cwd })
    writeFileSync(join(cwd, "f.txt"), "hello\n")
    execSync("git add f.txt && git commit -qm init", { cwd })
    writeFileSync(join(cwd, "f.txt"), "hello world\n")
    const st = await gitTool.execute({ action: "status" }, ctx())
    assert.match(st, /f\.txt/, "modified file listed: " + st)
    const df = await gitTool.execute({ action: "diff" }, ctx())
    assert.match(df, /hello world/)
    const lg = await gitTool.execute({ action: "log", oneline: true }, ctx())
    assert.match(lg, /init/)
  })

  it("unknown action returns guidance", async () => {
    const { gitTool } = await import("../src/tools/git.mjs")
    const r = await gitTool.execute({ action: "nope" }, ctx())
    assert.match(r, /Unknown action 'nope'/)
  })

  it("show returns commit stat; rm untracks; commit+push work", async () => {
    const { gitTool } = await import("../src/tools/git.mjs")
    const { execSync } = await import("node:child_process")
    execSync("git init -q", { cwd })
    execSync("git config user.email t@t && git config user.name t", { cwd })
    writeFileSync(join(cwd, "a.txt"), "hello\n")
    execSync("git add a.txt && git commit -qm init", { cwd })
    writeFileSync(join(cwd, "b.txt"), "world\n")

    // show: 默认 HEAD，有 init 提交的 stat
    const sh = await gitTool.execute({ action: "show" }, ctx())
    assert.match(sh, /init/)

    // rm: 把 b.txt 移出跟踪（文件保留）
    execSync("git add b.txt", { cwd })
    const rm = await gitTool.execute({ action: "rm", path: "b.txt" }, ctx())
    assert.match(rm, /Removed from tracking: b\.txt/)
    const tracked = execSync("git ls-files", { cwd, encoding: "utf8" })
    assert.ok(tracked.includes("a.txt"))
    assert.ok(!tracked.includes("b.txt"))
    assert.ok(existsSync(join(cwd, "b.txt"))) // 磁盘还在

    // commit + push: 提交一个文件
    writeFileSync(join(cwd, "c.txt"), "c\n")
    const cm = await gitTool.execute({ action: "commit", message: "add c" }, ctx())
    assert.match(cm, /add c/)
    const lg = await gitTool.execute({ action: "log", oneline: true }, ctx())
    assert.match(lg, /add c/)
  })

  it("filter keeps only matching lines on read-only actions", async () => {
    const { gitTool } = await import("../src/tools/git.mjs")
    const { execSync } = await import("node:child_process")
    execSync("git init -q", { cwd })
    execSync("git config user.email t@t && git config user.name t", { cwd })
    writeFileSync(join(cwd, "target.txt"), "x\n")
    writeFileSync(join(cwd, "other.txt"), "y\n")
    execSync("git add -A && git commit -qm init", { cwd })
    writeFileSync(join(cwd, "target.txt"), "changed\n")

    const st = await gitTool.execute({ action: "status", filter: "target" }, ctx())
    assert.match(st, /target\.txt/)
    assert.ok(!st.includes("other.txt"))
  })

  it("isReadonlyAction distinguishes read vs write actions", async () => {
    const { gitTool } = await import("../src/tools/git.mjs")
    assert.ok(gitTool.isReadonlyAction({ action: "status" }))
    assert.ok(gitTool.isReadonlyAction({ action: "diff" }))
    assert.ok(gitTool.isReadonlyAction({ action: "log" }))
    assert.ok(gitTool.isReadonlyAction({ action: "show" }))
    assert.ok(gitTool.isReadonlyAction({ action: "checkpoint", checkpointAction: "list" }))
    assert.ok(gitTool.isReadonlyAction({ action: "checkpoint", checkpointAction: "cat" }))
    assert.ok(!gitTool.isReadonlyAction({ action: "rm" }))
    assert.ok(!gitTool.isReadonlyAction({ action: "commit" }))
    assert.ok(!gitTool.isReadonlyAction({ action: "push" }))
    assert.ok(!gitTool.isReadonlyAction({ action: "checkpoint", checkpointAction: "create" }))
    assert.ok(!gitTool.isReadonlyAction({ action: "checkpoint", checkpointAction: "rewind" }))
    assert.ok(!gitTool.isReadonlyAction({ action: "nope" }))
  })

  it("扩充 action：add/commit 分文件、tag、branch、checkout/restore、stash、reset、revert、merge、cherry-pick、参数校验", async () => {
    const { gitTool } = await import("../src/tools/git.mjs")
    const { execSync, execFileSync } = await import("node:child_process")
    const g = (...a) => execFileSync("git", a, { cwd, encoding: "utf8" })
    execSync("git init -q", { cwd })
    execSync("git config user.email t@t && git config user.name t", { cwd })
    execSync("git config core.autocrlf false", { cwd })
    writeFileSync(join(cwd, "a.js"), "1\n")
    execSync("git add a.js && git commit -qm first", { cwd })
    const main = g("branch", "--show-current").trim()

    // add 分文件 + commit path
    writeFileSync(join(cwd, "b.js"), "2\n")
    assert.doesNotMatch(await gitTool.execute({ action: "add", path: "b.js" }, ctx()), /failed/i)
    assert.doesNotMatch(await gitTool.execute({ action: "commit", message: "add b", path: "b.js" }, ctx()), /failed/i)

    // tag create/list/delete
    assert.match(await gitTool.execute({ action: "tag", tagAction: "create", name: "v0.1" }, ctx()), /created/)
    assert.match(await gitTool.execute({ action: "tag", tagAction: "list" }, ctx()), /v0\.1/)
    assert.match(await gitTool.execute({ action: "tag", tagAction: "delete", name: "v0.1" }, ctx()), /deleted/)

    // branch create/list/switch
    assert.match(await gitTool.execute({ action: "branch", branchAction: "create", name: "feat" }, ctx()), /created/)
    assert.match(await gitTool.execute({ action: "branch", branchAction: "list" }, ctx()), /feat/)
    assert.match(await gitTool.execute({ action: "branch", branchAction: "switch", name: "feat" }, ctx()), /Switched/)
    g("checkout", "-q", main)

    // checkout -- file（还原工作区改动）
    writeFileSync(join(cwd, "a.js"), "changed\n")
    assert.doesNotMatch(await gitTool.execute({ action: "checkout", path: "a.js" }, ctx()), /failed/i)
    assert.equal(readFileSync(join(cwd, "a.js"), "utf8"), "1\n")

    // restore --staged
    writeFileSync(join(cwd, "a.js"), "staged\n"); g("add", "a.js")
    await gitTool.execute({ action: "restore", path: "a.js", staged: true }, ctx())
    assert.match(await gitTool.execute({ action: "status" }, ctx()), /Unstaged/)

    // stash push/list/pop
    writeFileSync(join(cwd, "a.js"), "wip\n")
    assert.doesNotMatch(await gitTool.execute({ action: "stash", stashAction: "push" }, ctx()), /failed/i)
    assert.match(await gitTool.execute({ action: "stash", stashAction: "list" }, ctx()), /stash/)
    assert.doesNotMatch(await gitTool.execute({ action: "stash", stashAction: "pop" }, ctx()), /failed/i)

    // reset soft/hard + revert
    g("checkout", "-q", "--", ".")
    assert.doesNotMatch(await gitTool.execute({ action: "reset", mode: "soft" }, ctx()), /failed/i)
    assert.doesNotMatch(await gitTool.execute({ action: "reset", mode: "hard" }, ctx()), /failed/i)
    assert.doesNotMatch(await gitTool.execute({ action: "revert" }, ctx()), /failed/i)

    // merge + cherry-pick（side 分支提交，main 干净应用）
    g("checkout", "-q", main)
    await gitTool.execute({ action: "branch", branchAction: "create", name: "side" }, ctx())
    await gitTool.execute({ action: "branch", branchAction: "switch", name: "side" }, ctx())
    writeFileSync(join(cwd, "side.js"), "s\n")
    await gitTool.execute({ action: "commit", message: "side", path: "side.js" }, ctx())
    const sideRef = g("rev-parse", "HEAD").trim()
    await gitTool.execute({ action: "branch", branchAction: "switch", name: main }, ctx())
    assert.doesNotMatch(await gitTool.execute({ action: "cherry-pick", ref: sideRef }, ctx()), /fatal|failed/i)
    assert.doesNotMatch(await gitTool.execute({ action: "merge", ref: "side" }, ctx()), /fatal|failed/i)

    // 参数校验
    assert.match(await gitTool.execute({ action: "commit" }, ctx()), /requires message/)
    assert.match(await gitTool.execute({ action: "merge" }, ctx()), /requires ref/)
  })

  it("workdir 在 workspace 子目录的 git 仓库运行；越界报错", async () => {
    const { gitTool } = await import("../src/tools/git.mjs")
    const { execFileSync } = await import("node:child_process")
    const { mkdirSync } = await import("node:fs")
    const sub = join(cwd, "sub")
    mkdirSync(sub, { recursive: true })
    execFileSync("git", ["init", "-q"], { cwd: sub })
    execFileSync("git", ["config", "user.name", "t"], { cwd: sub })
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: sub })
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: sub })
    writeFileSync(join(sub, "x.js"), "1\n")
    execFileSync("git", ["add", "x.js"], { cwd: sub })
    execFileSync("git", ["commit", "-qm", "init"], { cwd: sub })

    const log = await gitTool.execute({ action: "log", workdir: "sub" }, ctx())
    assert.match(log, /init/)
    await assert.rejects(() => gitTool.execute({ action: "status", workdir: "../escape" }, ctx()), /escapes the workspace/)
  })
})

describe("bash — git destructive-command protection (CLI parity)", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("snapshots then ALLOWS checkout -- . (uncommitted work recoverable from stash)", async () => {
    const { bashTool } = await import("../src/tools/shell.mjs")
    const { execSync } = await import("node:child_process")
    execSync("git init -q", { cwd })
    execSync("git config user.email t@t && git config user.name t", { cwd })
    writeFileSync(join(cwd, "app.js"), "const v = 1\n")
    execSync("git add app.js && git commit -qm init", { cwd })
    writeFileSync(join(cwd, "app.js"), "const v = 2 // uncommitted\n")

    // 不拦截：快照（stash）后放行，命令正常执行
    const r = await bashTool.execute({ command: "git checkout -- ." }, { cwd })
    assert.match(r, /\[auto-protection\]/, "应提示自动快照: " + r.slice(0, 120))
    assert.equal(readFileSync(join(cwd, "app.js"), "utf8").replace(/\r\n/g, "\n"), "const v = 1\n", "命令已执行（未被拦截）")
    // stash 已保存 → 可恢复
    const stash = execSync("git stash list", { cwd, encoding: "utf8" })
    assert.match(stash, /thincoder-auto-/)
    execSync("git stash apply", { cwd, encoding: "utf8" })
    assert.equal(readFileSync(join(cwd, "app.js"), "utf8").replace(/\r\n/g, "\n"), "const v = 2 // uncommitted\n", "stash 恢复未提交工作")
  })

  it("variant `git checkout HEAD -- .` is snapshot-guarded and the work is recoverable", async () => {
    const { bashTool } = await import("../src/tools/shell.mjs")
    const { execSync } = await import("node:child_process")
    execSync("git init -q", { cwd })
    execSync("git config user.email t@t && git config user.name t", { cwd })
    writeFileSync(join(cwd, "app.js"), "const v = 1\n")
    execSync("git add app.js && git commit -qm init", { cwd })
    writeFileSync(join(cwd, "app.js"), "const v = 2 // uncommitted\n")
    writeFileSync(join(cwd, "new.js"), "export const fresh = 42\n")

    // 变体：宽匹配覆盖 → stash 快照 → 放行
    const r = await bashTool.execute({ command: "git checkout HEAD -- ." }, { cwd })
    assert.match(r, /\[auto-protection\]/, "变体命令触发自动快照: " + r.slice(0, 120))
    assert.equal(readFileSync(join(cwd, "app.js"), "utf8").replace(/\r\n/g, "\n"), "const v = 1\n", "tracked 修改被回滚抹掉")

    // 从 stash 恢复未提交工作（untracked 经 stash 有 CRLF 转换，比较时归一化）
    execSync("git stash apply", { cwd, encoding: "utf8" })
    assert.equal(readFileSync(join(cwd, "app.js"), "utf8").replace(/\r\n/g, "\n"), "const v = 2 // uncommitted\n", "stash 恢复 tracked 修改")
    assert.equal(readFileSync(join(cwd, "new.js"), "utf8").replace(/\r\n/g, "\n"), "export const fresh = 42\n", "stash 恢复 untracked 新文件")
  })

  it("non-destructive git commands are untouched; non-repo is silent", async () => {
    const { bashTool } = await import("../src/tools/shell.mjs")
    const { execSync } = await import("node:child_process")
    execSync("git init -q", { cwd })
    execSync("git config user.email t@t && git config user.name t", { cwd })
    writeFileSync(join(cwd, "app.js"), "const v = 1\n")
    execSync("git add app.js && git commit -qm init", { cwd })

    // 注意：不用 git checkout --help 验证——git 的 --help 会打开系统浏览器（Windows），测试不得触发
    for (const cmd of ["git status", "git log --oneline", "git checkout -b tmp-branch", "git branch"]) {
      const r = await bashTool.execute({ command: cmd }, { cwd })
      assert.ok(!r.includes("[auto-protection]"), `${cmd} 不应触发保护`)
    }
    // 非 git 仓库：无快照、不拦截（git 自己的 stderr 返回给模型）
    const plain = mkdtempSync(join(tmpdir(), "thincoder-vscode-shell-plain-"))
    const r4 = await bashTool.execute({ command: "git restore ." }, { cwd: plain })
    assert.ok(!r4.includes("[auto-protection]"), "非 git 仓库保护静默")
    rmSync(plain, { recursive: true, force: true })
  })
})

describe("bash — background process does not hang (CLI parity)", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("returns after grace when a background child holds the output pipe", async () => {
    const { bashTool } = await import("../src/tools/shell.mjs")
    // 独立目录：后台子进程 cwd 占用，不能动共享 cwd（describe 级 cleanup）
    const bgDir = mkdtempSync(join(tmpdir(), "thincoder-vscode-bg-"))
    try {
      const cmd = process.platform === "win32"
        ? 'start /b node -e "setTimeout(() => process.exit(0), 5000)"'
        : 'node -e "setTimeout(() => process.exit(0), 5000)" &'
      const t0 = Date.now()
      const r = await bashTool.execute({ command: cmd }, { cwd: bgDir })
      const elapsed = Date.now() - t0
      assert.ok(elapsed < 10000, `应在 grace 后返回而非卡到超时，实际 ${elapsed}ms`)
      assert.match(r, /\[background\]/, "提示后台进程持有管道: " + r.slice(0, 120))
    } finally {
      // 后台子进程 cwd 是 bgDir，5 秒自退后才可删除——轮询等待
      for (let i = 0; i < 20; i++) {
        try { rmSync(bgDir, { recursive: true, force: true }); break } catch { await new Promise((r) => setTimeout(r, 500)) }
      }
    }
  })

  it("normal commands still return full output (callback wins the race)", async () => {
    const { bashTool } = await import("../src/tools/shell.mjs")
    const r = await bashTool.execute({ command: "echo hello-from-vscode" }, { cwd })
    assert.ok(r.includes("hello-from-vscode"), "正常命令输出完整: " + r)
    assert.ok(!r.includes("(background)"), "正常命令不触发 background 提示")
  })

  it("bash output does NOT go to the side panel (it belongs in the conversation tool card)", async () => {
    const { bashTool } = await import("../src/tools/shell.mjs")
    let panelCalled = false
    const r = await bashTool.execute({ command: "echo side-panel-check" }, {
      cwd,
      callbacks: { onToolPanel: () => { panelCalled = true } },
    })
    assert.equal(panelCalled, false, "bash must not push output to the side tool panel")
    assert.match(r, /side-panel-check/, "output still returned for the in-conversation tool card")
  })
})

describe("read_image — svg as text source (Kimi 400 session-poisoning regression)", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("svg returns plain-text source (no image_url, JSON envelope absent)", async () => {
    const { readImageTool } = await import("../src/tools/read_image.mjs")
    writeFileSync(join(cwd, "a.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')
    const out = await readImageTool.execute({ path: "a.svg" }, ctx())
    assert.match(out, /svg source/)
    assert.match(out, /<rect/)
    assert.throws(() => JSON.parse(out), "plain text, not the multimodal JSON envelope")
  })

  it("bmp is rejected with a convert-to-PNG hint", async () => {
    const { readImageTool } = await import("../src/tools/read_image.mjs")
    writeFileSync(join(cwd, "a.bmp"), Buffer.from([66, 77]))
    await assert.rejects(() => readImageTool.execute({ path: "a.bmp" }, ctx()), /Convert it to PNG/)
  })
})
describe("read_image — description lists multimodal model keywords (content assertion)", () => {
  it("mentions every declared vision-capable model keyword (array-driven)", async () => {
    const { readImageTool } = await import("../src/tools/read_image.mjs")
    // 多模态模型清单：未来加新模型时在数组加一项即可；若 description 漏掉数组中任一
    // 模型，此测试必须失败（防手工同步清单滞后）。关键字按 description 实际措辞探测。
    // 2026-08-28：修复 vscode description（Qwen3.7→Qwen3.8 精确化 + 补 GLM-5.3-Flash，
    // 与 CLI read_image.md:8 对齐）后，本数组即两端完整清单 —— 已同步。
    const visionModels = ["Kimi K3", "Qwen3.8", "MiniMax M3", "GLM-5.3-Flash"]
    for (const model of visionModels) {
      assert.ok(
        readImageTool.description.includes(model),
        `read_image description 必须提到 "${model}"（多模态模型清单漏项）— 实际: ${readImageTool.description}`,
      )
    }
  })
})

  describe("edit — EOL normalization (CRLF files, LF old_string)", () => {
  beforeEach(setup)
  afterEach(cleanup)

it("edit on a CRLF file with LF old_string succeeds (EOL normalization regression)", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    const f = join(cwd, "crlf.txt")
    writeFileSync(f, "alpha\r\nbeta\r\ngamma\r\n")
    // Model writes LF — before the fix this failed with "old_string not found"
    const r = await editTool.execute({ path: "crlf.txt", old_string: "beta\ngamma", new_string: "BETA\nGAMMA" }, ctx())
    assert.match(r, /Replaced 1 occurrence/)
    const out = readFileSync(f, "utf8")
    assert.ok(out.includes("BETA\r\nGAMMA"), "replacement applied with the file's CRLF style preserved: " + JSON.stringify(out))
    assert.ok(!out.includes("alpha\n"), "no whole-file EOL rewrite")
  })

  it("a genuinely absent old_string still reports not found", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    const f = join(cwd, "lf.txt")
    writeFileSync(f, "one\ntwo\n")
    const r = await editTool.execute({ path: "lf.txt", old_string: "not-there-at-all", new_string: "x" }, ctx())
    assert.match(r, /old_string not found/)
  })
})


describe("context — on-demand IDE state snapshot", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("is registered in the builtin registry", async () => {
    const { builtinTools } = await import("../src/tools/index.mjs")
    const names = builtinTools.map((t) => t.name)
    assert.ok(names.includes("context"))
  })

  it("changes slice reports uncommitted files (real repo)", async () => {
    const { contextTool } = await import("../src/tools/context.mjs")
    const { execSync } = await import("node:child_process")
    execSync("git init -q", { cwd })
    execSync('git config user.email t@t && git config user.name t', { cwd })
    writeFileSync(join(cwd, "a.txt"), "x\n")
    execSync("git add a.txt && git commit -qm init", { cwd })
    writeFileSync(join(cwd, "a.txt"), "y\n")
    const r = await contextTool.execute({ what: "changes" }, ctx())
    assert.match(r, /a\.txt/, "modified file listed: " + r)
  })

  it("empty IDE returns a no-context message without crashing", async () => {
    const { contextTool } = await import("../src/tools/context.mjs")
    const r = await contextTool.execute({}, ctx())
    assert.match(r, /no active editor/, "result: " + r)
  })
})


describe("focus — agent-driven cursor/editor navigation", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("is registered in the builtin registry", async () => {
    const { builtinTools } = await import("../src/tools/index.mjs")
    assert.ok(builtinTools.map((t) => t.name).includes("focus"))
  })

  it("opens an existing file and reports the focused position", async () => {
    const { focusTool } = await import("../src/tools/focus.mjs")
    writeFileSync(join(cwd, "f.txt"), "one\ntwo\nthree\n")
    const r = await focusTool.execute({ uri: "f.txt", line: 2, character: 1 }, ctx())
    assert.match(r, /Opened and focused/)
    assert.match(r, /L2:1/)
  })

  it("reports missing files", async () => {
    const { focusTool } = await import("../src/tools/focus.mjs")
    const r = await focusTool.execute({ uri: "nope.txt" }, ctx())
    assert.match(r, /file not found/)
  })
})

describe("ops tools — file_ops / process / get_current_time", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("file_ops moves / copies / renames", async () => {
    const { fileOpsTool } = await import("../src/tools/ops.mjs")
    writeFileSync(join(cwd, "a.txt"), "hello")
    assert.match(await fileOpsTool.execute({ action: "copy", source: "a.txt", dest: "b.txt" }, ctx()), /Copied/)
    assert.equal(readFileSync(join(cwd, "b.txt"), "utf8"), "hello")
    assert.match(await fileOpsTool.execute({ action: "move", source: "b.txt", dest: "c.txt" }, ctx()), /Moved/)
    assert.equal(existsSync(join(cwd, "b.txt")), false)
    assert.match(await fileOpsTool.execute({ action: "rename", source: "c.txt", dest: "d.txt" }, ctx()), /Renamed/)
    assert.match(await fileOpsTool.execute({ action: "nuke", source: "a.txt", dest: "x.txt" }, ctx()), /action must be/)
  })

  it("get_current_time returns the current date/time", async () => {
    const { getCurrentTimeTool } = await import("../src/tools/ops.mjs")
    const now = await getCurrentTimeTool.execute({}, {})
    assert.match(now, /Date:/)
  })

  it("process lists running processes with PID rows", async () => {
    const { processTool } = await import("../src/tools/ops.mjs")
    const procs = await processTool.execute({ name: "node" }, ctx())
    assert.match(procs, /PID/, "process listing returns PID rows")
  })

  it("sleep is not registered as a builtin tool", async () => {
    const { builtinTools } = await import("../src/tools/index.mjs")
    assert.ok(!builtinTools.map((t) => t.name).includes("sleep"))
  })

  it("ls filter", async () => {
    const { lsTool } = await import("../src/tools/more-file.mjs")
    writeFileSync(join(cwd, "a.js"), "x")
    writeFileSync(join(cwd, "b.txt"), "nothing")

    const ls = await lsTool.execute({ filter: "*.js", path: "." }, ctx())
    assert.match(ls, /a\.js/, "ls filter keeps matching entry")
    assert.doesNotMatch(ls, /b\.txt/, "ls filter excludes non-matching entry")
  })

  it("apply_patch: multiple hunks stay aligned after line-count drift", async () => {
    const { parsePatch, applyHunks } = await import("../src/tools/more-file.mjs")
    // hunk 1 inserts a line (shifts downstream), so hunk 2's @@ line number is stale
    const patch = `--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,4 @@
 one
+oneAndHalf
 two
 three
@@ -5,3 +5,3 @@
 five
-six
+sixX
 seven
`
    const files = parsePatch(patch)
    assert.equal(files.length, 1)
    const lines = ["one", "two", "three", "four", "five", "six", "seven"].slice()
    applyHunks(lines, files[0].hunks, "\n", "f.txt")
    assert.deepStrictEqual(lines, ["one", "oneAndHalf", "two", "three", "four", "five", "sixX", "seven"])
  })

  it("tree: depth-limited directory tree", async () => {
    const { treeTool } = await import("../src/tools/tree.mjs")
    mkdirSync(join(cwd, "src/nested/deep"), { recursive: true })
    writeFileSync(join(cwd, "src/a.js"), "x")
    writeFileSync(join(cwd, "root.txt"), "x")
    const out = await treeTool.execute({ depth: 2 }, ctx())
    assert.match(out, /src\//, "lists directory with trailing slash")
    assert.match(out, /root\.txt/)
    assert.doesNotMatch(out, /deep/, "depth limit excludes deeper levels")
  })
})


describe("edit tools — EOL semantics + candidates + encoding probe (EDIT-TOOL-EOL, CLI parity)", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("F1: edit on pure CRLF file writes back all CRLF, no bare LF", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    const f = join(cwd, "f.txt")
    writeFileSync(f, "a\r\nb\r\nc\r\n")
    const r = await editTool.execute({ path: "f.txt", old_string: "b", new_string: "B" }, ctx())
    assert.match(r, /Replaced 1 occurrence/)
    const out = readFileSync(f, "utf8")
    assert.equal(out, "a\r\nB\r\nc\r\n")
    assert.ok(!/(?<!\r)\n/.test(out), "no bare LF")
  })

  it("F1 regression: edit on LF file keeps LF", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    const f = join(cwd, "f.txt")
    writeFileSync(f, "a\nb\n")
    await editTool.execute({ path: "f.txt", old_string: "b", new_string: "B" }, ctx())
    assert.equal(readFileSync(f, "utf8"), "a\nB\n")
  })

  it("F1: apply_patch on CRLF file writes back all CRLF", async () => {
    const { applyPatchTool } = await import("../src/tools/more-file.mjs")
    const f = join(cwd, "f.txt")
    writeFileSync(f, "one\r\ntwo\r\nthree\r\n")
    const patch = `--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`
    const r = await applyPatchTool.execute({ patch }, ctx())
    assert.match(r, /Patched f\.txt/)
    assert.equal(readFileSync(f, "utf8"), "one\r\nTWO\r\nthree\r\n")
  })

  it("F1: hashline_edit on CRLF file writes back all CRLF", async () => {
    const { hashlineEditTool } = await import("../src/tools/file.mjs")
    const { hashLine } = await import("../src/tools/shared.mjs")
    const f = join(cwd, "f.txt")
    writeFileSync(f, "x\r\ny\r\nz\r\n")
    const r = await hashlineEditTool.execute({ path: "f.txt", old_hashes: [hashLine("y")], new_content: "Y" }, ctx())
    assert.match(r, /replaced 1 line\(s\)/)
    assert.equal(readFileSync(f, "utf8"), "x\r\nY\r\nz\r\n")
  })

  it("F2: new file in CRLF-majority directory follows CRLF (write + apply_patch)", async () => {
    const { writeTool } = await import("../src/tools/file.mjs")
    const { applyPatchTool } = await import("../src/tools/more-file.mjs")
    writeFileSync(join(cwd, "existing.txt"), "e1\r\ne2\r\n")
    await writeTool.execute({ path: "w.txt", content: "l1\nl2\n" }, ctx())
    assert.equal(readFileSync(join(cwd, "w.txt"), "utf8"), "l1\r\nl2\r\n")
    const patch = `--- /dev/null
+++ b/p.txt
@@ -0,0 +1,2 @@
+n1
+n2
`
    const r = await applyPatchTool.execute({ patch }, ctx())
    assert.match(r, /Patched p\.txt/)
    assert.equal(readFileSync(join(cwd, "p.txt"), "utf8"), "n1\r\nn2\r\n")
  })

  it("F2: new file in LF-majority / empty directory stays LF", async () => {
    const { writeTool } = await import("../src/tools/file.mjs")
    writeFileSync(join(cwd, "existing.txt"), "e1\ne2\n")
    await writeTool.execute({ path: "w.txt", content: "l1\nl2\n" }, ctx())
    assert.equal(readFileSync(join(cwd, "w.txt"), "utf8"), "l1\nl2\n")
    mkdirSync(join(cwd, "empty"))
    await writeTool.execute({ path: "empty/f.txt", content: "x\ny\n" }, ctx())
    assert.equal(readFileSync(join(cwd, "empty", "f.txt"), "utf8"), "x\ny\n")
  })

  it("F2/F1: write overwriting an existing CRLF file restores CRLF", async () => {
    const { writeTool } = await import("../src/tools/file.mjs")
    const f = join(cwd, "f.txt")
    writeFileSync(f, "old1\r\nold2\r\n")
    await writeTool.execute({ path: "f.txt", content: "new1\nnew2\n" }, ctx())
    assert.equal(readFileSync(f, "utf8"), "new1\r\nnew2\r\n")
  })

  it("boundary: mixed-EOL file (first line LF, later CRLF) restores by first-line LF", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    const f = join(cwd, "f.txt")
    writeFileSync(f, "first\nsecond\r\nthird\r\n")
    await editTool.execute({ path: "f.txt", old_string: "first", new_string: "FIRST" }, ctx())
    // First-newline rule: whole file written back in the first line's style (LF).
    assert.equal(readFileSync(f, "utf8"), "FIRST\nsecond\nthird\n")
  })

  it("F3: failed edit lists similar lines (line number + preview + score)", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    writeFileSync(join(cwd, "f.mjs"), "const timeout = 5000\nfunction start() {\n}\n")
    const r = await editTool.execute({ path: "f.mjs", old_string: "const timeout = 6000", new_string: "x" }, ctx())
    assert.match(r, /old_string not found/)
    assert.match(r, /similar lines/)
    assert.match(r, /L1: const timeout = 5000 \(\d+%\)/)
  })

  it("F3: no candidates when every line is below the 0.5 threshold (noise guard)", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    writeFileSync(join(cwd, "f.txt"), "alpha\nbeta\ngamma\n")
    const r = await editTool.execute({ path: "f.txt", old_string: "xyzzy plugh xyzzard", new_string: "x" }, ctx())
    assert.match(r, /old_string not found/)
    assert.ok(!r.includes("similar lines"), "no candidate block below threshold: " + r)
  })

  it("F3 boundary: multi-line old_string failure scores only line 1, capped at top 3", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    const body = ["wrong first line a", "wrong first line b", "wrong first line c", "wrong first line d", "wrong first line e"].join("\n") + "\n"
    writeFileSync(join(cwd, "f.txt"), body)
    const r = await editTool.execute({
      path: "f.txt",
      old_string: "wrong first line X\nsecond line content\nthird line content",
      new_string: "x",
    }, ctx())
    assert.match(r, /old_string line 1:/)
    const candRows = r.match(/^ {4}L\d+: /gm) || []
    assert.equal(candRows.length, 3, "top 3 cap: " + r)
  })

  it("F4: hashline_edit on file containing U+FFFD warns but still executes", async () => {
    const { hashlineEditTool } = await import("../src/tools/file.mjs")
    const { hashLine } = await import("../src/tools/shared.mjs")
    const f = join(cwd, "f.txt")
    writeFileSync(f, "good line\nbad \uFFFD line\n")
    const r = await hashlineEditTool.execute({ path: "f.txt", old_hashes: [hashLine("good line")], new_content: "replaced line" }, ctx())
    assert.match(r, /replaced 1 line\(s\)/)
    assert.match(r, /U\+FFFD/)
    assert.match(r, /encoding may be corrupted/)
    assert.equal(readFileSync(f, "utf8"), "replaced line\nbad \uFFFD line\n")
  })

  it("F4 regression: clean UTF-8 file produces no warning", async () => {
    const { hashlineEditTool } = await import("../src/tools/file.mjs")
    const { hashLine } = await import("../src/tools/shared.mjs")
    writeFileSync(join(cwd, "f.txt"), "clean\n")
    const r = await hashlineEditTool.execute({ path: "f.txt", old_hashes: [hashLine("clean")], new_content: "done" }, ctx())
    assert.ok(!r.includes("U+FFFD"), "no warning on clean file: " + r)
  })

  it("detectFileEol / joinWithEol / majorityEol / findCandidates — first-newline rule + majority + ranking", async () => {
    const { detectFileEol, joinWithEol, majorityEol, findCandidates } = await import("../src/tools/shared.mjs")
    assert.equal(detectFileEol("a\r\nb\n"), "\r\n")
    assert.equal(detectFileEol("a\nb\r\n"), "\n")
    assert.equal(detectFileEol("no newline"), "\n")
    assert.equal(detectFileEol(""), "\n")
    assert.equal(joinWithEol(["a", "b"], "x\r\ny"), "a\r\nb")
    assert.equal(majorityEol(cwd), "\n") // empty dir → LF
    writeFileSync(join(cwd, "a.txt"), "x\r\n")
    writeFileSync(join(cwd, "b.txt"), "y\r\n")
    writeFileSync(join(cwd, "c.txt"), "z\n")
    assert.equal(majorityEol(cwd), "\r\n")
    const cands = findCandidates(["const timeout = 5000", "unrelated"], "const timeout = 6000")
    assert.equal(cands.length, 1)
    assert.equal(cands[0].line, 1)
    assert.ok(cands[0].score >= 0.5)
    assert.equal(findCandidates(["short"], "a much longer needle that shares nothing").length, 0)
  })
})
