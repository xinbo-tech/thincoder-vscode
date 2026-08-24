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


// ─── explore turn budget (AGENT-PARAMS-TUNING 2026-08-24): no Math.min(30, …) hard cap ───

test("explore sub-agent uses the full subagentTurns budget — no 30-round cap (AC3)", async () => {
  const { server, calls } = wallServer(999)
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  const cwd = mkdtempSync(join(tmpdir(), "tc-sub-"))
  try {
    const { subagentTool } = await import("../src/agent-tools/subagent.mjs")
    const parent = {
      _provider: { name: "t", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "deepseek-v4-pro" },
      config: {
        providersList: [{ name: "t", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "deepseek-v4-pro" }],
        agent: { subagentTurns: 42, engineering: false },
      },
      _subIdCounter: 0,
    }
    const ctx = { agent: parent, cwd, callbacks: {} }
    const r = String(await subagentTool.execute({ task: "loop", role: "explore" }, ctx))
    assert.equal(calls.n, 42, "explore runs the full 42-turn budget (old Math.min(30, …) would stop at 30)")
    assert.ok(r.includes("turn cap reached (42 turns)"), "cap message names the configured budget")
  } finally {
    server.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

// ─── mode-dependent subagent role enum (ARCHITECTURE.md: subagent role 枚举按模式覆盖) ───

test("modeRoleField(false): coder shown, eng-coder hidden, suffix empty", async () => {
  const { modeRoleField } = await import("../src/agent-tools/subagent.mjs")
  const { role, suffix } = modeRoleField(false)
  assert.equal(role.type, "string")
  assert.ok(role.enum.includes("coder"), "normal mode advertises coder")
  assert.ok(!role.enum.includes("eng-coder"), "normal mode hides eng-coder")
  assert.match(role.description, /disabled in normal mode/)
  assert.equal(suffix, "")
})

test("modeRoleField(true): eng-coder shown, coder hidden, suffix names eng-coder", async () => {
  const { modeRoleField } = await import("../src/agent-tools/subagent.mjs")
  const { role, suffix } = modeRoleField(true)
  assert.equal(role.type, "string")
  assert.ok(role.enum.includes("eng-coder"), "engineering mode advertises eng-coder")
  assert.ok(!role.enum.includes("coder"), "engineering mode hides coder")
  assert.match(role.description, /disabled in engineering mode/)
  assert.match(suffix, /role='eng-coder'/)
})

test("runtime gate: non-engineering + role='eng-coder' still throws (unchanged)", async () => {
  const { subagentTool } = await import("../src/agent-tools/subagent.mjs")
  const ctx = { agent: { config: { agent: { engineering: false } } }, cwd: process.cwd(), callbacks: {} }
  await assert.rejects(
    subagentTool.execute({ task: "t", role: "eng-coder" }, ctx),
    /Engineering mode is not active/,
  )
})

test("runtime gate: engineering + role='coder' throws mutual exclusion (unchanged)", async () => {
  const { subagentTool } = await import("../src/agent-tools/subagent.mjs")
  const ctx = { agent: { config: { agent: { engineering: true } } }, cwd: process.cwd(), callbacks: {} }
  await assert.rejects(
    subagentTool.execute({ task: "t", role: "coder" }, ctx),
    /Engineering mode: use role='eng-coder' for implementation tasks\./,
  )
})

// ④ wiring: capture the actual depth-0 LLM request and inspect the subagent schema it carries.
async function depth0SubagentSchema(engEnabled) {
  const { runAgent } = await import("../src/agent.mjs")
  const bodies = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      bodies.push(JSON.parse(body))
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n",
      )
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  const cwd = mkdtempSync(join(tmpdir(), "tc-schema-"))
  try {
    const provider = { name: "t", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "deepseek-v4-pro" }
    const result = await runAgent(provider, cwd, "hi", {}, undefined, true, {
      history: [], fullHistory: [], mcpServers: [], skills: [],
      engState: { enabled: engEnabled }, // pinned — the shared config.json must not leak into this test
    })
    assert.equal(result, "ok")
    const sub = bodies[0].tools.find((t) => t.function.name === "subagent")
    assert.ok(sub, "depth-0 tool table includes subagent")
    return sub
  } finally {
    server.close()
    rmSync(cwd, { recursive: true, force: true })
  }
}

test("wiring: depth-0 subagent schema role enum follows the mode", async () => {
  const normal = await depth0SubagentSchema(false)
  assert.ok(normal.function.parameters.properties.role.enum.includes("coder"))
  assert.ok(!normal.function.parameters.properties.role.enum.includes("eng-coder"), "non-engineering schema must not show eng-coder")
  assert.ok(!normal.function.description.includes("In engineering mode"), "no engineering suffix in normal mode")

  const eng = await depth0SubagentSchema(true)
  assert.ok(eng.function.parameters.properties.role.enum.includes("eng-coder"))
  assert.ok(!eng.function.parameters.properties.role.enum.includes("coder"), "engineering schema must not show coder")
  assert.match(eng.function.description, /role='eng-coder'/, "engineering suffix appended to the description")
})

// ─── subagent activity stream (ARCHITECTURE.md: subagent 活动流修复 2026-08-22) ───

/** Fake SSE LLM streaming a reasoning chunk + a content token per call, then either
 *  demands a read tool (loop — the first `walls` calls) or answers and stops. */
function streamServer(walls) {
  const calls = { n: 0 }
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      calls.n++
      const frames = calls.n <= walls
        ? [
            { choices: [{ index: 0, delta: { reasoning_content: `think-${calls.n}` } }] },
            { choices: [{ index: 0, delta: { content: `part${calls.n} ` } }] },
            { choices: [{ index: 0, finish_reason: "tool_calls", delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "x" }) } }] } }] },
          ]
        : [
            { choices: [{ index: 0, delta: { reasoning_content: "final-think" } }] },
            { choices: [{ index: 0, delta: { content: "done" } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]
      res.end(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n")
    })
  })
  return { server, calls }
}

