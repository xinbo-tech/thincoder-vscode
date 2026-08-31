/**
 * edit-eol.test.mjs — CRLF byte-offset drift + same-family hazards (EDIT-TOOL-EOL F5).
 *
 * Regression for the 2026-08-28 editor-path bug: edit's non-replace_all branch
 * passed an LF-domain offset (`normalizeEOL` drops every `\r`) straight to
 * `doc.positionAt`, which expects raw CRLF offsets (`\r\n` = 2 chars). The
 * drift = newlines before the match, so the range edit landed on the wrong line
 * (粘连/截断/重复). The old mock doc had no `positionAt`, so the range branch was
 * never exercised — this file's mock reproduces the real host semantics.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as vscode from "vscode"

let tmp, cwd
const ctx = () => ({ cwd })

function setup() {
  tmp = mkdtempSync(join(tmpdir(), "thincoder-vscode-eol-test-"))
  cwd = tmp
}
function cleanup() { rmSync(tmp, { recursive: true, force: true }) }

/**
 * Faithful TextDocument mock: positionAt / lineAt / _applyEdit all operate on
 * the RAW buffer (CRLF preserved; `\r` counts as 1 char), matching the real host.
 * `getText()` never includes a BOM — the host manages it via file encoding.
 */
function makeDoc(text, fsPath = "d:\\proj\\file.mjs") {
  const doc = {
    uri: vscode.Uri.file(fsPath),
    isDirty: false,
    _text: text,
    get lineCount() { return this._text.split("\n").length },
    getText() { return this._text },
    positionAt(offset) {
      let line = 0, col = 0
      const n = Math.max(0, Math.min(offset, this._text.length))
      for (let i = 0; i < n; i++) {
        if (this._text[i] === "\n") { line++; col = 0 } else col++
      }
      return { line, character: col }
    },
    lineAt(lineNumber) {
      const line = this._text.split("\n")[lineNumber] ?? ""
      return { lineNumber, text: line.replace(/\r$/, "") }
    },
    _applyEdit(range, newText) {
      const start = rawOffsetAt(this._text, range.start.line, range.start.character)
      const end = rawOffsetAt(this._text, range.end.line, range.end.character)
      this._text = this._text.slice(0, start) + newText + this._text.slice(end)
    },
    async save() { this.isDirty = false; return true },
  }
  return doc
}

/** Raw-buffer offset of (line, character) — the inverse of positionAt. */
function rawOffsetAt(text, line, character) {
  let offset = 0
  for (let l = 0; l < line; l++) {
    const nl = text.indexOf("\n", offset)
    if (nl === -1) return text.length
    offset = nl + 1
  }
  return Math.min(text.length, offset + character)
}

/** Temporarily override process.platform (used by getOpenDoc's win32 branch). */
function forcePlatform(p) {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: p, configurable: true })
  return () => {
    if (desc) Object.defineProperty(process, "platform", desc)
    else delete process.platform
  }
}

beforeEach(() => {
  setup()
  vscode.workspace.textDocuments.length = 0
  vscode.workspace.applyEditCalls.length = 0
})
afterEach(cleanup)

