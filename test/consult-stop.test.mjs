/**
 * consult-stop.test.mjs — Stop must abort parked consultants (2026-08-16 user report:
 * "会诊执行中 stop 停不下来"). Two contracts:
 *  1. unit: cleanupConsultSessions aborts parked children (ctrl propagation works)
 *  2. integration: a parked consult_check in the real agent loop exits on abort
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { consultStartTool, consultCheckTool, cleanupConsultSessions } from "../src/agent-tools/consult.mjs"
import { runAgent } from "../src/agent.mjs"

const makeAgent = (consultModels) => ({
  _consultSessions: new Map(),
  _touchedFiles: [],
  _pendingReminders: [],
  config: { agent: { consultModels } },
})

const hangRunner = (p, c, t, cb, signal) => new Promise((_, reject) => {
  signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
})

describe("Stop during a consult", () => {
  it("unit: cleanupConsultSessions aborts a parked child (turn-end cleanup)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "csu-"))
    try {
      const agent = makeAgent([{ provider: "t", model: "m1" }])
      const ctx = {
        agent, cwd, callbacks: {}, signal: new AbortController().signal,
        runAgent: hangRunner,
        buildProvider: async () => ({ baseURL: "http://127.0.0.1:1", apiKey: "x", model: "m1", name: "t" }),
      }
      await consultStartTool.execute({ problem: "stuck" }, ctx)
      await new Promise((r) => setTimeout(r, 50)) // child enters the parked state
      const sess = agent._consultSessions.get("1")
      assert.equal(sess.pending, 1, "child is running/parked")
      cleanupConsultSessions(agent) // runAgent's finally does this
      await new Promise((r) => setTimeout(r, 50)) // settle propagates
      assert.equal(sess.pending, 0, "child settled after the cleanup abort — card must not spin forever")
      assert.equal(sess.stopped, true, "cleanup marks stopped so the child settles as TERMINATED (grey), not FAILED (red)")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("integration: the real agent loop exits on Stop while consult_check is parked", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "csi-"))
    let n = 0
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        n++
        const frame = n === 1
          ? { choices: [{ index: 0, finish_reason: "tool_calls", delta: { content: "", tool_calls: [{ id: "s1", type: "function", function: { name: "consult_start", arguments: JSON.stringify({ problem: "stuck" }) } }] } }] }
          : n === 2
            ? { choices: [{ index: 0, finish_reason: "tool_calls", delta: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "consult_check", arguments: JSON.stringify({ id: "1" }) } }] } }] }
            : { choices: [{ index: 0, finish_reason: "stop", delta: { content: "final" } }] }
        res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const port = server.address().port
    try {
      const ctrl = new AbortController()
      const provider = { baseURL: `http://127.0.0.1:${port}`, apiKey: "x", model: "m" }
      const t0 = Date.now()
      // children: unreachable provider → they settle failed fast, OR park — either way
      // the loop must exit on abort, not hang on consult_check.
      const runP = runAgent(provider, cwd, "test", { onToken: () => {} }, ctrl.signal, true, {})
        .then(() => "completed").catch((e) => `threw:${e?.name}`)
      setTimeout(() => ctrl.abort(), 1200)
      const result = await Promise.race([
        runP,
        new Promise((r) => setTimeout(() => r("HANG"), 6000)),
      ])
      assert.notEqual(result, "HANG", `loop must exit on Stop, got ${result}`)
      assert.ok((Date.now() - t0) < 5000, "exit was prompt")
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
