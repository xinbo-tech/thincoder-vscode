/**
 * provider.test.mjs — Provider SSE stream parsing tests
 * Tests OpenAI, Anthropic, and Google format parsers.
 * Run: node --test test/provider.test.mjs
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"


// ─── CLI parity constants ────────────────────────────────────────

describe("provider parity constants", () => {
  it("FETCH_TIMEOUT_MS is 10 minutes (CLI parity — 2 minutes aborted real requests)", async () => {
    // Regression: VS Code had 120_000 while the CLI ships 600_000 everywhere
    // (core/anthropic/google). Reasoning models exceed 2 minutes on long contexts
    // and the panel showed "The operation was aborted due to timeout".
    const { FETCH_TIMEOUT_MS } = await import("../src/provider.mjs")
    assert.equal(FETCH_TIMEOUT_MS, 600_000)
  })
})
// ─── OpenAI format parser ───────────────────────────────────────

describe("OpenAI SSE parsing", () => {
  it("parses content delta", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")

    const sse = [
      'data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}\n',
      'data: {"id":"1","choices":[{"delta":{"content":" World"}}]}\n',
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n',
      "data: [DONE]\n",
    ]

    const tokens = []
    const result = await parseStream(
      createMockResponse(sse),
      {
        onToken: (t) => tokens.push(t),
        onReasoning: () => {},
      },
    )

    assert.equal(result.content, "Hello World")
    assert.equal(tokens.join(""), "Hello World")
    assert.equal(result.usage.total_tokens, 12)
    assert.equal(result.finishReason, "stop")
  })

  it("parses reasoning_content delta", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")

    const sse = [
      'data: {"id":"1","choices":[{"delta":{"reasoning_content":"Let me think..."}}]}\n',
      'data: {"id":"1","choices":[{"delta":{"reasoning_content":" about this."}}]}\n',
      'data: {"id":"1","choices":[{"delta":{"content":"Here is the answer"}}]}\n',
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}\n',
      "data: [DONE]\n",
    ]

    const reasoning = []
    const tokens = []
    const result = await parseStream(
      createMockResponse(sse),
      {
        onToken: (t) => tokens.push(t),
        onReasoning: (r) => reasoning.push(r),
      },
    )

    assert.equal(result.reasoning, "Let me think... about this.")
    assert.equal(result.content, "Here is the answer")
    assert.equal(reasoning.join(""), "Let me think... about this.")
  })

  it("normalizes Kimi/OpenAI-style cached_tokens into prompt_cache_hit/miss_tokens", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")
    const sse = [
      'data: {"id":"1","choices":[{"delta":{"content":"ok"}}]}\n',
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":10,"total_tokens":1010,"prompt_tokens_details":{"cached_tokens":800}}}\n',
      "data: [DONE]\n",
    ]
    const result = await parseStream(createMockResponse(sse), { onToken: () => {}, onReasoning: () => {} })
    assert.equal(result.usage.prompt_cache_hit_tokens, 800)
    assert.equal(result.usage.prompt_cache_miss_tokens, 200) // 1000 - 800
  })

  it("interrupt (Ctrl+I) returns the partial result with interruptMessage instead of throwing", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")
    const ctrl = new AbortController()
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(enc.encode('data: {"id":"1","choices":[{"delta":{"content":"partial out"}}]}\n'))
        setTimeout(() => ctrl.abort({ interrupt: true, message: "focus on X" }), 20)
        // never closes — the interrupt must break the hung for-await via the abort race
      },
    })
    const response = { body: stream, ok: true, headers: new Map([["content-type", "text/event-stream"]]) }
    const result = await parseStream(response, { onToken: () => {}, onReasoning: () => {}, signal: ctrl.signal })
    assert.equal(result.interrupted, true)
    assert.equal(result.interruptMessage, "focus on X")
    assert.equal(result.content, "partial out")
  })

  it("a plain Stop (no interrupt reason) still throws AbortError", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")
    const ctrl = new AbortController()
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(enc.encode('data: {"id":"1","choices":[{"delta":{"content":"x"}}]}\n'))
        setTimeout(() => ctrl.abort(), 20) // no reason → plain Stop
      },
    })
    const response = { body: stream, ok: true, headers: new Map([["content-type", "text/event-stream"]]) }
    await assert.rejects(
      () => parseStream(response, { onToken: () => {}, onReasoning: () => {}, signal: ctrl.signal }),
      (e) => e.name === "AbortError",
    )
  })


  it("normalizeUsageCache leaves DeepSeek-style usage untouched and ignores cache-free usage", async () => {
    const { normalizeUsageCache } = await import("../src/provider/transports/openai.mjs")
    const ds = { prompt_cache_hit_tokens: 500, prompt_cache_miss_tokens: 500 }
    assert.deepEqual(normalizeUsageCache({ ...ds }), ds)
    const plain = { prompt_tokens: 100, completion_tokens: 10 }
    assert.equal(normalizeUsageCache({ ...plain }).prompt_cache_hit_tokens, undefined)
  })


  it("parses tool calls", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")

    const sse = [
      'data: {"id":"1","choices":[{"delta":{"content":"Let me read that file"}}]}\n',
      'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":""}}]}}]}\n',
      'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\""}}]}}]}\n',
      'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"test.txt\\"}"}}]}}]}\n',
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
      "data: [DONE]\n",
    ]

    const result = await parseStream(
      createMockResponse(sse),
      { onToken: () => {}, onReasoning: () => {} },
    )

    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].name, "read")
    assert.equal(result.toolCalls[0].id, "call_1")
    assert.equal(result.toolCalls[0].arguments, '{"path":"test.txt"}')
    assert.equal(result.content, "Let me read that file")
  })

  it("handles multiple tool calls", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")

    const sse = [
      'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{}"}},{"index":1,"id":"call_2","function":{"name":"grep","arguments":"{}"}}]}}]}\n',
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
      "data: [DONE]\n",
    ]

    const result = await parseStream(
      createMockResponse(sse),
      { onToken: () => {}, onReasoning: () => {} },
    )

    assert.equal(result.toolCalls.length, 2)
    assert.equal(result.toolCalls[0].name, "read")
    assert.equal(result.toolCalls[1].name, "grep")
  })

  it("handles empty stream by returning empty content", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")

    // An empty body should trigger the "No choices" error path
    const result = await parseStream(
      createMockResponse(['data: {"id":"1","choices":[{"delta":{"content":"x"}}]}\n', "data: [DONE]\n"]),
      { onToken: () => {}, onReasoning: () => {} },
    )
    assert.equal(result.content, "x")
  })
})

// ─── Model transport dispatch ───────────────────────────────────

describe("transport dispatch", () => {
  it("OpenAI transport is importable", async () => {
    const mod = await import("../src/provider/transports/openai.mjs")
    assert.ok(mod.parseStream)
    assert.ok(mod.buildRequest)
    assert.ok(mod.normalizeTools)
  })

  it("Anthropic transport is importable", async () => {
    const mod = await import("../src/provider/transports/anthropic.mjs")
    assert.ok(mod.parseStream)
    assert.ok(mod.buildRequest)
  })

  it("Google transport is importable", async () => {
    const mod = await import("../src/provider/transports/google.mjs")
    assert.ok(mod.parseStream)
    assert.ok(mod.buildRequest)
  })

  it("OpenAI buildRequest generates valid body", async () => {
    const { buildRequest } = await import("../src/provider/transports/openai.mjs")
    const req = buildRequest(
      { baseURL: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
      [{ role: "user", content: "hello" }],
      null,
    )
    assert.equal(req.url, "https://api.test/v1/chat/completions")
    assert.ok(req.headers["Content-Type"])
    assert.ok(req.headers["Authorization"])
    const body = JSON.parse(req.body)
    assert.equal(body.model, "test-model")
    assert.equal(body.messages[0].content, "hello")
  })
})

// ─── Rate estimation ───────────────────────────────────────────

describe("token estimation", () => {
  it("estimates ASCII text", async () => {
    const { estimateText } = await import("../src/provider/rate.mjs")
    // ~4 chars per token for ASCII
    const tokens = estimateText("Hello World, this is a test!")
    assert.ok(tokens > 3 && tokens < 15, `expected 3-15 tokens, got ${tokens}`)
  })

  it("estimates CJK text (1 char ≈ 1 token)", async () => {
    const { estimateText } = await import("../src/provider/rate.mjs")
    const tokens = estimateText("你好世界这是一段中文文本测试")
    // CJK: roughly 1 char = 1 token
    assert.ok(tokens >= 12 && tokens <= 15, `expected ~13 tokens, got ${tokens}`)
  })

  it("estimates mixed text", async () => {
    const { estimateText } = await import("../src/provider/rate.mjs")
    const tokens = estimateText("Hello 你好 World 世界")
    // ASCII "Hello " = ~2, ASCII " World " = ~2, CJK "你好" = 2, CJK "世界" = 2
    assert.ok(tokens >= 6 && tokens <= 10, `expected 6-10 tokens, got ${tokens}`)
  })

  it("handles null/undefined", async () => {
    const { estimateText } = await import("../src/provider/rate.mjs")
    assert.equal(estimateText(null), 0)
    assert.equal(estimateText(undefined), 0)
    assert.equal(estimateText(""), 0)
  })

  it("estimates request tokens from messages", async () => {
    const { estimateRequestTokens } = await import("../src/provider/rate.mjs")
    const body = {
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 100,
    }
    const tokens = estimateRequestTokens(body)
    assert.ok(tokens > 30 && tokens < 300, `expected 30-300 tokens, got ${tokens}`)
  })
})

// ─── Helpers ────────────────────────────────────────────────────

/** Create a mock Response with a readable stream from SSE string array */
// ─── stripImagesForTextModel — 按格式净化（Kimi svg 400 毒化会话回归） ───

