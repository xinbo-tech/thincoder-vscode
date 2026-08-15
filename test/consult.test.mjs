/**
 * consult.test.mjs — multi-model consultation mechanism (docs/design/CONSULTATION.md).
 * Children run through an injected fake runner (ctx.runAgent) — no real providers.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { consultStartTool, consultCheckTool, consultStopTool, makeMainHistoryTool, cleanupConsultSessions } from "../src/agent-tools/consult.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeAgent(models) {
  return {
    history: [
      { role: "user", content: "fix the bug" },
      { role: "tool", content: "Error: type mismatch at foo.mjs:12", tool_call_id: "t1" },
    ],
    config: { agent: { consultModels: models, subagentTurns: 100 } },
  }
}

function makeCtx(agent, runner, signal) {
  return {
    agent, cwd: process.cwd(), signal, runAgent: runner, callbacks: {},
    buildProvider: async (name) => ({ baseURL: "https://test/v1", apiKey: "sk-test", model: "x", name }),
  }
}

const MODELS = [
  { provider: "deepseek", model: "m-a" },
  { provider: "openai", model: "m-b" },
  { provider: "glm", model: "m-c" },
]

/** Fake runner whose reply per model is controlled: { reply, delay, fail } keyed by child model. */
function fakeRunner(script) {
  const calls = []
  return {
    calls,
    fn: async (provider, cwd, task, callbacks, signal) => {
      const spec = script[provider.model] ?? { reply: "default", delay: 0 }
      calls.push({ model: provider.model, task, opts: arguments?.[5] })
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, spec.delay ?? 0)
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")) }, { once: true })
      })
      if (spec.fail) throw new Error(spec.fail)
      return spec.reply
    },
  }
}