test("activity stream: panel channel name carries #subId (one block per invocation)", async () => {
  const { server } = streamServer(0)
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  const cwd = mkdtempSync(join(tmpdir(), "tc-sub-"))
  try {
    const { subagentTool } = await import("../src/agent-tools/subagent.mjs")
    const panels = []
    const parent = {
      _provider: { name: "t", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "deepseek-v4-pro" },
      config: {
        providersList: [{ name: "t", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "deepseek-v4-pro" }],
        agent: { subagentTurns: 3, engineering: true },
      },
      _subIdCounter: 0,
      _engDesignToken: "plain-token", // no ":" → validateDesignToken short-circuits true
    }
    const ctx = { agent: parent, cwd, callbacks: { onToolPanel: (name, chunk) => panels.push({ name, chunk }) } }
    const r = String(await subagentTool.execute({ task: "child", role: "eng-coder", designToken: "plain-token" }, ctx))
    assert.ok(r.includes("Subagent (eng-coder) completed"), "run completes")
    assert.ok(panels.length > 0, "activity streamed to the panel")
    for (const p of panels) assert.match(p.name, /^sub:eng-coder#\d+$/, `channel name carries #subId: ${p.name}`)
    assert.match(panels[0].name, /^sub:eng-coder#1$/, "first invocation is block #1")
  } finally {
    server.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("activity stream: onToken → panel kind=text and accumulates; onReasoning → panel kind=think", async () => {
  const { server, calls } = streamServer(3)
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  const cwd = mkdtempSync(join(tmpdir(), "tc-sub-"))
  try {
    const { subagentTool } = await import("../src/agent-tools/subagent.mjs")
    const panels = []
    const parent = {
      _provider: { name: "t", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "deepseek-v4-pro" },
      config: {
        providersList: [{ name: "t", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "deepseek-v4-pro" }],
        agent: { subagentTurns: 3, engineering: false },
      },
      _subIdCounter: 0,
    }
    const ctx = {
      agent: parent, cwd,
      callbacks: {
        onToolPanel: (name, chunk) => panels.push({ name, chunk }),
        onQuestion: async () => "Stop",
      },
    }
    const r = String(await subagentTool.execute({ task: "loop until the cap", role: "coder" }, ctx))
    assert.equal(calls.n, 3, "three looped calls hit the cap — stopped without resume")
    const thinks = panels.filter((p) => p.chunk.kind === "think")
    assert.equal(thinks.length, 3, "every reasoning chunk streams as kind=think")
    assert.deepEqual(thinks.map((p) => p.chunk.text), ["think-1", "think-2", "think-3"])
    const texts = panels.filter((p) => p.chunk.kind === "text")
    assert.equal(texts.length, 3, "every content delta streams as kind=text")
    assert.equal(texts.map((p) => p.chunk.text).join(""), "part1 part2 part3 ")
    assert.ok(r.includes("Partial output: part1 part2 part3 "), "tokens accumulate into output")
    for (const p of panels) assert.match(p.name, /^sub:coder#1$/, "all chunks share the same per-call channel")
  } finally {
    server.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})