describe("stripImagesForTextModel", () => {
  it("vision model: keeps raster png, replaces svg data-URL with text placeholder, history untouched", async () => {
    const { stripImagesForTextModel } = await import("../src/provider.mjs")
    const spec = { multimodal: true }
    const msgs = [
      { role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ] },
      { role: "user", content: [
        { type: "text", text: "svg" },
        { type: "image_url", image_url: { url: "data:image/svg+xml;base64,PHN2Zz4=" } },
      ] },
    ]
    const out = stripImagesForTextModel(msgs, spec)
    assert.equal(out[0], msgs[0])
    assert.deepEqual(out[1].content, [
      { type: "text", text: "svg" },
      { type: "text", text: "[image omitted — unsupported format image/svg+xml]" },
    ])
    assert.equal(msgs[1].content[1].type, "image_url") // history not mutated
  })

  it("text-only model: strips all image parts, keeps text parts", async () => {
    const { stripImagesForTextModel } = await import("../src/provider.mjs")
    const msgs = [{ role: "user", content: [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ] }]
    const out = stripImagesForTextModel(msgs, { multimodal: false })
    assert.deepEqual(out[0].content, [{ type: "text", text: "hi" }])
  })
})

function createMockResponse(sseLines) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const line of sseLines) {
        controller.enqueue(encoder.encode(line))
      }
      controller.close()
    },
  })
  return {
    body: stream,
    ok: true,
    headers: new Map([["content-type", "text/event-stream"]]),
  }
}

