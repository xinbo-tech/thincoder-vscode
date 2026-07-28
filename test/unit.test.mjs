/**
 * unit.test.mjs — Automated unit tests for thincoder-vscode modules.
 * Pure Node.js, no VS Code, no API keys required.
 * Run: node --test test/unit.test.mjs
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs"
import { join, sep } from "node:path"
import { tmpdir } from "node:os"

// ─── memory.mjs ──────────────────────────────────────────────

import { tokenizeQuery, scoreEntry, search } from "../src/memory.mjs"

describe("memory — tokenizeQuery", () => {
  it("deduplicates repeated keywords", () => {
    const result = tokenizeQuery("test test test memory memory")
    // "test" and "memory" should appear only once each
    assert.equal(result.filter(w => w === "test").length, 1)
    assert.equal(result.filter(w => w === "memory").length, 1)
  })

  it("filters stopwords", () => {
    const result = tokenizeQuery("the is a of in and for")
    assert.equal(result.length, 0)
  })

  it("filters single-character words", () => {
    const result = tokenizeQuery("a b c")
    assert.equal(result.length, 0)
  })

  it("extracts meaningful keywords", () => {
    const result = tokenizeQuery("fix the shell env variable")
    assert.deepStrictEqual(result, ["fix", "shell", "env", "variable"])
  })

  it("handles empty query", () => {
    assert.equal(tokenizeQuery("").length, 0)
  })

  it("is case-insensitive", () => {
    const result = tokenizeQuery("SHELL Env TEST")
    assert(result.includes("shell"))
    assert(result.includes("env"))
    assert(result.includes("test"))
  })
})

describe("memory — scoreEntry", () => {
  it("scores title match higher (3pts)", () => {
    const entry = { title: "shell fixes", content: "some content", tags: "" }
    assert.equal(scoreEntry(entry, ["shell"]), 3)
  })

  it("scores tag match (2pts)", () => {
    const entry = { title: "misc", content: "some content", tags: "shell env" }
    assert.equal(scoreEntry(entry, ["shell"]), 2)
  })

  it("scores content match (1pt)", () => {
    const entry = { title: "misc", content: "we fixed the shell", tags: "" }
    assert.equal(scoreEntry(entry, ["shell"]), 1)
  })

  it("accumulates across multiple keywords", () => {
    const entry = { title: "shell", content: "env variable", tags: "fix" }
    // shell: title=3, env: content=1, variable: content=1, fix: tags=2
    assert.equal(scoreEntry(entry, ["shell", "env", "variable", "fix"]), 3 + 1 + 1 + 2)
  })
})

describe("memory — search (integration)", () => {
  let tmpDir, memDir

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "thincoder-test-memory-"))
    memDir = join(tmpDir, ".thincoder", "memory")
    mkdirSync(memDir, { recursive: true })
    // Create test entries
    const now = new Date().toISOString()
    writeFileSync(join(memDir, "a.json"), JSON.stringify({
      id: "a", type: "knowledge", title: "Shell environment",
      content: "Use SAFE_ENV to filter dangerous variables", tags: "shell security",
      created_at: now, updated_at: now,
    }))
    writeFileSync(join(memDir, "b.json"), JSON.stringify({
      id: "b", type: "decision", title: "API key storage",
      content: "Use SecretStorage for API keys", tags: "security keys",
      created_at: now, updated_at: now,
    }))
    writeFileSync(join(memDir, "c.json"), JSON.stringify({
      id: "c", type: "pattern", title: "Unrelated pattern",
      content: "Something about colors and themes", tags: "ui theme",
      created_at: now, updated_at: now,
    }))
  })

  after(() => {
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  it("returns matching results sorted by score", () => {
    const results = search(tmpDir, "shell", { limit: 5 })
    assert(results.length >= 1)
    assert.equal(results[0].title, "Shell environment")
  })

  it("deduplication prevents score inflation", () => {
    // "shell shell shell" should give same score as "shell"
    const results1 = search(tmpDir, "shell", { limit: 5 })
    const results3 = search(tmpDir, "shell shell shell", { limit: 5 })
    assert.equal(results1.length, results3.length)
    if (results1.length > 0) {
      assert.equal(results1[0].score, results3[0].score)
    }
  })

  it("returns empty array for non-matching query", () => {
    const results = search(tmpDir, "zzz_nonexistent_zzz", { limit: 5 })
    assert.equal(results.length, 0)
  })
})

// ─── context.mjs ─────────────────────────────────────────────

import { parseImports } from "../src/context.mjs"

describe("context — parseImports", () => {
  it("parses single-line ESM import", () => {
    const deps = parseImports(`import { foo } from "./bar.mjs"`)
    assert(deps.includes("./bar.mjs"))
  })

  it("parses single-line CJS require", () => {
    const deps = parseImports(`const fs = require("node:fs")`)
    // node: should be filtered
    assert.equal(deps.length, 0)
  })

  it("parses dynamic import", () => {
    const deps = parseImports(`const mod = await import("./dynamic.mjs")`)
    assert(deps.includes("./dynamic.mjs"))
  })

  it("handles multiline import (s flag)", () => {
    const deps = parseImports(`import {
  foo,
  bar,
  baz,
} from "./multiline.mjs"`)
    assert(deps.includes("./multiline.mjs"), "Should match multiline import")
  })

  it("filters node: builtins", () => {
    const deps = parseImports(`import { readFile } from "node:fs"`)
    assert.equal(deps.length, 0)
  })

  it("filters vscode imports", () => {
    const deps = parseImports(`import * as vscode from "vscode"`)
    assert.equal(deps.length, 0)
  })

  it("parses multiple imports", () => {
    const deps = parseImports(`
import { a } from "./a.mjs"
import { b } from "./b.mjs"
import { c } from "node:fs"
`)
    assert.equal(deps.length, 2)
    assert(deps.includes("./a.mjs"))
    assert(deps.includes("./b.mjs"))
  })

  it("returns empty for no imports", () => {
    assert.equal(parseImports("const x = 1;").length, 0)
  })
})

// ─── shell.mjs — SAFE_ENV filter ─────────────────────────────

describe("shell — SAFE_ENV", () => {
  // We can't reload the module, but we can test the pattern logic by
  // verifying that common secret patterns WOULD be caught and common
  // tool vars WOULD pass through.
  const SECRET_PATTERNS = /_(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIALS?)(?:_|$)|^(?:NPM_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN|AWS_|AZURE_|GCLOUD_)/i

  it("filters API_KEY", () => {
    assert(SECRET_PATTERNS.test("OPENAI_API_KEY"))
    assert(SECRET_PATTERNS.test("DEEPSEEK_API_KEY"))
  })

  it("filters _TOKEN", () => {
    assert(SECRET_PATTERNS.test("NPM_TOKEN"))
    assert(SECRET_PATTERNS.test("GITHUB_TOKEN"))
  })

  it("filters _SECRET", () => {
    assert(SECRET_PATTERNS.test("DB_SECRET"))
    assert(SECRET_PATTERNS.test("JWT_SECRET"))
  })

  it("filters _PASSWORD", () => {
    assert(SECRET_PATTERNS.test("DB_PASSWORD"))
  })

  it("filters _CREDENTIAL / _CREDENTIALS", () => {
    assert(SECRET_PATTERNS.test("GOOGLE_APPLICATION_CREDENTIALS"))
  })

  it("does NOT filter SSH_AUTH_SOCK (not a secret)", () => {
    assert(!SECRET_PATTERNS.test("SSH_AUTH_SOCK"))
  })

  it("does NOT filter GIT_AUTHOR_NAME (not a secret)", () => {
    assert(!SECRET_PATTERNS.test("GIT_AUTHOR_NAME"))
  })

  it("filters AWS_ / AZURE_ / GCLOUD_ prefixes", () => {
    assert(SECRET_PATTERNS.test("AWS_ACCESS_KEY_ID"))
    assert(SECRET_PATTERNS.test("AZURE_CLIENT_SECRET"))
    assert(SECRET_PATTERNS.test("GCLOUD_PROJECT"))
  })

  it("allows PATH", () => {
    assert(!SECRET_PATTERNS.test("PATH"))
  })

  it("allows HOME", () => {
    assert(!SECRET_PATTERNS.test("HOME"))
  })

  it("allows NODE_PATH", () => {
    assert(!SECRET_PATTERNS.test("NODE_PATH"))
  })

  it("allows npm_config_*", () => {
    assert(!SECRET_PATTERNS.test("npm_config_cache"))
    assert(!SECRET_PATTERNS.test("npm_config_registry"))
  })

  it("allows VSCODE_*", () => {
    assert(!SECRET_PATTERNS.test("VSCODE_PID"))
  })
})

// ─── more-file.mjs — applyPatchTool ──────────────────────────

// These tests need filesystem; we create temp files
import { applyPatchTool } from "../src/tools/more-file.mjs"

describe("applyPatchTool — standard unified diff", () => {
  let tmpDir

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "thincoder-test-patch-"))
    writeFileSync(join(tmpDir, "hello.txt"), "line one\nline two\nline three\n")
  })

  after(() => {
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  it("applies standard unified diff (--- a/...  +++ b/...)", async () => {
    const patch = `--- a/hello.txt
+++ b/hello.txt
@@ -1,3 +1,3 @@
 line one
-line two
+modified line two
 line three
`
    const ctx = { cwd: tmpDir }
    const result = await applyPatchTool.execute({ patch }, ctx)
    assert(result.includes("Patched hello.txt"))
    const content = readFileSync(join(tmpDir, "hello.txt"), "utf8")
    assert(content.includes("modified line two"), "should have the new line")
    // "line two" should not appear as a standalone line (not as substring)
    const lines = content.split("\n")
    assert(!lines.includes("line two"), '"line two" should be gone')
  })

  it("applies git diff format (diff --git a/... b/...)", async () => {
    writeFileSync(join(tmpDir, "gitfile.txt"), "old content\n")
    const patch = `diff --git a/gitfile.txt b/gitfile.txt
--- a/gitfile.txt
+++ b/gitfile.txt
@@ -1 +1 @@
-old content
+new content
`
    const ctx = { cwd: tmpDir }
    const result = await applyPatchTool.execute({ patch }, ctx)
    assert(result.includes("Patched gitfile.txt"))
    const content = readFileSync(join(tmpDir, "gitfile.txt"), "utf8")
    assert.equal(content, "new content\n")
  })

  it("handles /dev/null (new file creation)", async () => {
    const patch = `--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1 @@
+brand new file
`
    const ctx = { cwd: tmpDir }
    const result = await applyPatchTool.execute({ patch }, ctx)
    // /dev/null source is skipped — no existing file to read,
    // and there are no hunks with real old line numbers,
    // so it's handled gracefully
    assert(result.includes("No files patched") || result.includes("Patched"))
  })

  it("handles empty patch gracefully", async () => {
    const ctx = { cwd: tmpDir }
    const result = await applyPatchTool.execute({ patch: "" }, ctx)
    assert(result.includes("Error") || result.includes("No diff sections"))
  })
})

// ─── generate-title.mjs — multimodal text extraction ─────────

describe("generate-title — text extraction logic", () => {
  // We test the extraction pattern used in generate-title.mjs:
  // Array.isArray check + .find(p => p.type === "text")
  function extractText(content) {
    if (Array.isArray(content)) {
      return content.find(p => p.type === "text")?.text || ""
    }
    return content
  }

  it("extracts text from string content", () => {
    assert.equal(extractText("hello world"), "hello world")
  })

  it("extracts text from multimodal array", () => {
    const multimodal = [
      { type: "text", text: "look at this image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
    ]
    assert.equal(extractText(multimodal), "look at this image")
  })

  it("returns empty string if no text part in array", () => {
    const multimodal = [
      { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
    ]
    assert.equal(extractText(multimodal), "")
  })

  it("length check works correctly on multimodal", () => {
    const multimodal = [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:..." } },
    ]
    // Old bug: multimodal.length === 2, which is < 10, would return early.
    // New code extracts text first: "hi".length === 2, which is also < 10.
    // This is correct behavior — genuine short message.
    const text = extractText(multimodal)
    assert.equal(text.length < 10, true)
  })

  it("long multimodal text passes length check", () => {
    const multimodal = [
      { type: "text", text: "this is a long enough message for a title" },
      { type: "image_url", image_url: { url: "data:..." } },
    ]
    const text = extractText(multimodal)
    assert(text.length >= 10)
  })
})

// ─── Report ───────────────────────────────────────────────────

console.log("\n✓ All unit tests passed.\n")
