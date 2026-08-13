/**
 * permission.test.mjs — permission gate contract: the mid-turn autoApprove flag
 * short-circuits every invocation (approve-all / AUTO button must stop repeated
 * prompts for the REST of the running turn, not just clear the current queue).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { permissionGate } from "../src/extension/permission-gate.mjs"

function fakePanel(autoApprove) {
  const posted = []
  return {
    _autoApprove: autoApprove,
    _permissionQueue: [],
    _panel: { webview: { postMessage: (m) => posted.push(m) } },
    posted,
  }
}

test("permissionGate returns undefined when autoApprove is on at turn start", () => {
  const panel = fakePanel(true)
  assert.equal(permissionGate(panel), undefined)
})

test("permissionGate queues a prompt and posts permissionRequest when approval is off", async () => {
  const panel = fakePanel(false)
  const gate = permissionGate(panel)
  assert.equal(typeof gate, "function")

  let settled = false
  const p = gate("write", { path: "a.mjs", content: "x" }, null).then((v) => { settled = true; return v })
  assert.equal(panel._permissionQueue.length, 1)
  assert.equal(panel.posted.length, 1)
  assert.equal(panel.posted[0].type, "permissionRequest")
  assert.equal(panel.posted[0].tool, "write")
  // The promise must stay pending until the user answers — never auto-resolved.
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(settled, false)

  // User approves the single prompt.
  const entry = panel._permissionQueue.shift()
  entry.resolve(true)
  assert.equal(await p, true)
})

test("mid-turn flag flip (approve-all) resolves immediately without prompting — the bug regression", async () => {
  const panel = fakePanel(false)
  const gate = permissionGate(panel)  // built while autoApprove was still off

  // User clicks "Approve All" mid-turn: panel-messages resolves the queue and
  // calls _setAutoApprove(true), which flips the live flag.
  panel._autoApprove = true

  const v = await gate("write", { path: "b.mjs", content: "y" }, null)
  assert.equal(v, true)
  // No new prompt was queued or posted — the rest of the turn runs silently.
  assert.equal(panel._permissionQueue.length, 0)
  assert.equal(panel.posted.length, 0)
})

test("approve-all clears every pending prompt in the queue (panel-messages semantics)", async () => {
  const panel = fakePanel(false)
  const gate = permissionGate(panel)
  const p1 = gate("write", { path: "a.mjs" }, null)
  const p2 = gate("edit", { path: "b.mjs" }, null)
  assert.equal(panel._permissionQueue.length, 2)

  // Mirror panel-messages.mjs permissionResponse "approveAll" branch.
  panel._permissionQueue.forEach((e) => e.resolve(true))
  panel._permissionQueue.length = 0
  panel._autoApprove = true

  assert.deepEqual(await Promise.all([p1, p2]), [true, true])
})
