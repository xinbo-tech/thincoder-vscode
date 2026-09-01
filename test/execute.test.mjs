/**
 * execute.test.mjs — JS execution tool tests (VS Code port).
 * Run: node --test test/execute.test.mjs
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { executeTool } from "../src/tools/execute.mjs"

let tmpDir
const ctx = () => ({ cwd: tmpDir })

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "thincoder-exec-"))
  mkdirSync(join(tmpDir, "sub"), { recursive: true })
  writeFileSync(join(tmpDir, "a.txt"), "line one\nline two\nline three\n")
  writeFileSync(join(tmpDir, "sub", "b.js"), "export const x = 1\n")
})

after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

async function run(code, extra = {}) {
  return executeTool.execute({ code, ...extra }, ctx())
}

describe("execute — sandbox API", () => {
  it("runs simple code and returns logged output", async () => {
    const out = await run('log("hello", 1 + 1)')
    assert.equal(out, "hello 2")
  })

  it("returns (no output) when nothing is logged", async () => {
    const out = await run("const x = 1")
    assert.equal(out, "(no output)")
  })

  it("readFile reads relative to cwd", async () => {
    const out = await run('log(readFile("a.txt").split("\\n").length)')
    assert.equal(out, "4") // 3 lines + trailing empty
  })

  it("readFile normalizes line endings", async () => {
    writeFileSync(join(tmpDir, "crlf.txt"), "a\r\nb\r\n")
    const out = await run('const t = readFile("crlf.txt"); log(t.includes("\\r") ? "crlf" : "lf")')
    assert.equal(out, "lf")
  })

  it("writeFile creates parent dirs and writes", async () => {
    await run('writeFile("deep/nested/out.txt", "written")')
    assert.equal(readFileSync(join(tmpDir, "deep", "nested", "out.txt"), "utf8"), "written")
  })

  it("glob matches patterns recursively", async () => {
    const out = await run('log(glob("**/*.js").join(","))')
    assert(out.includes("sub/b.js"))
  })

  it("glob skips dot dirs and node_modules", async () => {
    mkdirSync(join(tmpDir, ".hidden"), { recursive: true })
    writeFileSync(join(tmpDir, ".hidden", "x.txt"), "x")
    mkdirSync(join(tmpDir, "node_modules", "pkg"), { recursive: true })
    writeFileSync(join(tmpDir, "node_modules", "pkg", "y.txt"), "y")
    const out = await run('log(glob("**/*.txt").join("\\n"))')
    assert(!out.includes(".hidden"))
    assert(!out.includes("node_modules"))
  })

  it("grep returns line-numbered matches", async () => {
    const out = await run('log(grep("line t", "a.txt").join("\\n"))')
    assert.equal(out, "2: line two\n3: line three")
  })

  it("composes multiple operations in one script", async () => {
    await run(`
      const files = glob("*.txt")
      let count = 0
      for (const f of files) count += readFile(f).split("\\n").length
      log("files", files.length, "lines", count)
    `)
    assert(existsSync(join(tmpDir, "a.txt")))
  })
})

describe("execute — full Node access (no fake sandbox)", () => {
  it("require() is available", async () => {
    const out = await run('const fs = require("node:fs"); log(typeof fs.readFileSync)')
    assert.equal(out, "function")
  })

  it("process is available", async () => {
    const out = await run('log(typeof process, typeof process.cwd)')
    assert.equal(out, "object function")
  })

  it("require resolves Node builtins", async () => {
    const out = await run('const p = require("node:path"); log(p.basename("/a/b.txt"))')
    assert.equal(out, "b.txt")
  })

  it("require resolves project modules relative to cwd", async () => {
    writeFileSync(join(tmpDir, "lib.js"), "module.exports = { answer: 42 }")
    const out = await run('const lib = require("./lib.js"); log(lib.answer)')
    assert.equal(out, "42")
  })

  it("denies path traversal above cwd", async () => {
    const out = await run('readFile("../escape.txt")')
    assert(out.includes("Path traversal denied"))
  })

  it("denies absolute paths outside cwd", async () => {
    const outside = join(tmpdir(), "does-not-matter.txt")
    const out = await run(`readFile(${JSON.stringify(outside)})`)
    assert(out.includes("Path traversal denied") || out.includes("File not found"))
  })

  it("rejects oversize scripts", async () => {
    const big = "// " + "x".repeat(60_000)
    const out = await run(big)
    assert(out.includes("script too large"))
  })
})

