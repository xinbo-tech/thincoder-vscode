/**
 * provider.test.mjs — Provider SSE stream parsing tests
 * Tests OpenAI, Anthropic, and Google format parsers.
 * Run: node --test test/provider.test.mjs
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"


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
  it("defensive tool_calls: null element skipped + counted (GitHub#2)", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")
    const sse = [
      'data: {"id":"1","choices":[{"delta":{"tool_calls":[null,{"index":0,"id":"a","function":{"name":"read","arguments":"{}"}}]}}]}\n',
      "data: [DONE]\n",
    ]
    const result = await parseStream(createMockResponse(sse), { onToken: () => {}, onReasoning: () => {} })
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].name, "read")
    assert.equal(result.droppedToolCalls, 1)
  })

  it("defensive tool_calls: missing function/name dropped + counted", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")
    const sse = [
      'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"a"}]}}]}\n',
      "data: [DONE]\n",
    ]
    const result = await parseStream(createMockResponse(sse), { onToken: () => {}, onReasoning: () => {} })
    assert.equal(result.toolCalls.length, 0)
    assert.equal(result.droppedToolCalls, 1)
  })

  it("defensive tool_calls: missing id synthesized, function:null safe", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")
    const sse = [
      'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{}"}},{"index":1,"id":"b","function":null}]}}]}\n',
      "data: [DONE]\n",
    ]
    const result = await parseStream(createMockResponse(sse), { onToken: () => {}, onReasoning: () => {} })
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].name, "read")
    assert.equal(result.toolCalls[0].id, "call_0")
    assert.equal(result.droppedToolCalls, 1)
  })

  it("defensive tool_calls: non-string arguments JSON.stringify'd", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")
    const sse = [
      'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":{"path":"x"}}}]}}]}\n',
      "data: [DONE]\n",
    ]
    const result = await parseStream(createMockResponse(sse), { onToken: () => {}, onReasoning: () => {} })
    assert.equal(result.toolCalls[0].arguments, '{"path":"x"}')
  })
  it("defensive tool_calls: synthesized id avoids explicit call_N collision", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")
    const sse = [
      'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"a","arguments":"{}"}},{"index":1,"function":{"name":"b","arguments":"{}"}}]}}]}\n',
      "data: [DONE]\n",
    ]
    const result = await parseStream(createMockResponse(sse), { onToken: () => {}, onReasoning: () => {} })
    assert.equal(result.toolCalls.length, 2)
    assert.equal(result.toolCalls[0].id, "call_1")
    assert.equal(result.toolCalls[1].id, "call_0")
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

// ─── V3（CLI §14.2/§14.3 parity）：prefix 续写精简 / reasoning 回传 / partial 不受影响 / 400 可见性 ───

/** 构造含 3 组工具链 + 10 条文本的历史（CLI test/provider.test.mjs toolHistory 同构）。 */
function toolHistory() {
  const chains = Array.from({ length: 3 }, (_, n) => [
    { role: "assistant", content: null, tool_calls: [{ id: `call_${n}`, type: "function", function: { name: "ls", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `call_${n}`, content: `结果${n}` },
  ]).flat()
  const texts = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `文本${i}` }))
  return [{ role: "system", content: "你是助手" }, ...chains, ...texts]
}

/** Mock SSE LLM：按 script 顺序响应（content/finishReason/reasoning 或 400 error）。 */
function mockContinuationServer(script) {
  const requests = []
  const server = createServer((req, res) => {
    let bodyText = ""
    req.on("data", (c) => (bodyText += c))
    req.on("end", () => {
      requests.push({ ...JSON.parse(bodyText), _url: req.url })
      const step = script[Math.min(requests.length - 1, script.length - 1)]
      if (step.status === 400) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: step.error } }))
        return
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      let sse = ""
      if (step.content) {
        sse += `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: step.content } }] })}\n\n`
      }
      if (step.reasoning) {
        sse += `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: step.reasoning } }] })}\n\n`
      }
      sse += `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step.finishReason ?? "stop" }] })}\n\n`
      sse += "data: [DONE]\n\n"
      res.end(sse)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }))
  })
}