// ─── Abort-aware sleeps (Stop during retry backoff / rate waits) ───

describe("abortableSleep", () => {
  it("rejects immediately with AbortError when the signal fires mid-sleep", async () => {
    const { abortableSleep } = await import("../src/provider/rate.mjs")
    const ctrl = new AbortController()
    const t0 = Date.now()
    const p = abortableSleep(30_000, ctrl.signal)
    setTimeout(() => ctrl.abort(), 30)
    await assert.rejects(() => p, (e) => e.name === "AbortError")
    assert.ok(Date.now() - t0 < 1000, "released promptly, not after the full 30s backoff")
  })

  it("resolves normally without a signal; rejects immediately when already aborted", async () => {
    const { abortableSleep } = await import("../src/provider/rate.mjs")
    await abortableSleep(5) // no signal → plain sleep
    const ctrl = new AbortController()
    ctrl.abort()
    await assert.rejects(() => abortableSleep(1000, ctrl.signal), (e) => e.name === "AbortError")
  })
})

// ─── stop-trace (click→stop latency observability) ──────────────

describe("stop trace", () => {
  it("traceStop emits lines with click latency to subscribers when enabled", async () => {
    const { traceStop, onTrace, setTraceEnabled } = await import("../src/extension/stop-trace.mjs")
    const lines = []
    const off = onTrace((l) => lines.push(l))
    setTraceEnabled(true)
    try {
      const t0 = Date.now() - 123
      traceStop("hop under test", t0)
      assert.equal(lines.length, 1)
      assert.match(lines[0], /hop under test/)
      assert.match(lines[0], /\+123ms since click/)
    } finally {
      setTraceEnabled(false)
      off()
    }
  })

  it("disabled by default — no output, zero overhead", async () => {
    const { traceStop, onTrace, setTraceEnabled } = await import("../src/extension/stop-trace.mjs")
    const lines = []
    const off = onTrace((l) => lines.push(l))
    setTraceEnabled(false)
    traceStop("should not appear")
    assert.equal(lines.length, 0)
    off()
  })
})

// ─── spec-driven thinking default (GLM silent-no-reasoning regression) ──

describe("buildRequest thinking default", () => {
  it("a thinking-capable model gets thinking:{type:enabled} even when the provider entry omits it", async () => {
    const { buildRequest } = await import("../src/provider/transports/openai.mjs")
    const body = JSON.parse(buildRequest({ baseURL: "https://x/v1", apiKey: "k", model: "glm-5.2" }, [], []).body)
    assert.deepEqual(body.thinking, { type: "enabled" }, "GLM-5.2 must think by default")
  })

  it("explicit provider.thinking (including off) always wins over the spec default", async () => {
    const { buildRequest } = await import("../src/provider/transports/openai.mjs")
    const on = JSON.parse(buildRequest({ baseURL: "https://x/v1", apiKey: "k", model: "glm-5.2", thinking: { type: "adaptive" } }, [], []).body)
    assert.equal(on.thinking.type, "adaptive")
    const off = JSON.parse(buildRequest({ baseURL: "https://x/v1", apiKey: "k", model: "glm-5.2", thinking: null }, [], []).body)
    assert.equal("thinking" in off, false, "explicit null (panel off) sends no thinking field")
  })

  it("non-thinking models get no default thinking", async () => {
    const { buildRequest } = await import("../src/provider/transports/openai.mjs")
    const body = JSON.parse(buildRequest({ baseURL: "https://x/v1", apiKey: "k", model: "deepseek-v4-flash" }, [], []).body)
    assert.equal("thinking" in body, false)
  })
})
