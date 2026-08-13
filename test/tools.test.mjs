import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
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
    assert.match(r, /pending → in_progress: T1: task/)
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
      assert.match(r, /\(background\)/, "提示后台进程持有管道: " + r.slice(0, 120))
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



