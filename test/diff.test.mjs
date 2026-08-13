/**
 * diff.test.mjs — webview diff renderer (pure functions, no DOM).
 * lineDiff/renderDiff back EVERY permission-prompt diff preview in the panel;
 * they had zero coverage until now.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { lineDiff, renderDiff } from "../webview/diff.js"

test("lineDiff keeps common prefix and suffix unchanged", () => {
  const d = lineDiff("a\nb\nc\nd", "a\nx\nc\nd")
  assert.deepEqual(d, [
    { type: "same", text: "a" },
    { type: "del", text: "b" },
    { type: "add", text: "x" },
    { type: "same", text: "c" },
    { type: "same", text: "d" },
  ])
})

test("lineDiff handles pure addition (new file)", () => {
  const d = lineDiff("", "x\ny")
  assert.deepEqual(d, [{ type: "add", text: "x" }, { type: "add", text: "y" }])
})

test("lineDiff handles pure deletion (file removed)", () => {
  const d = lineDiff("x\ny", "")
  assert.deepEqual(d, [{ type: "del", text: "x" }, { type: "del", text: "y" }])
})

test("lineDiff treats reordered identical lines as unchanged (greedy match)", () => {
  const d = lineDiff("a\nb\nc", "b\na\nc")
  const kinds = d.map((l) => l.type)
  assert.equal(kinds.filter((k) => k === "same").length, 3, "all three lines match")
})

test("lineDiff tolerates null/empty inputs", () => {
  assert.deepEqual(lineDiff(null, null), [])
  assert.deepEqual(lineDiff("a", undefined), [{ type: "del", text: "a" }])
})

test("renderDiff emits typed lines with class names and escapes HTML", () => {
  const html = renderDiff([
    { type: "same", text: "keep" },
    { type: "del", text: "<script>" },
    { type: "add", text: "new" },
  ])
  assert.ok(html.includes('class="diff-line diff-same"'), "same line class")
  assert.ok(html.includes('class="diff-line diff-del"'), "del line class")
  assert.ok(html.includes('class="diff-line diff-add"'), "add line class")
  assert.ok(html.includes("&lt;script&gt;"), "HTML escaped")
  assert.ok(!html.includes("<script>"), "no raw HTML passthrough")
})

test("renderDiff renders a placeholder for empty diffs", () => {
  assert.ok(renderDiff([]).includes("…"))
})