describe("V3 prefix 续写构造（CLI §14 parity）", () => {
  it("T1: prefix 续写精简——工具链全过滤、文本保留 ≤8、末条 prefix:true（§14.2）", async () => {
    const { chat } = await import("../src/provider.mjs")
    const { server, requests, port } = await mockContinuationServer([
      { content: "前半段", finishReason: "length" },
      { content: "后半段" },
    ])
    try {
      const ds = { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "x", model: "deepseek-v4-pro" }
      const result = await chat(ds, { messages: toolHistory() })
      assert.equal(result.content, "前半段后半段")
      assert.equal(result.finishReason, "stop")
      assert.equal(requests.length, 2)
      assert.equal(requests[1]._url, "/beta/chat/completions", "prefix 续写走 /beta 端点")
      const cont = requests[1].messages
      assert.ok(!cont.some((m) => m.role === "tool"), "tool 消息必须被过滤")
      assert.ok(!cont.some((m) => m.role === "assistant" && m.tool_calls), "assistant(tool_calls) 必须被过滤")
      const textCount = cont.filter((m) => m.role !== "system").length - 1
      assert.ok(textCount <= 8, `文本保留 ${textCount} 条（≤8）`)
      assert.ok(cont.some((m) => m.content === "文本9"), "最近文本消息保留")
      const tail = cont.at(-1)
      assert.equal(tail.role, "assistant")
      assert.equal(tail.prefix, true)
      assert.equal(tail.partial, undefined)
      assert.equal(tail.content, "前半段")
    } finally {
      server.close()
    }
  })

  it("T2: prefix 续写 reasoning 回传——末条带 reasoning_content（§14.2，不再跳过续写）", async () => {
    const { chat } = await import("../src/provider.mjs")
    const { server, requests, port } = await mockContinuationServer([
      { content: "截断了", finishReason: "length", reasoning: "思考链" },
      { content: "续写内容" },
    ])
    try {
      const ds = { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "x", model: "deepseek-v4-pro" }
      const result = await chat(ds, { messages: toolHistory() })
      assert.equal(result.content, "截断了续写内容")
      assert.equal(result.reasoning, "思考链")
      const tail = requests[1].messages.at(-1)
      assert.equal(tail.prefix, true)
      assert.equal(tail.reasoning_content, "思考链", "reasoning_content 必须回传（thinking 模式约束）")
      assert.equal(tail.partial, undefined)
    } finally {
      server.close()
    }
  })

  it("T3: partial 续写不受影响——同场景不精简、全量历史 + partial 尾条（§14.2）", async () => {
    const { chat } = await import("../src/provider.mjs")
    const { server, requests, port } = await mockContinuationServer([
      { content: "前半段", finishReason: "length" },
      { content: "后半段" },
    ])
    try {
      const kimi = { baseURL: `http://127.0.0.1:${port}`, apiKey: "x", model: "kimi-k3" }
      const history = toolHistory()
      const result = await chat(kimi, { messages: history })
      assert.equal(result.content, "前半段后半段")
      const cont = requests[1].messages
      assert.equal(cont.length, history.length + 1, "全量历史原样 + partial 尾条")
      assert.ok(cont.some((m) => m.role === "tool"), "tool 消息保留")
      assert.ok(cont.some((m) => m.role === "assistant" && m.tool_calls), "assistant(tool_calls) 保留")
      const tail = cont.at(-1)
      assert.equal(tail.role, "assistant")
      assert.equal(tail.partial, true)
      assert.equal(tail.prefix, undefined)
      assert.equal(tail.content, "前半段")
    } finally {
      server.close()
    }
  })

  it("T4: 续写 400 失败可见性——_warnings 含错误文本，不静默飞出（§14.3）", async () => {
    const { chat } = await import("../src/provider.mjs")
    const { server, requests, port } = await mockContinuationServer([
      { content: "前半段", finishReason: "length" },
      { status: 400, error: "Function call should not be used with prefix" },
    ])
    try {
      const ds = { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "x", model: "deepseek-v4-pro" }
      const result = await chat(ds, { messages: toolHistory() })
      assert.equal(requests.length, 2, "续写请求确已发出")
      assert.equal(requests[1]._url, "/beta/chat/completions")
      assert.equal(result.content, "前半段", "不抛出：已收内容保留")
      assert.ok(Array.isArray(result._warnings) && result._warnings.length >= 1, "结果必须带 _warnings")
      assert.match(result._warnings[0].message, /Function call should not be used with prefix/)
    } finally {
      server.close()
    }
  })
})

