// escape.test.mjs — escape.mjs 净化链测试（CLI test/escape.test.mjs parity + VS Code 特有数组 content 用例）。
// 2026-08-31 真机回归：deepseek-v4-flash 网关对 content 里字面 "\x"/"\u" 不足位序列报
// "unexpected end of hex escape" → 400；本模块在 provider.chat() 发送前 double 掉这些序列。
import { test } from "node:test"
import assert from "node:assert/strict"
import { escapeMessages, escapeMessageContent, escapeLiteralEscapes, stripLocalMessageFields } from "../src/escape.mjs"

test("escapeMessages strips the local-only transient flag (IKBGX4 — strict OpenAI endpoints 400 on it)", () => {
  const out = escapeMessages([
    { role: "user", content: "hi", transient: true },
    { role: "assistant", content: "yo" },
  ])
  assert.deepEqual(out, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "yo" },
  ])
})

test("stripLocalMessageFields keeps every other field; leaves non-objects untouched", () => {
  const out = stripLocalMessageFields([
    { role: "user", content: "x", transient: true, extra: 1 },
    { role: "user", content: "plain" },
    "raw-string",
  ])
  assert.deepEqual(out, [
    { role: "user", content: "x", extra: 1 },
    { role: "user", content: "plain" },
    "raw-string",
  ])
})

test("escapeLiteralEscapes still neutralizes illegal hex sequences (regression)", () => {
  assert.equal(escapeLiteralEscapes("\\xzz"), "\\\\xzz")
  assert.equal(escapeLiteralEscapes("\\u s"), "\\\\u s") // 真机复现用例：\u 后跟空格（不足 4 hex）
  assert.equal(escapeLiteralEscapes("\\x41"), "\\x41") // valid hex passes untouched
  assert.equal(escapeLiteralEscapes("\\u0041"), "\\u0041") // valid unicode passes untouched
})

test("escapeMessages still escapes message content after stripping (combined path)", () => {
  const out = escapeMessages([{ role: "user", content: "write \\x not hex", transient: true }])
  assert.deepEqual(out, [{ role: "user", content: "write \\\\x not hex" }])
})

test("escapeMessageContent handles OpenAI multimodal part arrays (only text parts)", () => {
  const out = escapeMessageContent({
    role: "user",
    content: [
      { type: "text", text: "see \\u literal" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ],
  })
  assert.equal(out.content[0].text, "see \\\\u literal")
  assert.equal(out.content[1].type, "image_url") // 非 text part 原样保留
})

test("escapeMessages leaves already-doubled sequences untouched (idempotent)", () => {
  const once = escapeMessages([{ role: "user", content: "a \\x b" }])
  const twice = escapeMessages(once)
  assert.deepEqual(once, twice)
})

test("escapeMessages output survives JSON.stringify + parse (real send-path round trip)", () => {
  // 真机毒消息同款：tool 输出里含 "neutralizes invalid literal \x/\u sequences"
  const escaped = escapeMessages([
    { role: "tool", tool_call_id: "c1", name: "grep", content: "Escapes: neutralizes invalid literal \\x/\\u sequences" },
  ])
  assert.equal(escaped[0].content, "Escapes: neutralizes invalid literal \\\\x/\\\\u sequences") // 字符串层已 double
  const raw = JSON.stringify({ messages: escaped })
  assert.deepEqual(JSON.parse(raw), { messages: escaped }) // 序列化往返合法
})
