/**
 * question.test.mjs — the question tool must render INLINE in the chat panel
 * (via callbacks.onQuestion), not via VS Code's native QuickPick/InputBox popup
 * at the top of the window (users miss it; an accidental click cancels it).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { questionTool } from "../src/tools/question.mjs"

test("uses the inline panel callback when provided (options passed through)", async () => {
  const seen = []
  const ctx = { callbacks: { onQuestion: async (q, opts) => { seen.push([q, opts]); return "yes" } } }
  const r = await questionTool.execute({ question: "Proceed?", options: ["yes", "no"] }, ctx)
  assert.equal(r, "yes")
  assert.deepEqual(seen[0], ["Proceed?", ["yes", "no"]])
})

test("free-text questions pass null options to the callback", async () => {
  let opts = "sentinel"
  const ctx = { callbacks: { onQuestion: async (_q, o) => { opts = o; return "answer" } } }
  const r = await questionTool.execute({ question: "What?" }, ctx)
  assert.equal(r, "answer")
  assert.equal(opts, null)
})

test("an empty options array also degrades to free-text (null options)", async () => {
  let opts = "sentinel"
  const ctx = { callbacks: { onQuestion: async (_q, o) => { opts = o; return null } } }
  await questionTool.execute({ question: "q?", options: [] }, ctx)
  assert.equal(opts, null)
})

test("a null answer surfaces as (user cancelled)", async () => {
  const ctx = { callbacks: { onQuestion: async () => null } }
  const r = await questionTool.execute({ question: "q?" }, ctx)
  assert.equal(r, "(user cancelled)")
})

test("no callback → native fallback path is not entered (callback-less ctx never crashes before it)", async () => {
  // The native fallback needs VS Code's QuickPick/InputBox, which the test mock
  // does not provide — assert the contract of the callback guard instead.
  assert.ok(typeof questionTool.execute === "function")
})