describe("F5 — CRLF offset drift + same-family hazards (EDIT-TOOL-EOL)", () => {
  it("CRLF range edit: 60-line doc, editing line 55 touches only that line", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    const lines = Array.from({ length: 60 }, (_, i) => `line ${String(i + 1).padStart(2, "0")} content`)
    const raw = lines.join("\r\n") + "\r\n"
    const doc = makeDoc(raw, "d:\\proj\\crlf-range.txt")
    vscode.workspace.textDocuments.push(doc)

    const r = await editTool.execute({ path: "crlf-range.txt", old_string: "line 55 content", new_string: "line 55 CHANGED" }, { cwd: "d:\\proj" })
    assert.match(r, /Replaced 1 occurrence/)
    const out = doc.getText()
    assert.ok(out.includes("line 55 CHANGED\r\n"), "target line changed")
    assert.ok(!out.includes("line 55 content"), "original target gone")
    assert.ok(out.includes("line 54 content\r\n"), "line 54 intact")
    assert.ok(out.includes("line 56 content\r\n"), "line 56 intact")
    assert.equal((out.match(/\r\n/g) || []).length, 60, "CRLF count unchanged (no drift)")
  })

  it("replace_all on a CRLF doc stays pure CRLF (no LF flip)", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    const doc = makeDoc("x\r\nx\r\nx\r\n", "d:\\proj\\ra.txt")
    vscode.workspace.textDocuments.push(doc)

    const r = await editTool.execute({ path: "ra.txt", old_string: "x", new_string: "Y", replace_all: true }, { cwd: "d:\\proj" })
    assert.match(r, /Replaced 3 occurrence/)
    const out = doc.getText()
    assert.equal(out, "Y\r\nY\r\nY\r\n")
    assert.ok(!/(?<!\r)\n/.test(out), "no bare LF after replace_all")
  })

  it("mixed EOL: CRLF head + bare-LF island, both edits map correctly", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    const raw = "head1\r\nhead2\r\nislandA\nislandB\r\ntail\r\n"
    const doc = makeDoc(raw, "d:\\proj\\mixed.txt")
    vscode.workspace.textDocuments.push(doc)

    await editTool.execute({ path: "mixed.txt", old_string: "head2", new_string: "HEAD2" }, { cwd: "d:\\proj" })
    assert.equal(doc.getText(), "head1\r\nHEAD2\r\nislandA\nislandB\r\ntail\r\n")
    await editTool.execute({ path: "mixed.txt", old_string: "islandB", new_string: "ISLANDB" }, { cwd: "d:\\proj" })
    assert.equal(doc.getText(), "head1\r\nHEAD2\r\nislandA\nISLANDB\r\ntail\r\n")
  })

  it("lfOffsetToRaw treats \\r\\n as an atomic 2-char unit", async () => {
    const { lfOffsetToRaw } = await import("../src/tools/shared.mjs")
    assert.equal(lfOffsetToRaw("a\r\nb", 2), 3)
    assert.equal(lfOffsetToRaw("a\r\nb", 0), 0)
    assert.equal(lfOffsetToRaw("a\nb", 2), 2)
  })

  it("getOpenDoc matches fsPath case-insensitively on win32", async () => {
    const { getOpenDoc } = await import("../src/tools/shared.mjs")
    const doc = makeDoc("x", "d:\\proj\\Case.mjs")
    vscode.workspace.textDocuments.push(doc)
    const restore = forcePlatform("win32")
    try {
      assert.equal(getOpenDoc("D:\\PROJ\\case.MJS"), doc)
    } finally {
      restore()
    }
  })

  it("read(hashes=true) on a CRLF+BOM file hashes the first line without \\r/\\uFEFF", async () => {
    const { readTool } = await import("../src/tools/file.mjs")
    const { hashLine } = await import("../src/tools/shared.mjs")
    writeFileSync(join(cwd, "bom-crlf.txt"), "\uFEFFfirst line\r\nsecond line\r\n")
    const out = await readTool.execute({ path: "bom-crlf.txt", hashes: true }, ctx())
    assert.ok(out.includes(hashLine("first line")), "first-line hash excludes \\r and \\uFEFF: " + out)
    assert.ok(out.includes(hashLine("second line")), "second-line hash excludes \\r: " + out)
  })

  it("hashline_edit round-trips BOM + CRLF on disk (hash domain consistent with read)", async () => {
    const { hashlineEditTool } = await import("../src/tools/file.mjs")
    const { hashLine } = await import("../src/tools/shared.mjs")
    const f = join(cwd, "bom.txt")
    writeFileSync(f, "\uFEFFfirst\r\nsecond\r\n")
    const r = await hashlineEditTool.execute({ path: "bom.txt", old_hashes: [hashLine("first")], new_content: "FIRST" }, ctx())
    assert.match(r, /replaced 1 line/)
    assert.equal(readFileSync(f, "utf8"), "\uFEFFFIRST\r\nsecond\r\n")
  })

  it("hashline_edit open-doc (BOM file) passes BOM-less text to the editor (no double BOM)", async () => {
    const { hashlineEditTool } = await import("../src/tools/file.mjs")
    const { hashLine } = await import("../src/tools/shared.mjs")
    const f = join(cwd, "open-bom.txt")
    writeFileSync(f, "\uFEFFfirst\r\nsecond\r\n")
    // The host's getText() never includes the BOM (VS Code manages it via encoding).
    const doc = makeDoc("first\r\nsecond\r\n", f)
    vscode.workspace.textDocuments.push(doc)

    const r = await hashlineEditTool.execute({ path: "open-bom.txt", old_hashes: [hashLine("first")], new_content: "FIRST" }, ctx())
    assert.match(r, /replaced 1 line/)
    assert.equal(doc.getText(), "FIRST\r\nsecond\r\n")
    assert.ok(!doc.getText().startsWith("\uFEFF"), "editor text must not carry the BOM")
  })

  it("old_string not found in an open doc returns an error and does not apply", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    const doc = makeDoc("a\r\nb\r\nc\r\n", "d:\\proj\\nf.txt")
    vscode.workspace.textDocuments.push(doc)
    vscode.workspace.applyEditCalls.length = 0

    const r = await editTool.execute({ path: "nf.txt", old_string: "zzz", new_string: "x" }, { cwd: "d:\\proj" })
    assert.match(r, /old_string not found/)
    assert.equal(vscode.workspace.applyEditCalls.length, 0, "no WorkspaceEdit on a miss")
    assert.equal(doc.getText(), "a\r\nb\r\nc\r\n")
  })

  it("insert_after on a CRLF open doc injects CRLF (no bare-LF mixing)", async () => {
    const { insertAfterTool } = await import("../src/tools/more-file.mjs")
    const doc = makeDoc("one\r\ntwo\r\nthree\r\n", "d:\\proj\\ins.txt")
    vscode.workspace.textDocuments.push(doc)

    const r = await insertAfterTool.execute({ path: "ins.txt", after_line: 2, content: "twoAndHalf" }, { cwd: "d:\\proj" })
    assert.match(r, /Inserted after line 2/)
    const out = doc.getText()
    assert.equal(out, "one\r\ntwo\r\ntwoAndHalf\r\nthree\r\n")
    assert.ok(!/(?<!\r)\n/.test(out), "no bare LF injected")
  })

  it("insert_after after_regex with $ anchor matches CRLF lines", async () => {
    const { insertAfterTool } = await import("../src/tools/more-file.mjs")
    const doc = makeDoc("alpha\r\nbeta\r\ngamma\r\n", "d:\\proj\\ins2.txt")
    vscode.workspace.textDocuments.push(doc)

    const r = await insertAfterTool.execute({ path: "ins2.txt", after_regex: "beta$", content: "betaAndHalf" }, { cwd: "d:\\proj" })
    assert.match(r, /Inserted after line 2/)
    assert.equal(doc.getText(), "alpha\r\nbeta\r\nbetaAndHalf\r\ngamma\r\n")
  })
})