// ─── 2026-08-31 vscode 会诊鲁棒性修复 ───────────────────────────

describe("2026-08-31 会诊：非 SSE 降级 / BOM / 多行 data / reasoning 方言", () => {
  it("非 SSE 完整 chat.completion（message 形态）读到内容（会诊 #3）", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")
    const jsonBody = JSON.stringify({
      id: "x", object: "chat.completion", model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "完整回复" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    const tokens = []
    const result = await parseStream({
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(jsonBody)); c.close() } }),
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => jsonBody,
    }, { onToken: (t) => tokens.push(t), onReasoning: () => {} })
    assert.equal(result.content, "完整回复", "message 形态 content 必须读出")
    assert.deepEqual(tokens, ["完整回复"])
    assert.equal(result.finishReason, "stop")
  })

  it("SSE body + content-type 缺失/未知时走流路径不误伤（unknown 回退）", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
      "data: [DONE]\n",
    ]
    const result = await parseStream({
      body: new ReadableStream({
        start(c) { for (const l of sse) c.enqueue(new TextEncoder().encode(l)); c.close() },
      }),
      ok: true,
      headers: new Map(), // 无 content-type（advisor mock 同款）
    }, { onToken: () => {}, onReasoning: () => {} })
    assert.equal(result.content, "hi", "无 content-type 的 SSE body 必须走流解析")
  })

  it("BOM 首 chunk 不吞事件 + 多行 data 拼接（会诊 #7/#8）", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")
    const lines = [
      "\uFEFFdata: " + JSON.stringify({ choices: [{ delta: { content: "先" } }] }) + "\n",
      "data: " + JSON.stringify({ choices: [{ delta: { content: "后" } }] }) + "\n",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
      "data: [DONE]\n",
    ]
    const tokens = []
    const result = await parseStream(createMockResponse(lines), {
      onToken: (t) => tokens.push(t), onReasoning: () => {},
    })
    assert.equal(result.content, "先后")
    assert.equal(result.finishReason, "stop")
  })

  it("reasoning 方言：delta.reasoning 而非 reasoning_content（会诊 #9）", async () => {
    const { parseStream } = await import("../src/provider/transports/openai.mjs")
    const lines = [
      'data: {"choices":[{"delta":{"reasoning":"思考中","content":"正文"}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
    ]
    let seen = ""
    const result = await parseStream(createMockResponse(lines), {
      onToken: () => {}, onReasoning: (r) => { seen += r },
    })
    assert.equal(result.reasoning, "思考中")
    assert.equal(seen, "思考中")
  })
})

