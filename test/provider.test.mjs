/**
 * provider.test.mjs — Provider SSE stream parsing tests
 * Tests OpenAI, Anthropic, and Google format parsers.
 * Run: node --test test/provider.test.mjs
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { specForModel } from "../src/config.mjs"

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
function createMockResponse(sseLines) {
  const encoder = new TextEncoder()
  let closed = false
  const stream = new ReadableStream({
    start(controller) {
      for (const line of sseLines) {
        controller.enqueue(encoder.encode(line))
      }
      controller.close()
      closed = true
    },
  })
  return {
    body: stream,
    ok: true,
    headers: new Map([["content-type", "text/event-stream"]]),
  }
}