describe("execute — error handling and limits", () => {
  it("reports runtime errors with partial output", async () => {
    const out = await run('log("before"); throw new Error("boom")')
    assert(out.includes("before"))
    assert(out.includes("Error: boom"))
  })

  it("enforces timeout", async () => {
    const out = await run("while (true) {}", { timeoutMs: 200 })
    assert(out.includes("Error"))
  })

  it("caps timeoutMs at 60s", async () => {
    const out = await run('log("ok")', { timeoutMs: 999_999_999 })
    assert.equal(out, "ok")
  })

  it("missing file gives a clear error", async () => {
    const out = await run('readFile("nope.txt")')
    assert(out.includes("File not found"))
  })
})

describe("execute — async / import / console / workdir / filter", () => {
  before(() => {
    writeFileSync(join(tmpDir, "mod.mjs"), 'export const name = "mod"; export default 7\n')
  })

  it("supports top-level await + dynamic import() of project ESM", async () => {
    const out = await run('const m = await import("./mod.mjs"); log(m.name, m.default)')
    assert.equal(out, "mod 7")
  })

  it("console.log writes to output", async () => {
    const out = await run('console.log("c1", 2)')
    assert.equal(out, "c1 2")
  })

  it("throws sync errors and surfaces them via stderr", async () => {
    const out = await run('throw new Error("sync-boom")')
    assert(out.includes("Error: sync-boom"))
  })

  it("workdir runs in a subdirectory", async () => {
    const out = await run('log(readFile("b.js").trim())', { workdir: "sub" })
    assert.equal(out, "export const x = 1")
  })

  it("workdir outside the workspace resolves and runs (bash parity, TOOLS.md §10.1)", async () => {
    // Boundary assertion removed 2026-09-02: paths are resolved, not restricted.
    const out = await run('log("x")', { workdir: ".." })
    assert.equal(out, "x")
  })

  it("filter keeps only matching output lines", async () => {
    const out = await run('log("alpha")\nlog("beta")\nlog("gamma")', { filter: "beta" })
    assert.equal(out, "beta")
  })

  it("filter never swallows an error", async () => {
    const out = await run('throw new Error("boom")', { filter: "zzz-no-match" })
    assert(out.includes("Error: boom"))
  })

  it("non-numeric / zero timeoutMs falls back to default", async () => {
    assert.equal(await run('log("fast")', { timeoutMs: "abc" }), "fast")
    assert.equal(await run('log("fast2")', { timeoutMs: 0 }), "fast2")
  })
})

describe("execute — scriptFile (node <file> / nodeArgs)", () => {
  it("runs a workspace script file", async () => {
    writeFileSync(join(tmpDir, "hello.mjs"), 'console.log("hello from script")\n')
    assert.equal(await executeTool.execute({ scriptFile: "hello.mjs" }, ctx()), "hello from script")
  })

  it("nodeArgs(--check): good file silent, bad file SyntaxError", async () => {
    writeFileSync(join(tmpDir, "good.mjs"), "const x = 1\n")
    assert.equal(await executeTool.execute({ scriptFile: "good.mjs", nodeArgs: ["--check"] }, ctx()), "(no output)")
    writeFileSync(join(tmpDir, "bad.mjs"), "const x = \n")
    assert.match(await executeTool.execute({ scriptFile: "bad.mjs", nodeArgs: ["--check"] }, ctx()), /SyntaxError|Unexpected/)
  })

  it("scriptFile outside the workspace runs (bash parity — execute can run any script)", async () => {
    // Boundary rejection removed 2026-09-02 (TOOLS.md §10.1 T-e-3): bash can run
    // arbitrary scripts, so execute scriptFile resolves the path without restriction.
    writeFileSync(join(tmpdir(), "thincoder-outside-escape.mjs"), 'console.log("outside script ran")\n')
    try {
      assert.equal(await executeTool.execute({ scriptFile: "../thincoder-outside-escape.mjs" }, ctx()), "outside script ran")
    } finally {
      rmSync(join(tmpdir(), "thincoder-outside-escape.mjs"), { force: true })
    }
  })

  it("missing code+scriptFile errors; eval-like nodeArgs rejected", async () => {
    assert.match(await executeTool.execute({}, ctx()), /either code or scriptFile/)
    assert.match(await executeTool.execute({ scriptFile: "hello.mjs", nodeArgs: ["--eval", "1"] }, ctx()), /not allowed/)
  })
})