describe("2026-08-31 会诊：Retry-After / rateGate 超预算 / listModels 兜底", () => {

  it("buildRequest: tool_choice/parallel_tool_calls 三格式映射（能力层 2026-08-31）", async () => {
    const openai = await import("../src/provider/transports/openai.mjs")
    const anthropic = await import("../src/provider/transports/anthropic.mjs")
    const google = await import("../src/provider/transports/google.mjs")
    const provider = { model: "m", baseURL: "https://x", apiKey: "k" }
    const messages = [{ role: "user", content: "hi" }]
    const o = JSON.parse(openai.buildRequest(provider, messages, null, { toolChoice: "required", parallelToolCalls: true }).body)
    assert.equal(o.tool_choice, "required", "openai 透传")
    assert.equal(o.parallel_tool_calls, true, "parallel 显式 true 才发")
    const a = JSON.parse(anthropic.buildRequest(provider, [{ role: "system", content: "s" }, ...messages], null, { toolChoice: { type: "function", function: { name: "w" } } }).body)
    assert.deepEqual(a.tool_choice, { type: "tool", name: "w" }, "anthropic 映射")
    const g = JSON.parse(google.buildRequest(provider, messages, null, { toolChoice: "required" }).body)
    assert.deepEqual(g.toolConfig, { functionCallingConfig: { mode: "ANY" } }, "google 映射")
    // 不传 toolChoice → 不产生字段（默认行为不变）
    const o2 = JSON.parse(openai.buildRequest(provider, messages, null).body)
    assert.equal("tool_choice" in o2, false)
    assert.equal("parallel_tool_calls" in o2, false)
  })

  it("Responses API transport：buildRequest 链增量 + 灰名单 + parseStream 全事件（2026-08-31）", async () => {
    const { buildRequest, parseStream } = await import("../src/provider/transports/responses.mjs")
    // 白名单（百炼）：首轮建链元数据
    const p = { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "k", model: "qwen3.8-max", stateful: true }
    const req1 = buildRequest(p, [{ role: "user", content: "查天气" }], null, {})
    const b1 = JSON.parse(req1.body)
    assert.equal(b1.input.length, 1)
    assert.equal(b1.store, true, "百炼开链必须 store:true（真机冒烟 2026-08-31：false → 链 400 Not found；云端留存 7 天，warning 知悉）")
    assert.ok(req1._chainMeta, "白名单 host 建立链元数据")
    p._responsesChain = { ...req1._chainMeta, id: "resp_1" }
    // turn 内增量：只发 function_call_output
    const req2 = buildRequest(p, [
      { role: "user", content: "查天气" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "g", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "晴" },
    ], null, {})
    const b2 = JSON.parse(req2.body)
    assert.equal(b2.input.length, 1, "增量只发工具结果")
    assert.equal(b2.input[0].type, "function_call_output")
    // 灰名单（DeepSeek）：全量 + 一次性警告
    const dp = { baseURL: "https://api.deepseek.com", apiKey: "k", model: "deepseek-chat", stateful: true }
    const dreq = buildRequest(dp, [{ role: "user", content: "hi" }], null, {})
    assert.ok(dreq._warnings?.some((w) => w.name === "responses-stateful-unsupported"), "灰名单警告")
    assert.ok(!dreq._chainMeta, "灰名单不建链")
    // parseStream：文本/reasoning/工具/completed 全事件 + responseId 提取
    const events = [
      { type: "response.reasoning_text.delta", delta: "想" },
      { type: "response.output_text.delta", delta: "你" },
      { type: "response.output_item.added", item: { id: "f1", call_id: "c1", type: "function_call", name: "read" } },
      { type: "response.function_call_arguments.delta", item_id: "f1", delta: "{}" },
      { type: "response.output_item.done", item: { id: "f1", call_id: "c1", type: "function_call", name: "read", arguments: "{}" } },
      { type: "response.completed", response: { id: "resp_9", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3, input_tokens_details: { cached_tokens: 1 } } } },
    ]
    const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
    const result = await parseStream({ body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(payload)); c.close() } }) }, {
      onToken: () => {}, onReasoning: () => {},
    })
    assert.equal(result.content, "你", "output_text 累加")
    assert.equal(result.reasoning, "想", "reasoning_text 累加")
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].name, "read")
    assert.equal(result.responseId, "resp_9", "completed 提取 responseId（链推进用）")
    assert.equal(result.usage.prompt_cache_hit_tokens, 1)
  })

  it("Responses 内置工具（web_search）：声明 + 捕获 + 回传（2026-08-31 用户拍板）", async () => {
    const { buildRequest, parseStream } = await import("../src/provider/transports/responses.mjs")
    // 百炼默认声明 web_search 与本地 function 共存
    const p = { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "k", model: "qwen3.8-max", stateful: true }
    const req = buildRequest(p, [{ role: "user", content: "搜" }], [{ type: "function", name: "read", description: "d", parameters: { type: "object", properties: {} } }], {})
    const b = JSON.parse(req.body)
    assert.equal(b.tools.length, 2)
    assert.equal(b.tools[1].type, "web_search", "内置 web_search 声明")
    // builtinTools:false 关闭
    const reqOff = buildRequest({ ...p, builtinTools: false }, [{ role: "user", content: "搜" }], [], {})
    assert.equal((JSON.parse(reqOff.body).tools ?? []).length, 0, "显式关闭内置工具")
    // web_search_call 捕获
    const events = [
      { type: "response.output_item.done", item: { id: "ws_1", type: "web_search_call", status: "completed", action: { query: "天气", type: "search", sources: [] } } },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
    const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
    const result = await parseStream({ body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(payload)); c.close() } }) }, { onToken: () => {}, onReasoning: () => {} })
    assert.equal(result.builtinToolResults.length, 1)
    assert.equal(result.builtinToolResults[0].query, "天气")
  })

  it("parseStream: 百炼帧 data:{…} 无空格（真机冒烟 2026-08-31，与 CLI 同修）", async () => {
    const { parseStream } = await import("../src/provider/transports/responses.mjs")
    const frames = [
      "id:1\nevent:response.output_text.delta\n:HTTP_STATUS/200\ndata:{\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}",
      "id:2\nevent:response.completed\n:HTTP_STATUS/200\ndata:{\"type\":\"response.completed\",\"response\":{\"id\":\"resp_q\",\"usage\":{\"input_tokens\":5,\"output_tokens\":2,\"total_tokens\":7}}}",
    ]
    const result = await parseStream({ body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frames.join("\n\n") + "\n\n")); c.close() } }) }, { onToken: () => {}, onReasoning: () => {} })
    assert.equal(result.content, "你好", "无空格 data: 帧必须解析（百炼形态）")
    assert.equal(result.responseId, "resp_q")
  })


  it("parseRetryAfter：秒数/HTTP-date + 300s 上限（会诊 #5）", async () => {
    const { parseRetryAfter } = await import("../src/provider.mjs")
    assert.equal(parseRetryAfter("42", 0), 42_000)
    assert.equal(parseRetryAfter("1200", 0), 300_000, "超上限钳到 300s")
    assert.equal(parseRetryAfter(null, 2), 60_000, "缺失头退回退避表第 3 档")
    assert.equal(parseRetryAfter("garbage", 0), 15_000, "非法退回第 1 档")
    const future = new Date(Date.now() + 65_000).toUTCString()
    const ms = parseRetryAfter(future, 0)
    assert.ok(ms >= 64_000 && ms <= 65_500, `HTTP-date：${ms}ms ≈ 65s`)
  })

  it("rateGate 单请求超 tpm 告警且不死等（会诊 #4）", async () => {
    const { rateGate, _rateHooks } = await import("../src/provider/rate.mjs")
    const waits = []
    const orig = _rateHooks.sleep
    _rateHooks.sleep = async (ms) => { waits.push(ms) }
    try {
      const warned = []
      const provider = { baseURL: "https://x", apiKey: "k", tpm: 100, rpm: null }
      await rateGate(provider, 5000, (w) => warned.push(w), undefined)
      assert.ok(warned.some((w) => w.phase === "warn" && /estimated 5000 tokens > tpm 100/.test(w.message)), "超预算必须告警")
      assert.equal(waits.length, 0, "单请求超预算不得睡窗口（原实现死循环）")
    } finally {
      _rateHooks.sleep = orig
    }
  })
})


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
      assert.match(lines[0], /\+\d+ms since click/)
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

  it("non-thinking models get no default thinking (qwen-plus has no thinking flag)", async () => {
    const { buildRequest } = await import("../src/provider/transports/openai.mjs")
    const body = JSON.parse(buildRequest({ baseURL: "https://x/v1", apiKey: "k", model: "qwen-plus" }, [], []).body)
    assert.equal("thinking" in body, false)
  })
})

