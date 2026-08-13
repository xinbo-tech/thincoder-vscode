/**
 * webview-lib.test.mjs — pure helpers extracted from chat.js/ui.js.
 * The webview otherwise had ZERO coverage; these lock down the panel-preview
 * truncation, token formatting, time formatting, and the apply_patch approval
 * preview's +/- line classification.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { tailTruncate, fmtK, fmtTime, patchLineType } from "../webview/lib.js"

test("tailTruncate keeps short text intact", () => {
  assert.equal(tailTruncate("hello", 100), "hello")
  assert.equal(tailTruncate("", 100), "")
  assert.equal(tailTruncate(null, 100), "")
})

test("tailTruncate snaps forward to a line boundary (never cuts markdown mid-syntax)", () => {
  const text = "line1\nline2\n" + "x".repeat(3000) + "\ntail"
  const out = tailTruncate(text, 100)
  // starts after the last \n before the cut point → no half-cut line
  assert.ok(out.startsWith("tail"), `expected to start at the next full line, got: ${JSON.stringify(out.slice(0, 20))}`)
})

test("tailTruncate falls back to raw slice when no newline exists", () => {
  const text = "x".repeat(3000)
  const out = tailTruncate(text, 100)
  assert.equal(out.length, 100)
})

test("fmtK formats token counts", () => {
  assert.equal(fmtK(0), "0")
  assert.equal(fmtK(999), "999")
  assert.equal(fmtK(1000), "1.0k")
  assert.equal(fmtK(1500), "1.5k")
  assert.equal(fmtK(10000), "10k")
  assert.equal(fmtK(1234567), "1235k")
})

test("fmtTime zero-pads hours and minutes", () => {
  assert.equal(fmtTime(new Date(2026, 0, 1, 9, 5)), "09:05")
  assert.equal(fmtTime(new Date(2026, 0, 1, 23, 59)), "23:59")
  assert.equal(fmtTime(new Date(2026, 0, 1, 0, 0)), "00:00")
})

test("patchLineType classifies unified-diff lines", () => {
  assert.equal(patchLineType("+added line"), "add")
  assert.equal(patchLineType("-removed line"), "del")
  // file/hunk headers stay neutral
  assert.equal(patchLineType("+++ b/file.mjs"), "same")
  assert.equal(patchLineType("--- a/file.mjs"), "same")
  assert.equal(patchLineType("@@ -1,3 +1,3 @@"), "same")
  assert.equal(patchLineType("diff --git a/x b/x"), "same")
  assert.equal(patchLineType(" context line"), "same")
  assert.equal(patchLineType(""), "same")
})
