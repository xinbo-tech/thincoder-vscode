/**
 * continue-on-turn-cap.test.mjs — turn-cap exhaustion must surface ContinueError
 * (the plugin panel then offers "Continue", CLI parity — 2026-08-16 user report:
 * the plugin errored with retry-only at 100 turns; the CLI offered Continue).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { runAgent, ContinueError } from "../src/agent.mjs"

function mockProvider(model, port) {
  return { baseURL: `http://127.0.0.1:${port}`, apiKey: "sk-test", model }
}

describe("ContinueError on turn cap", () => {
  it("runAgent throws ContinueError carrying the turn count when the cap is hit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "continue-"))
    // LLM that always asks for a readonly tool (read) → infinite loop until the cap
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        const frame = {
          choices: [{ index: 0, finish_reason: "tool_calls", delta: { content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "x" }) } }] } }],
        }
        res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const port = server.address().port
    try {
      const history = []
      await assert.rejects(
        runAgent(mockProvider("deepseek-v4-pro", port), cwd, "loop", {}, undefined, true, { history, fullHistory: [], maxTurns: 2 }),
        (e) => e instanceof ContinueError && e.turns === 2,
        "turn cap surfaces as ContinueError with the turn count (panel offers Continue)"
      )
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("resume=true re-runs from the same history without duplicating the user message", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "continue-resume-"))
    let n = 0
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        n++
        // First call asks for a tool (loop); after resume the cap resets and the model finishes
        const frame = n <= 2
          ? { choices: [{ index: 0, finish_reason: "tool_calls", delta: { content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "x" }) } }] } }] }
          : { choices: [{ index: 0, finish_reason: "stop", delta: { content: "done" } }] }
        res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const port = server.address().port
    try {
      const history = []
      // run 1: hits the cap (maxTurns 2)
      await assert.rejects(
        runAgent(mockProvider("deepseek-v4-pro", port), cwd, "loop", {}, undefined, true, { history, fullHistory: [], maxTurns: 2 }),
        (e) => e instanceof ContinueError
      )
      const userCountAfterCap = history.filter((m) => m.role === "user" && m.content === "loop").length
      assert.equal(userCountAfterCap, 1, "one user message after the capped run")
      // run 2: resume=true — no duplicate user message, model finishes
      const result = await runAgent(mockProvider("deepseek-v4-pro", port), cwd, "loop", {}, undefined, true, { history, fullHistory: [], maxTurns: 10, resume: true })
      assert.equal(result, "done")
      const userCountAfterResume = history.filter((m) => m.role === "user" && m.content === "loop").length
      assert.equal(userCountAfterResume, 1, "resume did not duplicate the user message")
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