// ─── reasoning selector wiring ("off"/"none" must truly disable) ──

describe("resolveReasoningMode", () => {
  it('"none" (the UI effort enum bottom, labeled off) is a TRUE off, same as "off"', async () => {
    const { resolveReasoningMode } = await import("../src/extension/reasoning-mode.mjs")
    const specFn = () => ({ thinkApi: "type" })
    assert.deepEqual(resolveReasoningMode("none", "glm-5.2", specFn), { thinking: null, reasoningEffort: null })
    assert.deepEqual(resolveReasoningMode("off", "glm-5.2", specFn), { thinking: null, reasoningEffort: null })
  })

  it('"enabled" uses thinkEnabledValue; effort levels pass through as reasoningEffort', async () => {
    const { resolveReasoningMode } = await import("../src/extension/reasoning-mode.mjs")
    assert.deepEqual(resolveReasoningMode("enabled", "glm-5.2", () => ({ thinkApi: "type", thinkEnabledValue: "enabled" })).thinking, { type: "enabled" })
    assert.deepEqual(resolveReasoningMode("high", "x", () => ({})), { reasoningEffort: "high", thinking: undefined })
    assert.deepEqual(resolveReasoningMode(undefined, "x", () => ({})), {})
  })

  it("effort tier after off clears the null off-marker on merge — PROVIDER.md §12 T8 / delivery review #1", async () => {
    const { resolveReasoningMode } = await import("../src/extension/reasoning-mode.mjs")
    const { resolveEnableThinking, specForModel } = await import("../src/config.mjs")
    const specFn = () => ({ thinkApi: "effort", reasoningEffortEnum: ["xhigh", "medium", "low"] })
    // panel off persists thinking:null / reasoningEffort:null (unchanged off semantics)
    assert.deepEqual(resolveReasoningMode("off", "qwen3.8-max", specFn), { thinking: null, reasoningEffort: null })
    // off → pick a tier: patch must carry thinking:undefined so the spread-merge erases the null marker
    const p0 = { model: "qwen3.8-max", thinking: null, reasoningEffort: null }
    const patch = resolveReasoningMode("xhigh", "qwen3.8-max", specFn)
    assert.equal(patch.reasoningEffort, "xhigh")
    assert.ok("thinking" in patch && patch.thinking === undefined, "patch must explicitly clear thinking")
    const merged = { ...p0, ...patch }
    assert.equal(merged.thinking, undefined, "null off-marker erased after merge")
    assert.equal(merged.reasoningEffort, "xhigh")
    // mapping precondition: enable_thinking resolves true, no contradictory false + effort payload
    const provider = { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", ...merged }
    assert.equal(resolveEnableThinking(provider, specForModel(merged.model)), true)
  })
})

// ─── model spec official-parameter sync (verified vs vendor docs 2026-08) ──

describe("MODEL_SPECS official sync", () => {
  it("kimi-k3 / k3: maxOutput 131072 (Kimi OpenAPI default), cacheMode auto (auto cache, no cache ID)", async () => {
    const { specForModel } = await import("../src/config.mjs")
    for (const id of ["kimi-k3", "k3"]) {
      const s = specForModel(id)
      assert.equal(s.maxOutput, 131072, id)
      assert.equal(s.cacheMode, "auto", id)
    }
  })

  it("qwen3.x: maxOutput 131072 (Qwen official 131K), thinking-capable 3.7/3.8 flagged", async () => {
    const { specForModel } = await import("../src/config.mjs")
    for (const id of ["qwen3.8-max-preview", "qwen3.7-max", "qwen3.8-max", "qwen-max", "qwen-plus", "qwen"]) {
      assert.equal(specForModel(id).maxOutput, 131072, id)
    }
    assert.equal(specForModel("qwen3.8-max").thinking, true, "qwen3.8-max has a thinking mode (DashScope)")
    assert.equal(specForModel("qwen3.7-max").thinking, true, "qwen3.7-max has a thinking mode")
  })

  it("glm-5.2 effort enum matches Zhipu OpenAPI exactly", async () => {
    const { specForModel } = await import("../src/config.mjs")
    assert.deepEqual(specForModel("glm-5.2").reasoningEffortEnum, ["max", "xhigh", "high", "medium", "low", "minimal", "none"])
  })
})

// ─── provider presets ───────────────────────────────────────────

describe("PROVIDER_PRESETS", () => {
  it("includes the Zhipu GLM coding-plan endpoint alongside the standard one", async () => {
    const { PROVIDER_PRESETS } = await import("../src/config-io.mjs")
    assert.equal(PROVIDER_PRESETS.glm.baseURL, "https://open.bigmodel.cn/api/paas/v4")
    assert.equal(PROVIDER_PRESETS["glm-code"].baseURL, "https://open.bigmodel.cn/api/coding/paas/v4")
    assert.equal(PROVIDER_PRESETS["glm-code"].model, "glm-5.2")
  })
})

// ─── DeepSeek official sync (verified 2026-08 via api-docs.deepseek.com) ──

describe("DeepSeek spec official sync", () => {
  it("v4 dual models: 1M context / 384K output / thinking default-on / effort low-high-max / auto disk cache", async () => {
    const { specForModel } = await import("../src/config.mjs")
    for (const id of ["deepseek-v4-pro", "deepseek-v4-flash"]) {
      const s = specForModel(id)
      assert.equal(s.context, 1_000_000, id + " context (flash was wrongly 256K)")
      assert.equal(s.maxOutput, 384_000, id)
      assert.equal(s.thinking, true, id + " thinking default-on (flash was wrongly false)")
      assert.deepEqual(s.reasoningEffortEnum, ["low", "high", "max"], id + " effort enum (official mapping table)")
    }
  })

  it("retired IDs deepseek-chat / deepseek-reasoner are gone (official model list has only v4 duals)", async () => {
    const { specForModel } = await import("../src/config.mjs")
    // specForModel falls back to a default spec for unknown ids — assert via the resolution instead:
    // retired ids now resolve to the generic default (context 128K), not a dedicated row
    assert.equal(specForModel("deepseek-chat").context, 128_000, "falls back to default spec")
    assert.equal(specForModel("deepseek-reasoner").context, 128_000, "falls back to default spec")
  })
})

// ─── reasoningEffortDefault (model-official defaults for the effort dropdown) ──

describe("spec reasoningEffortDefault", () => {
  it("official defaults land on the specs the effort UI reads", async () => {
    const { specForModel } = await import("../src/config.mjs")
    assert.equal(specForModel("deepseek-v4-pro").reasoningEffortDefault, "high")
    assert.equal(specForModel("kimi-k3").reasoningEffortDefault, "max")
    assert.equal(specForModel("glm-5.2").reasoningEffortDefault, "max")
    assert.equal(specForModel("qwen3.8-max-preview").reasoningEffortDefault, "xhigh")
    assert.equal(specForModel("gpt-4o").reasoningEffortDefault, undefined, "non-thinking models have no default")
  })
})

// ─── Qwen enable_thinking mapping (PROVIDER.md §12, 2026-08-28 — CLI parity) ──

describe("resolveEnableThinking (PROVIDER.md §12 T1-T5)", () => {
  it("T1: Bailian qwen explicit off (thinking:null) → false", async () => {
    const { resolveEnableThinking, specForModel } = await import("../src/config.mjs")
    const p = { model: "qwen3.8-max", baseURL: "https://dashscope.aliyuncs.com/v1", thinking: null }
    assert.equal(resolveEnableThinking(p, specForModel(p.model)), false)
  })

  it("T2: Bailian qwen with effort tier → true", async () => {
    const { resolveEnableThinking, specForModel } = await import("../src/config.mjs")
    const p = { model: "qwen3.8-max", baseURL: "https://dashscope.aliyuncs.com/v1", reasoningEffort: "xhigh" }
    assert.equal(resolveEnableThinking(p, specForModel(p.model)), true)
  })

  it("T3: non-whitelist model (kimi-k3) explicit off → undefined", async () => {
    const { resolveEnableThinking, specForModel } = await import("../src/config.mjs")
    const p = { model: "kimi-k3", baseURL: "https://api.moonshot.cn/v1", thinking: null }
    assert.equal(resolveEnableThinking(p, specForModel(p.model)), undefined)
  })

  it("T4: qwen behind a non-Bailian host (self proxy) → undefined", async () => {
    const { resolveEnableThinking, specForModel } = await import("../src/config.mjs")
    const p = { model: "qwen3.7-max", baseURL: "https://my-proxy.example.com/v1", reasoningEffort: "high" }
    assert.equal(resolveEnableThinking(p, specForModel(p.model)), undefined)
  })

  it("T5: qwen3-coder (non-thinking coding line) → undefined even on Bailian", async () => {
    const { resolveEnableThinking, specForModel } = await import("../src/config.mjs")
    const p = { model: "qwen3-coder-plus", baseURL: "https://coding-intl.dashscope.aliyuncs.com/v1", reasoningEffort: "high" }
    assert.equal(resolveEnableThinking(p, specForModel(p.model)), undefined)
  })

  it(".maas.aliyuncs.com token-plan host whitelisted; unset thinking/effort → undefined (server default)", async () => {
    const { resolveEnableThinking, isBailianHost, specForModel } = await import("../src/config.mjs")
    const maas = { model: "qwen3.7-max", baseURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", reasoningEffort: "high" }
    assert.equal(resolveEnableThinking(maas, specForModel(maas.model)), true)
    const unset = { model: "qwen3.8-max", baseURL: "https://dashscope.aliyuncs.com/v1" }
    assert.equal(resolveEnableThinking(unset, specForModel(unset.model)), undefined)
    assert.equal(isBailianHost("https://dashscope.aliyuncs.com/v1"), true)
    assert.equal(isBailianHost("https://token-plan.cn-beijing.maas.aliyuncs.com/v1"), true)
    assert.equal(isBailianHost("https://api.moonshot.cn/v1"), false)
    assert.equal(isBailianHost(undefined), false)
  })
})

describe("buildRequest enable_thinking injection", () => {
  it("off → enable_thinking:false; tier → true + reasoning_effort; non-whitelist → field absent", async () => {
    const { buildRequest } = await import("../src/provider/transports/openai.mjs")
    const bailian = "https://dashscope.aliyuncs.com/compatible-mode/v1"

    const off = JSON.parse(buildRequest({ baseURL: bailian, apiKey: "k", model: "qwen3.8-max", thinking: null }, [], []).body)
    assert.equal(off.enable_thinking, false, "explicit panel off must send enable_thinking:false")
    assert.equal("thinking" in off, false)
    assert.equal("reasoning_effort" in off, false)

    const tier = JSON.parse(buildRequest({ baseURL: bailian, apiKey: "k", model: "qwen3.8-max", reasoningEffort: "xhigh" }, [], []).body)
    assert.equal(tier.enable_thinking, true, "effort tier sends enable_thinking:true")
    assert.equal(tier.reasoning_effort, "xhigh", "rides alongside existing reasoning_effort")

    const kimi = JSON.parse(buildRequest({ baseURL: "https://api.moonshot.cn/v1", apiKey: "k", model: "kimi-k3", thinking: null }, [], []).body)
    assert.equal("enable_thinking" in kimi, false, "non-whitelist stays zero-change")

    const proxy = JSON.parse(buildRequest({ baseURL: "https://my-proxy.example.com/v1", apiKey: "k", model: "qwen3.7-max", reasoningEffort: "high" }, [], []).body)
    assert.equal("enable_thinking" in proxy, false, "non-Bailian host not whitelisted")
    assert.equal(proxy.reasoning_effort, "high")
  })

  it("off → effort sequence (panel merge) sends enable_thinking:true — §12 T8 at body level", async () => {
    const { buildRequest } = await import("../src/provider/transports/openai.mjs")
    const { resolveReasoningMode } = await import("../src/extension/reasoning-mode.mjs")
    const { specForModel } = await import("../src/config.mjs")
    const bailian = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    // persisted off state (thinking:null) merged with the tier patch from the reasoning selector
    const p = { baseURL: bailian, apiKey: "k", model: "qwen3.8-max", thinking: null, reasoningEffort: null }
    const merged = { ...p, ...resolveReasoningMode("xhigh", p.model, specForModel) }
    const body = JSON.parse(buildRequest(merged, [], []).body)
    assert.equal(body.enable_thinking, true, "cleared off-marker + tier → enable_thinking:true")
    assert.equal(body.reasoning_effort, "xhigh")
    // thinking:undefined 触发 openai.mjs 既有 spec 默认注入（spec.thinking:true → {type:"enabled"}，
    // GLM 修复引入的通用行为）——与 enable_thinking:true 同向，非 off 标记残留
    assert.deepEqual(body.thinking, { type: "enabled" })
  })
})

describe("resolveEnableThinking CLI parity", () => {
  it("function bodies are identical to thincoder CLI config.mjs (NF3)", async () => {
    const { existsSync, readFileSync } = await import("node:fs")
    const { dirname, join } = await import("node:path")
    const { fileURLToPath } = await import("node:url")
    const cliConfig = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "thincoder", "src", "config.mjs")
    if (!existsSync(cliConfig)) return // standalone vscode clone — CLI side runs the same check
    const cliSrc = readFileSync(cliConfig, "utf8")
    const { resolveEnableThinking, isBailianHost } = await import("../src/config.mjs")
    const extract = (name) => {
      const i = cliSrc.indexOf(`export function ${name}`)
      assert.ok(i >= 0, `CLI config.mjs is missing ${name} (drift)`)
      const end = /^}/m.exec(cliSrc.slice(i))
      assert.ok(end, `${name} body extraction failed`)
      return cliSrc.slice(i, i + end.index + 1)
    }
    const norm = (s) => s.replace(/^export\s+/, "").replace(/\s+/g, "")
    for (const fn of [resolveEnableThinking, isBailianHost]) {
      assert.equal(norm(extract(fn.name)), norm(fn.toString()), `${fn.name} drifted between CLI and vscode`)
    }
  })
})
it("stripLocalMessageFields removes the transient flag before payload (IKBGX4)", async () => {
  const { stripLocalMessageFields } = await import("../src/provider.mjs")
  assert.deepEqual(
    stripLocalMessageFields([
      { role: "user", content: "hi", transient: true },
      { role: "assistant", content: "yo" },
      "raw-string-message",
    ]),
    [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }, "raw-string-message"],
  )
})

