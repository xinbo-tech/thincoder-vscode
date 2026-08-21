/**
 * agent.test.mjs — Agent infrastructure tests
 * Tests compaction, model specs, and tool error handling.
 * Full agent loop is tested via smoke-provider.mjs.
 * Run: node --test test/agent.test.mjs
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { compactHistory, truncateFallback, shrinkOversized } from "../src/compact.mjs"
import { specForModel, ctxPercentForModel, contextWindowForModel } from "../src/config.mjs"
import { _setConfigPathForTest } from "../src/config-io.mjs"
import { MAX_ADVISOR_PUSHBACKS } from "../src/agent/run-helpers.mjs"

// ─── Helpers ────────────────────────────────────────────────────

function setupTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-test-"))
  mkdirSync(join(dir, ".thincoder"), { recursive: true })
  return dir
}

function mockProvider(model = "deepseek-v4-pro", port = null) {
  return { baseURL: port ? `http://127.0.0.1:${port}` : "https://api.test/v1", apiKey: "sk-test", model }
}

// ─── Model specs ────────────────────────────────────────────────

describe("model specs", () => {
  it("1M context models", () => {
    assert.equal(specForModel("deepseek-v4-pro").context, 1_000_000)
    assert.equal(specForModel("kimi-k3").context, 1_000_000)
    assert.equal(specForModel("glm-5.2").context, 1_000_000)
    assert.equal(specForModel("gpt-4.1").context, 1_000_000)
    assert.equal(specForModel("qwen3.8-max").context, 1_000_000)
    assert.equal(specForModel("MiniMax-M3").context, 1_000_000)
    assert.equal(specForModel("grok-4").context, 1_000_000)
  })

  it("qwen3.7-max is text-only (DashScope 400 on images — CLI parity)", () => {
    // CLI config.mjs marks qwen3.7-max WITHOUT multimodal (it rejects image parts with
    // DashScope 400 "Unexpected item type in content"). A drift here (multimodal: true)
    // makes the extension send images to a model that refuses them — every request 400s.
    assert.equal(specForModel("qwen3.7-max").multimodal, undefined)
  })

  it("2M context model", () => {
    assert.equal(specForModel("gemini-2.5-pro").context, 2_000_000)
  })

  it("200K-256K context models", () => {
    assert.equal(specForModel("claude-sonnet-4").context, 200_000)
    assert.equal(specForModel("kimi-k2-retired-fallback").context, 128_000) // unknown ids → 128K default
  })

  it("maxOutput values are reasonable", () => {
    assert.equal(specForModel("deepseek-v4-pro").maxOutput, 384_000)
    assert.equal(specForModel("claude-sonnet-4").maxOutput, 32_000)
    assert.equal(specForModel("gemini-2.5-pro").maxOutput, 64_000)
  })

  it("unknown model defaults to 128K", () => {
    assert.equal(specForModel("some-fake-model").context, 128_000)
    assert.equal(specForModel("").context, 128_000)
    assert.equal(specForModel().context, 128_000)
  })

  it("prefix matching is case-insensitive", () => {
    assert.equal(specForModel("DEEPSEEK-V4-PRO").context, 1_000_000)
    assert.equal(specForModel("Kimi-K3").context, 1_000_000)
    assert.equal(specForModel("GLM-5.2").context, 1_000_000)
  })

  it("longest prefix wins (deepseek-v4-pro before deepseek-v4-flash)", () => {
    assert.equal(specForModel("deepseek-v4-pro").maxOutput, 384_000)
    assert.equal(specForModel("deepseek-v4-flash").context, 1_000_000) // official: dual v4 models both 1M
  })

  it("kimi-code preset + short ID k3 get the kimi-k3 spec (IK5VGJ)", async () => {
    const { PROVIDER_PRESETS } = await import("../src/config-io.mjs")
    const preset = PROVIDER_PRESETS["kimi-code"]
    assert.ok(preset, "kimi-code preset must exist")
    assert.equal(preset.baseURL, "https://api.kimi.com/coding/v1")
    assert.equal(preset.model, "k3")
    const s = specForModel("k3")
    assert.equal(s.context, 1_000_000, "k3 must get 1M context (not the 128K default)")
    assert.equal(s.multimodal, true, "k3 supports images — read_image must not be gated off")
    assert.equal(s.partialMode, true)
    assert.equal(s.reasoningEcho, "required")
    assert.equal(specForModel("kimi-k3").context, 1_000_000, "kimi-k3 itself unaffected")
  })

  it("unknown model name warns once, not per request (IK5VGJ)", () => {
    const warns = []
    const orig = console.warn
    console.warn = (...a) => warns.push(a.join(" "))
    try {
      const name = `no-such-model-${Date.now()}`
      assert.equal(specForModel(name).context, 128_000)
      assert.equal(specForModel(name).context, 128_000)
      assert.equal(warns.length, 1, "warn exactly once per model name")
      assert.ok(warns[0].includes(name))
    } finally {
      console.warn = orig
    }
  })

  it("ctxPercentForModel divides by the REAL spec context (1M models, not 128K)", () => {
    // Regression: the status bar read a non-existent `contextWindow` field and
    // fell back to 128K — a 1M-context model at 175K tokens showed "137%".
    assert.equal(ctxPercentForModel(175_000, "deepseek-v4-pro"), 18)
    assert.equal(ctxPercentForModel(1_000_000, "deepseek-v4-pro"), 100)
    assert.equal(ctxPercentForModel(200_000, "deepseek-v4-pro"), 20)
    assert.equal(contextWindowForModel("deepseek-v4-pro"), 1_000_000)
  })

  it("ctxPercentForModel returns null without token data and 128K for unknown models", () => {
    assert.equal(ctxPercentForModel(0, "deepseek-v4-pro"), null)
    assert.equal(ctxPercentForModel(null, "deepseek-v4-pro"), null)
    assert.equal(ctxPercentForModel(64_000, `no-such-${Date.now()}`), 50)  // 128K default window
  })
})

// ─── Compaction ─────────────────────────────────────────────────

/** Local mock LLM server: returns a single SSE response with the given content.
 *  Captures request bodies into `requests` so tests can assert the serialization. */