describe("consult mechanism", () => {
  it("start returns immediately with id + models (non-blocking)", async () => {
    const agent = makeAgent(MODELS)
    const r = JSON.parse(await consultStartTool.execute({ problem: "stuck" }, makeCtx(agent, fakeRunner({ "m-a": { reply: "A", delay: 500 } }).fn)))
    assert.ok(r.id, "returns an id")
    assert.deepEqual(r.models, ["deepseek:m-a", "openai:m-b", "glm:m-c"])
    await cleanupConsultSessions(agent)
  })

  it("check yields replies in arrival order (first-settled first), then done", async () => {
    const agent = makeAgent(MODELS)
    const runner = fakeRunner({
      "m-a": { reply: "answer-A", delay: 150 },
      "m-b": { reply: "answer-B", delay: 10 }, // B arrives first
      "m-c": { reply: "answer-C", delay: 300 },
    })
    await consultStartTool.execute({ problem: "stuck" }, makeCtx(agent, runner.fn))
    const first = JSON.parse(await consultCheckTool.execute({ id: "1" }, makeCtx(agent, runner.fn)))
    assert.equal(first.reply, "answer-B", "earliest reply first")
    assert.equal(first.done, false)
    const second = JSON.parse(await consultCheckTool.execute({ id: "1" }, makeCtx(agent, runner.fn)))
    assert.equal(second.reply, "answer-A")
    const third = JSON.parse(await consultCheckTool.execute({ id: "1" }, makeCtx(agent, runner.fn)))
    assert.equal(third.reply, "answer-C")
    assert.equal(third.done, true, "last reply reports done")
  })

  it("early stop aborts the remaining children", async () => {
    const agent = makeAgent(MODELS)
    const runner = fakeRunner({
      "m-a": { reply: "good", delay: 5 },
      "m-b": { reply: "slow", delay: 5000 },
      "m-c": { reply: "slow", delay: 5000 },
    })
    const ctx = makeCtx(agent, runner.fn)
    await consultStartTool.execute({ problem: "stuck" }, ctx)
    const first = JSON.parse(await consultCheckTool.execute({ id: "1" }, ctx))
    assert.equal(first.reply, "good")
    const stop = JSON.parse(await consultStopTool.execute({ id: "1" }, ctx))
    assert.equal(stop.stopped, 2, "two still-running consultations aborted")
    // Aborted children settle as terminated notes — drain until done
    let done = false
    for (let i = 0; i < 5 && !done; i++) {
      done = JSON.parse(await consultCheckTool.execute({ id: "1" }, ctx)).done
    }
    assert.equal(done, true, "session reaches done after early stop")
  })

  it("unknown id returns an error, never hangs", async () => {
    const agent = makeAgent(MODELS)
    const r = JSON.parse(await consultCheckTool.execute({ id: "999" }, makeCtx(agent, fakeRunner({}).fn)))
    assert.equal(r.error, "unknown consult id")
    const s = JSON.parse(await consultStopTool.execute({ id: "999" }, makeCtx(agent, fakeRunner({}).fn)))
    assert.equal(s.error, "unknown consult id")
  })

  it("a failed model settles without blocking the others; all-fail still reaches done", async () => {
    const agent = makeAgent(MODELS)
    const runner = fakeRunner({
      "m-a": { fail: "boom", delay: 10 },
      "m-b": { fail: "boom", delay: 20 },
      "m-c": { fail: "boom", delay: 30 },
    })
    const ctx = makeCtx(agent, runner.fn)
    await consultStartTool.execute({ problem: "stuck" }, ctx)
    // Drain replies (failure notes) until done
    let done = false, notes = 0
    for (let i = 0; i < 5 && !done; i++) {
      const r = JSON.parse(await consultCheckTool.execute({ id: "1" }, ctx))
      done = r.done
      if (r.reply) notes++
    }
    assert.equal(done, true, "all-fail session still completes")
    assert.equal(notes, 3, "each failed model surfaced a failure note")
  })

  it("user Stop aborts all children and check returns done", async () => {
    const agent = makeAgent(MODELS)
    const ctrl = new AbortController()
    const runner = fakeRunner({ "m-a": { reply: "x", delay: 5000 }, "m-b": { reply: "y", delay: 5000 }, "m-c": { reply: "z", delay: 5000 } })
    const ctx = makeCtx(agent, runner.fn, ctrl.signal)
    await consultStartTool.execute({ problem: "stuck" }, ctx)
    const pending = consultCheckTool.execute({ id: "1" }, ctx)
    setTimeout(() => ctrl.abort(), 50)
    const r = JSON.parse(await pending)
    assert.equal(r.done, true)
    assert.equal(r.stopped, true)
  })

  it("config validation: empty list explains setup, >5 models rejected", async () => {
    const empty = await consultStartTool.execute({ problem: "x" }, makeCtx(makeAgent([]), fakeRunner({}).fn))
    assert.match(empty, /consultModels/, "plain-text guidance when unconfigured")
    const tooMany = makeAgent(Array.from({ length: 6 }, (_, i) => ({ provider: "p" + i, model: "m" + i })))
    const r = await consultStartTool.execute({ problem: "x" }, makeCtx(tooMany, fakeRunner({}).fn))
    assert.match(r, /at most 5/)
  })

  it("main_history returns the parent's recent history, read-only", async () => {
    const agent = makeAgent(MODELS)
    const tool = makeMainHistoryTool(agent)
    const out = await tool.execute({ limit: 10 }, {})
    assert.match(out, /fix the bug/)
    assert.match(out, /type mismatch at foo\.mjs:12/, "failure trail visible verbatim")
    assert.equal(tool.readonly, true)
  })

  it("consultation children run read-only with main_history injected", async () => {
    const agent = makeAgent(MODELS)
    const seen = []
    const runner = async (provider, cwd, task, callbacks, signal, auto, opts) => {
      seen.push(opts)
      return "ok"
    }
    const ctx = makeCtx(agent, runner)
    await consultStartTool.execute({ problem: "stuck" }, ctx)
    await sleep(50)
    assert.equal(seen.length, 3)
    for (const o of seen) {
      assert.equal(o.role, "consult", "consult role (own overlay, read-only tools, small turn budget)")
      assert.equal(o.depth, 1)
      assert.equal(o.maxTurns, 40, "consult turn budget")
      assert.ok(o.extraTools?.some((t) => t.name === "main_history"), "main_history injected")
    }
    await cleanupConsultSessions(agent)
  })

  it("consultant tool activity streams to the panel under sub:consult <label>", async () => {
    const agent = makeAgent(MODELS)
    const panels = []
    const runner = async (provider, cwd, task, callbacks) => {
      // simulate the child doing tool work
      callbacks.onToolCall?.("read", { path: "src/a.mjs" })
      callbacks.onToolResult?.("read", "file contents")
      return "diagnosis"
    }
    const ctx = makeCtx(agent, runner)
    ctx.callbacks = { onToolPanel: (name, chunk) => panels.push({ name, chunk }) }
    await consultStartTool.execute({ problem: "stuck" }, ctx)
    await sleep(50)
    const names = [...new Set(panels.map((p) => p.name))]
    assert.equal(names.length, 3, "one stream per consultant")
    for (const n of names) assert.ok(n.startsWith("sub:consult "), `stream name, got ${n}`)
    assert.ok(panels.some((p) => p.chunk.text.includes("read")), "tool calls streamed")
    assert.ok(panels.some((p) => p.chunk.text.startsWith("→ ")), "tool results streamed")
    await cleanupConsultSessions(agent)
  })

  it("watchdog timeout settles as 'timed out', not 'aborted' (a timeout is not a provider crash)", async () => {
    const agent = makeAgent(MODELS)
    agent.config.agent.consultTimeoutMs = 50
    // runner that never resolves on its own — only the watchdog abort can end it
    const hang = (provider, cwd, task, callbacks, signal) => new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
    })
    const ctx = makeCtx(agent, hang)
    await consultStartTool.execute({ problem: "stuck" }, ctx)
    const r = JSON.parse(await consultCheckTool.execute({ id: "1" }, ctx))
    assert.ok(r.reply.includes("timed out"), `timeout note, got: ${r.reply}`)
    assert.ok(!r.reply.includes("Aborted"), "must not read as an abort/provider crash")
    await cleanupConsultSessions(agent)
  })

  it("consultTurns/consultTimeoutMs config values flow through to children (not just defaults)", async () => {
    const agent = makeAgent(MODELS)
    agent.config.agent.consultTurns = 7
    agent.config.agent.consultTimeoutMs = 12345
    const seen = []
    const runner = async (provider, cwd, task, callbacks, signal, auto, opts) => {
      seen.push(opts)
      return "ok"
    }
    const ctx = makeCtx(agent, runner)
    await consultStartTool.execute({ problem: "stuck" }, ctx)
    await sleep(50)
    assert.equal(seen.length, 3)
    for (const o of seen) {
      assert.equal(o.maxTurns, 7, "configured consultTurns reaches the child")
    }
    await cleanupConsultSessions(agent)
  })

  it("turn cleanup aborts leftover sessions and clears the map", async () => {
    const agent = makeAgent(MODELS)
    const runner = fakeRunner({ "m-a": { reply: "x", delay: 5000 }, "m-b": { reply: "y", delay: 5000 }, "m-c": { reply: "z", delay: 5000 } })
    const ctx = makeCtx(agent, runner.fn)
    await consultStartTool.execute({ problem: "stuck" }, ctx)
    assert.equal(agent._consultSessions.size, 1)
    const parked = consultCheckTool.execute({ id: "1" }, ctx)
    cleanupConsultSessions(agent)
    assert.equal(agent._consultSessions.size, 0)
    const r = JSON.parse(await parked) // parked waiter was woken
    assert.ok(r.done === true || r.reply, "parked check resolved")
  })
})
