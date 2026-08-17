/**
 * subagent.test.mjs — subagent provider override (model arg) resolution (CLI parity).
 */
import { test } from "node:test"
import assert from "node:assert/strict"

test("resolveChildProvider: provider:model / provider name / model name / null", async () => {
  const { resolveChildProvider } = await import("../src/agent-tools/subagent.mjs")
  const parent = {
    _provider: { name: "glm", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", apiKey: "glm-key" },
    config: {
      providersList: [
        { name: "glm", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", apiKey: "glm-key" },
        { name: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-v4-pro", apiKey: "ds-key" },
      ],
    },
  }
  // null → inherit parent (shallow copy)
  assert.deepEqual(resolveChildProvider(parent, null), parent._provider)
  // provider:model → named provider + named model
  const pm = resolveChildProvider(parent, "deepseek:deepseek-v4-flash")
  assert.equal(pm.name, "deepseek")
  assert.equal(pm.model, "deepseek-v4-flash")
  assert.equal(pm.baseURL, "https://api.deepseek.com")
  assert.equal(pm.apiKey, "ds-key")
  // provider name → configured model
  const pn = resolveChildProvider(parent, "deepseek")
  assert.equal(pn.model, "deepseek-v4-pro")
  // model name → same provider, different model
  const mn = resolveChildProvider(parent, "deepseek-v4-flash")
  assert.equal(mn.name, "glm")
  assert.equal(mn.model, "deepseek-v4-flash")
  assert.equal(mn.baseURL, parent._provider.baseURL)
  assert.equal(mn.apiKey, "glm-key")
  // unknown provider name in provider:model → throw
  assert.throws(() => resolveChildProvider(parent, "nope:model"), /unknown provider/)
})


test("resolveChildProvider: env keys are NOT picked up (config-only)", async () => {
  const { resolveChildProvider } = await import("../src/agent-tools/subagent.mjs")
  const parent = {
    _provider: { name: "glm", baseURL: "x", model: "glm-5.2", apiKey: "k" },
    config: {
      providersList: [{ name: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-v4-pro" }],
    },
  }
  const prev = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = "env-key"
  try {
    const p = resolveChildProvider(parent, "deepseek")
    assert.equal(p.apiKey, undefined, "env key must not leak into the child provider")
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = prev
  }
})

test("effectiveSubagentModel: tool arg > type-level > global > null", async () => {
  const { effectiveSubagentModel } = await import("../src/agent-tools/subagent.mjs")
  const parent = {
    config: {
      agent: { subagentModel: "global-model", subagentModels: { coder: "type-model" } },
    },
  }
  assert.equal(effectiveSubagentModel(parent, "coder", "arg-model"), "arg-model", "tool arg wins")
  assert.equal(effectiveSubagentModel(parent, "coder", null), "type-model", "type-level wins over global")
  assert.equal(effectiveSubagentModel(parent, "explore", null), "global-model", "global fallback")
  const bare = { config: { agent: {} } }
  assert.equal(effectiveSubagentModel(bare, "coder", null), null, "null = inherit parent")
})

// ─── turn-cap continue (TURN-CAP-CONTINUE.md): every wall prompts, unlimited ───

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"

/** Fake SSE LLM: the first `walls` calls demand a read tool (loop), then it answers. */
function wallServer(walls) {
  const calls = { n: 0 }
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      calls.n++
      const frame = calls.n <= walls
        ? { choices: [{ index: 0, finish_reason: "tool_calls", delta: { content: "", tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "x" }) } }] } }] }
        : { choices: [{ index: 0, finish_reason: "stop", delta: { content: "child done" } }] }
      res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
    })
  })
  return { server, calls }
}

async function runChild(parent, walls, onQuestion) {
  const { subagentTool } = await import("../src/agent-tools/subagent.mjs")
  const cwd = mkdtempSync(join(tmpdir(), "tc-sub-"))
  const ctx = { agent: parent, cwd, callbacks: { onQuestion } }
  const r = String(await subagentTool.execute({ task: "loop until the cap", role: "coder" }, ctx))
  rmSync(cwd, { recursive: true, force: true })
  return r
}

test("subagent tool: turn-cap walls prompt Continue — resume completes with fresh budget", async () => {
  const { server, calls } = wallServer(3)
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  try {
    const parent = {
      _provider: { name: "t", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "deepseek-v4-pro" },
      config: {
        providersList: [{ name: "t", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "deepseek-v4-pro" }],
        agent: { subagentTurns: 3, engineering: false },
      },
      _subIdCounter: 0,
    }
    const asks = []
    const r = await runChild(parent, 3, async (q, options) => { asks.push({ q, options }); return "Continue" })
    assert.equal(calls.n, 4, "3 loop calls hit the cap, the resumed run finished on the 4th")
    assert.equal(asks.length, 1, "one wall → one prompt")
    assert.ok(asks[0].q.includes("3 turns"), "question names the turn count")
    assert.deepEqual(asks[0].options, ["Continue", "Stop"])
    assert.ok(r.includes("Subagent (coder) completed"), "resume completes normally")
  } finally {
    server.close()
  }
})

test("subagent tool: user Stop at the wall → partial-work return, no resume", async () => {
  const { server, calls } = wallServer(999)
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  try {
    const parent = {
      _provider: { name: "t", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "deepseek-v4-pro" },
      config: {
        providersList: [{ name: "t", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "deepseek-v4-pro" }],
        agent: { subagentTurns: 3, engineering: false },
      },
      _subIdCounter: 0,
    }
    const r = await runChild(parent, 999, async () => "Stop")
    assert.equal(calls.n, 3, "hit the cap and stopped — no resumed run")
    assert.ok(r.includes("stopped: turn cap reached"), "partial-work message names the cap")
    assert.ok(r.includes("Partial output"), "partial output included")
  } finally {
    server.close()
  }
})
