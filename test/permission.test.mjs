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

test('aborting the turn releases a parked permission prompt with false', async () => {
  const ctrl = new AbortController()
  const panel = fakePanel(false)
  panel._abortController = ctrl
  panel._setStatus = () => {}
  const gate = permissionGate(panel)
  const pending = gate('write', { path: 'x' }, null)
  assert.equal(panel._permissionQueue.length, 1)
  ctrl.abort()
  assert.equal(await pending, false, 'Stop denies the parked permission')
  assert.equal(panel._permissionQueue.length, 0, 'queue drained')
})



// ─── §16 D-B1 批确认（AGENT-LOOP.md §16，VS Code 对齐）───

import { batchPermissionGate } from "../src/extension/permission-gate.mjs"
import { executeToolBatches } from "../src/agent/execute-tools.mjs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("batchPermissionGate: undefined when autoApprove on; merged ask returns approveAll/oneByOne/deny", async () => {
  assert.equal(batchPermissionGate({ _autoApprove: true }), undefined, "autoApprove 开 → 无批门")
  const panel = fakePanel(false)
  panel._setStatus = () => {}
  const gate = batchPermissionGate(panel)
  const p = gate({ tools: [{ name: "write", args: {} }, { name: "edit", args: {} }], count: 2 })
  assert.equal(panel._batchPermissionQueue.length, 1)
  assert.equal(panel.posted[0].type, "batchPermissionRequest")
  assert.equal(panel.posted[0].count, 2)
  const entry = panel._batchPermissionQueue.shift()
  entry.resolve("approveAll")
  assert.equal(await p, "approveAll")
})

function batchEnv({ onBatch, auto = false, planMode = false }) {
  const cwd = mkdtempSync(join(tmpdir(), "tc-perm-"))
  const history = []
  const fullHistory = []
  const calls = []
  const makeTool = (name) => ({
    name,
    readonly: false,
    execute: async (args) => { calls.push(["exec", name, args.path]); return `ok:${name}` },
    touchedPaths: (a) => [a.path],
  })
  const toolByName = new Map([["writeA", makeTool("writeA")], ["writeB", makeTool("writeB")], ["writeC", makeTool("writeC")]])
  const response = {
    toolCalls: ["writeA", "writeB", "writeC"].map((name, i) => ({
      id: `c${i + 1}`, name,
      arguments: JSON.stringify({ path: `${name}.txt`, content: "x" }),
    })),
  }
  const agent = {
    _planMode: planMode, _role: null,
    config: { agent: {} },
    _mutatedThisRun: false, _touchedFiles: [],
    _calledAdvisorThisRun: false, _verifiedThisRun: false, _advisorRound: 0,
  }
  const callbacks = {
    onPermissionRequired: (name) => { calls.push(["single", name]); return true },
    ...(onBatch ? { onBatchPermissionRequest: ({ tools, count }) => { calls.push(["batch", count, tools.map((t) => t.name)]); return onBatch } } : {}),
  }
  return { cwd, history, fullHistory, calls, agent, callbacks, toolByName, response, auto, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}

async function runBatch(env) {
  return executeToolBatches(env.agent, {
    response: env.response, history: env.history, fullHistory: env.fullHistory,
    toolByName: env.toolByName, getAuto: () => env.auto, callbacks: env.callbacks,
    signal: undefined, cwd: env.cwd, recentSigs: [], depth: 0,
  })
}

test("T-B1: 同批 3 非只读工具 → 一次合并询问（approveAll）→ 全部执行、无逐项询问", async () => {
  const env = batchEnv({ onBatch: "approveAll" })
  try {
    await runBatch(env)
    assert.deepEqual(env.calls.filter((c) => c[0] === "batch").map((c) => c[1]), [3], "恰好一次合并询问（count=3）")
    assert.deepEqual(env.calls.filter((c) => c[0] === "batch")[0][2], ["writeA", "writeB", "writeC"], "合并名列表")
    assert.equal(env.calls.filter((c) => c[0] === "single").length, 0, "approveAll 后无逐项询问")
    assert.equal(env.calls.filter((c) => c[0] === "exec").length, 3, "三个工具全部执行")
    assert.equal(env.history.filter((m) => m.role === "tool").length, 3, "结果全部提交")
  } finally {
    env.cleanup()
  }
})

test("T-B2a: deny → 全批拒绝、无二次询问、不执行", async () => {
  const env = batchEnv({ onBatch: "deny" })
  try {
    await runBatch(env)
    assert.equal(env.calls.filter((c) => c[0] === "batch").length, 1, "一次合并询问")
    assert.equal(env.calls.filter((c) => c[0] === "single").length, 0, "deny 无二次询问")
    assert.equal(env.calls.filter((c) => c[0] === "exec").length, 0, "全批不执行")
    const denied = env.history.filter((m) => m.role === "tool" && m.content.includes("Denied by user"))
    assert.equal(denied.length, 3, "三个工具结果均为 Denied")
  } finally {
    env.cleanup()
  }
})

test("T-B2b: oneByOne → 回退既有逐项通道（签名不变）", async () => {
  const env = batchEnv({ onBatch: "oneByOne" })
  try {
    await runBatch(env)
    assert.equal(env.calls.filter((c) => c[0] === "batch").length, 1, "合并询问仍发起")
    const singles = env.calls.filter((c) => c[0] === "single")
    assert.equal(singles.length, 3, "oneByOne → 逐项二次询问 ×3")
    assert.deepEqual(singles.map((c) => c[1]), ["writeA", "writeB", "writeC"])
    assert.equal(env.calls.filter((c) => c[0] === "exec").length, 3, "逐项批准后全部执行")
  } finally {
    env.cleanup()
  }
})

test("T-B6: 无 onBatchPermissionRequest handler → 自动回退逐项（不误伤不悬挂）", async () => {
  const env = batchEnv({ onBatch: null })
  try {
    await runBatch(env)
    assert.equal(env.calls.filter((c) => c[0] === "batch").length, 0, "无 handler 不发起合并询问")
    assert.equal(env.calls.filter((c) => c[0] === "single").length, 3, "回退逐项 ×3（既有语义）")
    assert.equal(env.calls.filter((c) => c[0] === "exec").length, 3)
  } finally {
    env.cleanup()
  }
})

test("autoApprove 短路不变：同批也不询问、直接执行", async () => {
  const env = batchEnv({ onBatch: "approveAll", auto: true })
  try {
    await runBatch(env)
    assert.equal(env.calls.filter((c) => c[0] === "batch").length, 0, "autoApprove 不聚合询问")
    assert.equal(env.calls.filter((c) => c[0] === "single").length, 0)
    assert.equal(env.calls.filter((c) => c[0] === "exec").length, 3, "直接全部执行")
  } finally {
    env.cleanup()
  }
})

test("前置门禁拦下的工具不计入批询问（评审 #7）：planMode 拒绝 → 无批询问、逐项也被门禁拦", async () => {
  const env = batchEnv({ onBatch: "approveAll", planMode: true })
  try {
    await runBatch(env)
    assert.equal(env.calls.filter((c) => c[0] === "batch").length, 0, "planMode 下不计入批询问")
    assert.equal(env.calls.filter((c) => c[0] === "single").length, 0, "planMode 下逐项询问也不触发")
    assert.equal(env.calls.filter((c) => c[0] === "exec").length, 0)
    const blocked = env.history.filter((m) => m.role === "tool" && m.content.includes("plan mode active"))
    assert.equal(blocked.length, 3, "全部被 planMode 拦下")
  } finally {
    env.cleanup()
  }
})