function mockLLMServer(content = "这是摘要") {
  return import("node:http").then(({ createServer }) => {
    const requests = []
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        requests.push(body)
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
          `data: [DONE]\n\n`
        )
      })
    })
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }))
    })
  })
}

describe("compaction — threshold is model-aware", () => {
  it("does not compact below 60% of context", async () => {
    const cwd = setupTempDir()
    try {
      const messages = []
      // Create messages totaling ~50K estimated tokens for a 1M model
      for (let i = 0; i < 200; i++) {
        messages.push({ role: "user", content: `test ${i} `.repeat(40) })
        messages.push({ role: "assistant", content: `response ${i} `.repeat(30) })
      }

      // 1M model: threshold = 600K — 50K should not trigger
      const result = await compactHistory(messages, "system prompt", mockProvider("deepseek-v4-pro"))
      assert.equal(result, null, "50K tokens on 1M model should not compact")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("compacts when over threshold", async () => {
    const cwd = setupTempDir()
    const { server, port } = await mockLLMServer()
    try {
      const messages = []
      // Create many large messages to force compaction on default 128K model
      for (let i = 0; i < 600; i++) {
        messages.push({ role: "user", content: `test message number ${i} `.repeat(80) })
        messages.push({ role: "assistant", content: `response number ${i} `.repeat(60) })
      }

      // Default model = 128K, threshold = 76.8K. Large messages should trigger.
      const result = await compactHistory(
        messages, "system prompt",
        mockProvider("unknown-model", port),
      )
      assert.notEqual(result, null, "should trigger compaction")
      assert.ok(result.some((m) => m.content?.includes("compacted")), "should have compaction notice")
      assert.ok(result.some(m => m.role === "assistant"), "should have assistant ack")
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("preserves tool_call—tool_response pairing", async () => {
    const cwd = setupTempDir()
    const { server, port } = await mockLLMServer()
    try {
      // Create a conversation with tool calls at the boundary
      const messages = []
      for (let i = 0; i < 500; i++) {
        messages.push({ role: "user", content: `msg ${i} `.repeat(80) })
        messages.push({ role: "assistant", content: `resp ${i} `.repeat(60) })
      }
      // Add tool call + response pair at the end
      messages.push({
        role: "assistant",
        content: "let me check",
        tool_calls: [{ id: "tool_1", type: "function", function: { name: "read", arguments: "{}" } }],
      })
      messages.push({ role: "tool", tool_call_id: "tool_1", content: "file content here" })
      messages.push({ role: "assistant", content: "I see the file" })

      const result = await compactHistory(
        messages, "system prompt",
        mockProvider("unknown-model", port),
      )
      assert.notEqual(result, null, "should compact")
      // The tool response should be in the tail (not summarized)
      const hasToolResponse = result.some(
        m => m.role === "tool" && m.tool_call_id === "tool_1"
      )
      assert.ok(hasToolResponse, "tool response should survive compaction")
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("KEEP_HEAD=0: early tool_calls messages enter the serialization (no orphan tool messages)", async () => {
    const cwd = setupTempDir()
    const { server, port, requests } = await mockLLMServer()
    try {
      // KEEP_HEAD=0: the head is EMPTY — an early assistant with tool_calls (and its
      // tool response) both land in the middle and are serialized as TEXT with a
      // tool-name marker, not preserved as a raw pair (CLI parity — no orphan risk).
      const messages = [
        { role: "user", content: "最初需求" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "结果" },
      ]
      for (let i = 0; i < 500; i++) {
        messages.push({ role: "user", content: `msg ${i} `.repeat(80) })
        messages.push({ role: "assistant", content: `resp ${i} `.repeat(60) })
      }
      const result = await compactHistory(messages, "system prompt", mockProvider("unknown-model", port))
      assert.notEqual(result, null, "should compact")
      // The compaction note is the FIRST message (no verbatim head is kept)
      assert.match(result[0].content, /compacted/)
      // The early tool_calls pair entered the summary serialization with the tool-name marker
      assert.match(requests[0] ?? "", /\[assistant\] \[called tools: read\]/, "early tool_calls message must be serialized")
      // No orphan tool messages: every tool message still has its assistant caller
      const byId = new Map()
      for (const m of result) {
        if (m.role === "assistant" && m.tool_calls) for (const tc of m.tool_calls) byId.set(tc.id, true)
      }
      for (const m of result) {
        if (m.role === "tool") assert.ok(byId.has(m.tool_call_id), `orphan tool message: ${m.tool_call_id}`)
      }
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("multimodal message text is extracted into the serialization (CLI parity)", async () => {
    const cwd = setupTempDir()
    const { server, port, requests } = await mockLLMServer()
    try {
      const messages = [
        { role: "user", content: [{ type: "text", text: "看这张图并修复问题" }, { type: "image_url", image_url: { url: "data:image/png;base64,xx" } }] },
      ]
      for (let i = 0; i < 500; i++) {
        messages.push({ role: "user", content: `msg ${i} `.repeat(80) })
        messages.push({ role: "assistant", content: `resp ${i} `.repeat(60) })
      }
      const result = await compactHistory(messages, "system prompt", mockProvider("unknown-model", port))
      assert.notEqual(result, null, "should compact")
      assert.match(requests[0] ?? "", /看这张图并修复问题/, "multimodal text part must survive into the summary serialization")
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("pure-estimation path counts the tools schema overhead (CLI parity)", async () => {
    const cwd = setupTempDir()
    const { server, port } = await mockLLMServer()
    try {
      const messages = []
      for (let i = 0; i < 14; i++) messages.push({ role: "user", content: `m${i} ` + "x".repeat(4) })
      // ~28 history + ~15 system tokens is far below the explicit threshold 500…
      const noTrigger = await compactHistory(messages, "system prompt", mockProvider("unknown-model", port), 500)
      assert.equal(noTrigger, null, "without the schema overhead the estimate stays below threshold")
      // …but a large tools schema pushes the pure-estimation total over it.
      const bigSchema = Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}_` + "x".repeat(300), parameters: { type: "object" } }))
      const result = await compactHistory(messages, "system prompt", mockProvider("unknown-model", port), 500, null, bigSchema)
      assert.notEqual(result, null, "tools schema overhead must trigger compaction")
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("abort signal cancels the in-flight summary request (Stop must not wait)", async () => {
    const { createServer } = await import("node:http")
    // A server that accepts but NEVER responds — simulates a slow summarization model.
    const hanging = createServer(() => {})
    await new Promise((r) => hanging.listen(0, "127.0.0.1", r))
    try {
      const port = hanging.address().port
      const messages = []
      for (let i = 0; i < 600; i++) {
        messages.push({ role: "user", content: `test ${i} `.repeat(80) })
        messages.push({ role: "assistant", content: `resp ${i} `.repeat(60) })
      }
      const ctrl = new AbortController()
      const p = compactHistory(messages, "system", mockProvider("unknown-model", port), 500, null, null, ctrl.signal)
      await new Promise((r) => setTimeout(r, 80))  // let the request reach the server
      ctrl.abort()
      const t0 = Date.now()
      await assert.rejects(p, (e) => e.name === "AbortError", "abort must reject with AbortError")
      assert.ok(Date.now() - t0 < 2000, "abort must cancel the request immediately, not wait for the summary")
    } finally {
      hanging.close()
    }
  })

  it("handles empty history gracefully", async () => {
    const result = await compactHistory([], "system", mockProvider())
    assert.equal(result, null)
  })

  it("handles single message gracefully", async () => {
    const result = await compactHistory(
      [{ role: "user", content: "hi" }],
      "system",
      mockProvider(),
    )
    assert.equal(result, null)
  })

  it("no provider throws — caller degrades via truncateFallback (heuristic summary deprecated)", async () => {
    const cwd = setupTempDir()
    try {
      const messages = []
      for (let i = 0; i < 600; i++) {
        messages.push({ role: "user", content: `test ${i} `.repeat(80) })
        messages.push({ role: "assistant", content: `resp ${i} `.repeat(60) })
      }
      await assert.rejects(
        () => compactHistory(messages, "system", null),
        /no provider available/,
        "null provider must throw so the caller can count failures and degrade",
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("measured baseline triggers compaction even when estimation is below threshold", async () => {
    const cwd = setupTempDir()
    const { server, port } = await mockLLMServer()
    try {
      const messages = []
      for (let i = 0; i < 14; i++) {
        messages.push({ role: "user", content: `m${i} ` + "x".repeat(4) }) // ~28 tokens total
      }
      // Pure estimation (~28 + system) is far below threshold 500 — but the measured
      // baseline 10_000 + appended messages exceeds it, so compaction must trigger.
      const result = await compactHistory(messages, "system prompt", mockProvider("unknown-model", port), 500, {
        lastPromptTokens: 10_000,
        usageAtLen: 0,
      })
      assert.notEqual(result, null, "measured baseline must trigger compaction")
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("truncateFallback drops the middle deterministically (no LLM call)", () => {
    const history = []
    for (let i = 0; i < 40; i++) {
      history.push({ role: "user", content: `消息 ${i}` })
      history.push({ role: "assistant", content: `回复 ${i}` })
    }
    const out = truncateFallback(history, mockProvider("deepseek-v4-pro"))
    assert.ok(out, "should truncate")
    assert.ok(out.length < history.length, "result must be shorter")
    // KEEP_HEAD=0: the blunt note is the FIRST message — no verbatim head is kept
    assert.match(out[0].content, /truncated/)
    assert.ok(!out.some((m) => m.content.includes("消息 0")), "earliest message is NOT kept verbatim (KEEP_HEAD=0)")
    assert.ok(out.some((m) => m.content.includes("回复 39")), "tail kept")
  })

  it("shrinkOversized truncates a single giant user/tool message body", () => {
    const history = [
      { role: "user", content: "需求" },
      { role: "user", content: "开".repeat(60_000) },
      { role: "assistant", content: "收到" },
      { role: "tool", tool_call_id: "c1", content: "结果 " + "y".repeat(20_000) },
      { role: "user", content: "继续" },
    ]
    const out = shrinkOversized(history)
    assert.ok(out, "should shrink")
    assert.ok(out[1].content.length < 7_000, "giant user message truncated")
    assert.ok(out[1].content.includes("truncated"), "stub marker present")
    assert.equal(out[3].tool_call_id, "c1", "tool_call_id untouched (no protocol 400 risk)")
    assert.ok(out[3].content.length < 7_000, "giant tool result truncated")
  })

  it("401 with sk-kimi- key hints at the Kimi two-platform mismatch (IK5VGJ)", async () => {
    const { chat } = await import("../src/provider.mjs")
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: "invalid api key" } }),
    })
    try {
      // Kimi For Coding key on a non-kimi endpoint → hint appended
      await assert.rejects(
        () => chat({ baseURL: "https://api.moonshot.cn/v1", apiKey: "sk-kimi-abc", model: "k3" }, {
          messages: [{ role: "user", content: "hi" }],
        }),
        /Kimi|Moonshot/,
        "401 with sk-kimi- key must hint at the two-platform mismatch",
      )
      // Plain key on a plain endpoint → bare message preserved
      const err = await chat({ baseURL: "https://api.other.com/v1", apiKey: "sk-abc", model: "m" }, {
        messages: [{ role: "user", content: "hi" }],
      }).then(() => null, (e) => e)
      assert.ok(!/tip: Kimi/.test(err.message), "non-Kimi 401 keeps the bare message")
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

// ─── Tool execution edge cases ──────────────────────────────────

describe("tool edge cases", () => {
  it("read tool throws for nonexistent file", async () => {
    const { readTool } = await import("../src/tools/file.mjs")
    const cwd = setupTempDir()
    try {
      await assert.rejects(
        () => readTool.execute(
          { path: "nonexistent.txt" },
          { cwd, agent: {}, callbacks: {}, signal: undefined },
        ),
        (err) => err.code === "ENOENT" || err.message?.includes("no such file"),
        "should throw ENOENT",
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("read tool reads existing file", async () => {
    const { readTool } = await import("../src/tools/file.mjs")
    const cwd = setupTempDir()
    try {
      writeFileSync(join(cwd, "hello.txt"), "Hello, World!")
      const result = await readTool.execute(
        { path: "hello.txt" },
        { cwd, agent: {}, callbacks: {}, signal: undefined },
      )
      assert.ok(typeof result === "string")
      assert.ok(result.includes("Hello, World!"), "should contain file content")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("bash tool with invalid command returns error", async () => {
    const { bashTool } = await import("../src/tools/shell.mjs")
    const result = await bashTool.execute(
      { command: "nonexistent_command_xyz_123" },
      { cwd: process.cwd(), agent: {}, callbacks: {}, signal: undefined },
    )
    assert.ok(typeof result === "string")
    // Should contain some output (error message or exit code)
    assert.ok(result.length > 0, "should return output even for failed commands")
  })

  it("bash tool with valid command returns output", async () => {
    const { bashTool } = await import("../src/tools/shell.mjs")
    const cmd = process.platform === "win32" ? "echo hello" : "echo hello"
    const result = await bashTool.execute(
      { command: cmd },
      { cwd: process.cwd(), agent: {}, callbacks: {}, signal: undefined },
    )
    assert.ok(typeof result === "string")
    assert.ok(result.includes("hello"), "should contain echo output: " + result.slice(0, 50))
  })
})

describe("pending-task pushback fires at most once (CLI parity)", () => {
  it("one reminder per task-list state, then the model finishes", async () => {
    const http = await import("node:http")
    const { runAgent } = await import("../src/agent.mjs")
    const cwd = setupTempDir()
    const taskArgs = JSON.stringify({ items: [{ title: "T1", status: "pending" }] })
    const responses = [
      // Turn 1: model creates a pending task via the task tool
      [
        { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "task", arguments: taskArgs } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ],
      // Turn 2: model declares done → first pushback
      [
        { choices: [{ index: 0, delta: { content: "done" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ],
      // Turn 3: model declares done again → allowed to finish
      [
        { choices: [{ index: 0, delta: { content: "done" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ],
    ]
    const server = http.createServer((req, res) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        const chunks = responses.shift() ?? []
        res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n")
      })
    })
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const port = server.address().port
    const history = []
    try {
      const result = await runAgent(
        mockProvider("deepseek-v4-pro", port), cwd, "do it", {}, undefined, true,
        { history, fullHistory: [] },
      )
      assert.equal(result, "done", "final reply surfaces")
      const reminders = history.filter((m) => typeof m.content === "string" && m.content.includes("you still have pending tasks"))
      assert.equal(reminders.length, 1, "pushed back exactly once: " + JSON.stringify(reminders))
      assert.ok(reminders[0].content.includes("only reminder"), "copy says it is the only reminder")
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// ─── Advisor guard loop pushback (CLI parity, 2026-08-21) ─────────────
// The guard logic is INLINE in runAgent's loop (agent.mjs) — these tests drive
// the real loop through a scripted SSE server, so the extension's own copy of
// the pushback condition is covered without depending on the CLI side.

/** Scripted SSE server: serves `responses` (one chunk array per request) in order. */
async function scriptedServer(responses) {
  const http = await import("node:http")
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunks = responses.shift() ?? []
      res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n")
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  return { server, port: server.address().port }
}

/** Turn that mutates code: one `write` tool call into src/ (triggers _mutatedThisRun + hasCodeMutations). */
function writeTurnChunks(file = "src/a.mjs") {
  const args = JSON.stringify({ path: file, content: "export const x = 1\n" })
  return [
    { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: args } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]
}

/** Turn that declares done with no tool calls (end-of-run attempt). */
function doneTurnChunks() {
  return [
    { choices: [{ index: 0, delta: { content: "done" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]
}

const ADVISOR_REMINDER = "MUST get an advisor review"

describe("advisor guard loop pushback (2026-08-21 semantic refactor)", () => {
  let cfgDir

  before(() => {
    cfgDir = mkdtempSync(join(tmpdir(), "thincoder-guard-"))
    _setConfigPathForTest(join(cfgDir, "config.json"))
  })

  after(() => {
    _setConfigPathForTest(null)
    rmSync(cfgDir, { recursive: true, force: true })
  })

  function setAdvisorConfig(advisor) {
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ agent: { advisor } }))
  }

  it("guard default OFF: advisor {} + code mutation finishes without pushback", async () => {
    setAdvisorConfig({})
    const cwd = setupTempDir()
    const { server, port } = await scriptedServer([writeTurnChunks(), doneTurnChunks()])
    const history = []
    try {
      const { runAgent } = await import("../src/agent.mjs")
      const result = await runAgent(mockProvider("deepseek-v4-pro", port), cwd, "do it", {}, undefined, true, { history, fullHistory: [] })
      assert.equal(result, "done", "run finishes normally")
      const reminders = history.filter((m) => typeof m.content === "string" && m.content.includes(ADVISOR_REMINDER))
      assert.equal(reminders.length, 0, "no advisor reminder when guard is absent: " + JSON.stringify(reminders))
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("guard ON: advisor { guard: true } + code mutation without review is pushed back, then converges", async () => {
    setAdvisorConfig({ guard: true })
    const cwd = setupTempDir()
    // tool-call turn + (MAX_ADVISOR_PUSHBACKS pushbacks + 1 final acceptance) "done" turns
    const responses = [writeTurnChunks(), ...Array.from({ length: MAX_ADVISOR_PUSHBACKS + 1 }, doneTurnChunks)]
    const { server, port } = await scriptedServer(responses)
    const history = []
    try {
      const { runAgent } = await import("../src/agent.mjs")
      const result = await runAgent(mockProvider("deepseek-v4-pro", port), cwd, "do it", {}, undefined, true, { history, fullHistory: [] })
      assert.equal(result, "done", "the loop converges once the pushback budget is exhausted")
      const reminders = history.filter((m) => typeof m.content === "string" && m.content.includes(ADVISOR_REMINDER))
      assert.equal(reminders.length, MAX_ADVISOR_PUSHBACKS, "pushed back exactly MAX_ADVISOR_PUSHBACKS times: " + JSON.stringify(reminders))
      assert.ok(reminders[0].content.includes("round 1"), "first reminder names round 1 (advisorRound starts at 0)")
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("engineering mode exemption: guard: true + engineering with design token finishes without pushback", async () => {
    setAdvisorConfig({ guard: true })
    const cwd = setupTempDir()
    const { server, port } = await scriptedServer([writeTurnChunks(), doneTurnChunks()])
    const history = []
    try {
      const { runAgent } = await import("../src/agent.mjs")
      const result = await runAgent(
        mockProvider("deepseek-v4-pro", port), cwd, "do it", {}, undefined, true,
        { history, fullHistory: [], engState: { enabled: true, engDesignToken: "test-token" } },
      )
      assert.equal(result, "done", "engineering mode finishes normally")
      const reminders = history.filter((m) => typeof m.content === "string" && m.content.includes(ADVISOR_REMINDER))
      assert.equal(reminders.length, 0, "engineering mode is exempt from the advisor guard: " + JSON.stringify(reminders))
      // The write went through (design token present) — the mutation really happened,
      // so the absence of a pushback proves the exemption, not a failed mutation.
      assert.ok(existsSync(join(cwd, "src", "a.mjs")), "code mutation landed on disk")
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("legacy enabled does not trigger: advisor { enabled: true } finishes without pushback", async () => {
    setAdvisorConfig({ enabled: true })
    const cwd = setupTempDir()
    const { server, port } = await scriptedServer([writeTurnChunks(), doneTurnChunks()])
    const history = []
    try {
      const { runAgent } = await import("../src/agent.mjs")
      const result = await runAgent(mockProvider("deepseek-v4-pro", port), cwd, "do it", {}, undefined, true, { history, fullHistory: [] })
      assert.equal(result, "done", "run finishes normally")
      const reminders = history.filter((m) => typeof m.content === "string" && m.content.includes(ADVISOR_REMINDER))
      assert.equal(reminders.length, 0, "deprecated enabled field is not read anymore: " + JSON.stringify(reminders))
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// ─── Prompt borrowing increments (kimi-code comparison, 2026-08-21) ───
// 两端 src/prompts/ 必须 byte-identical（项目铁律）；①—③ 在本端断言内容，
// 两端 15 文件比对断言在 CLI 侧（thincoder/test/agent.test.mjs）。

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "prompts")

describe("prompt borrowing increments (kimi-code comparison)", () => {
  it("explore.md: Thoroughness levels — three levels with default", () => {
    const text = readFileSync(join(PROMPTS_DIR, "explore.md"), "utf8")
    assert.ok(text.includes("Thoroughness levels"), "section header present")
    const lines = text.split("\n")
    assert.ok(lines.some((l) => l.trim().startsWith("- quick")), "quick level present")
    const medium = lines.find((l) => /^- medium/.test(l.trim()))
    assert.ok(medium, "medium level present")
    assert.ok(/default/i.test(medium), `medium marked as default: ${medium}`)
    const thorough = lines.find((l) => /^- thorough/.test(l.trim()))
    assert.ok(thorough, "thorough level present")
    assert.ok(/NOT find/i.test(thorough), `thorough requires reporting what was not found: ${thorough}`)
  })

  it("main.md: Delegate well includes thoroughness guidance for explore delegation", () => {
    const text = readFileSync(join(PROMPTS_DIR, "main.md"), "utf8")
    assert.ok(text.includes("quick / medium / thorough"), "three levels named in main.md")
    assert.match(text, /Delegate well[\s\S]*thoroughness/, "guidance sits in the Delegate well section")
  })

  it("system.md: confirmation sentence names the most important acceptance criteria", () => {
    const text = readFileSync(join(PROMPTS_DIR, "system.md"), "utf8")
    const line = text.split("\n").find((l) => l.includes("Confirm understanding"))
    assert.ok(line, "Confirm understanding sentence exists")
    assert.ok(line.includes("most important acceptance criteria"), line)
    assert.ok(line.includes("Wait for confirmation"), "rest of the sentence preserved")
  })
})

// ─── Pre-work plan confirmation discipline (2026-08-21) ───

describe("pre-work plan confirmation discipline", () => {
  it("system.md: no-exemption confirmation discipline — file-writing tool list + explicit confirmation gate", () => {
    const text = readFileSync(join(PROMPTS_DIR, "system.md"), "utf8")
    assert.ok(/write \/ edit \/ apply_patch \/ insert_after \/ delete \/ hashline_edit/.test(text), "file-writing tool list present")
    assert.ok(/no exemptions/i.test(text), "no-exemption wording present")
    assert.ok(text.includes("obvious enough to skip"), "self-exemption excuse explicitly blocked")
    assert.ok(text.includes("a new question from the user is not a confirmation"), "a new user question is not a confirmation")
    assert.ok(text.includes("Re-confirm when the requirement changes"), "re-confirm on requirement change present")
  })

  it("engineering.md: plan confirmation before writing docs (no exemptions)", () => {
    const text = readFileSync(join(PROMPTS_DIR, "engineering.md"), "utf8")
    assert.ok(/Plan confirmation before writing any doc/i.test(text), "clause heading present")
    assert.ok(text.includes("before writing the requirements doc"), "confirmation before writing requirements/design docs")
    assert.ok(text.includes("no exemptions"), "no-exemption wording present")
    assert.ok(text.includes("obvious enough to skip"), "self-exemption excuse explicitly blocked")
  })
})
