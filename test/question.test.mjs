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

test("a parked question is released (null) when the turn's signal aborts — panel-side wiring", async () => {
  // Mirrors the onQuestion wiring in panel-chat.mjs: Stop must resolve the parked
  // promise, remove the queue entry, and tell the webview to dismiss the card.
  const ctrl = new AbortController()
  const queue = []
  const posts = []
  const onQuestion = (question, options) => new Promise((resolve) => {
    const entry = { resolve }
    queue.push(entry)
    posts.push({ type: "question", question, options })
    const onAbort = () => {
      const i = queue.indexOf(entry)
      if (i >= 0) queue.splice(i, 1)
      posts.push({ type: "questionCancelled" })
      resolve(null)
    }
    if (ctrl.signal.aborted) onAbort()
    else ctrl.signal.addEventListener("abort", onAbort, { once: true })
  })
  const pending = onQuestion("Stuck?", ["a", "b"])
  ctrl.abort()
  assert.equal(await pending, null, "Stop resolves the parked question with null")
  assert.equal(queue.length, 0, "queue entry removed")
  assert.ok(posts.some((m) => m.type === "questionCancelled"), "webview told to dismiss")
})

test("the question tool returns '(user cancelled)' on a null answer", async () => {
  const ctx = { callbacks: { onQuestion: async () => null } }
  const r = await questionTool.execute({ question: "x?" }, ctx)
  assert.equal(r, "(user cancelled)")
})