describe("edit 数组形态（2026-08-31 工具顺手度，CLI ebd70eb parity）：多文件原子替换", () => {
  it("两文件原子替换——都成功", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    writeFileSync(join(cwd, "a.txt"), "const A = 1\n", "utf8")
    writeFileSync(join(cwd, "b.txt"), "const B = 2\n", "utf8")
    const r = await editTool.execute({
      edits: [
        { path: "a.txt", old_string: "const A = 1", new_string: "const A = 10" },
        { path: "b.txt", old_string: "const B = 2", new_string: "const B = 20" },
      ],
    }, { cwd })
    assert.match(r, /Replaced 1 occurrence\(s\) in a\.txt/)
    assert.match(r, /Replaced 1 occurrence\(s\) in b\.txt/)
    assert.ok(readFileSync(join(cwd, "a.txt"), "utf8").includes("const A = 10"), "a.txt 已改")
    assert.ok(readFileSync(join(cwd, "b.txt"), "utf8").includes("const B = 20"), "b.txt 已改")
  })

  it("任一失败 → 全不写（原子回滚）", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    writeFileSync(join(cwd, "a.txt"), "const A = 1\n", "utf8")
    writeFileSync(join(cwd, "b.txt"), "const B = 2\n", "utf8")
    const r = await editTool.execute({
      edits: [
        { path: "a.txt", old_string: "const A = 1", new_string: "const A = 100" },
        { path: "b.txt", old_string: "NOT FOUND", new_string: "x" },
      ],
    }, { cwd })
    assert.match(r, /edit aborted \(atomic — no files written\)/)
    assert.ok(readFileSync(join(cwd, "a.txt"), "utf8").includes("const A = 1"), "a.txt 未被写（原子回滚）")
  })

  it("与 path/old_string/new_string 互斥", async () => {
    const { editTool } = await import("../src/tools/file.mjs")
    writeFileSync(join(cwd, "a.txt"), "x\n", "utf8")
    const r = await editTool.execute({
      path: "a.txt",
      old_string: "x",
      new_string: "y",
      edits: [{ path: "a.txt", old_string: "x", new_string: "y" }],
    }, { cwd })
    assert.match(r, /mutually exclusive/)
  })
})

