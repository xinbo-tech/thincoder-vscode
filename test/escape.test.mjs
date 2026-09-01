// escape.test.mjs — escape.mjs 净化链测试（CLI test/escape.test.mjs parity + VS Code 特有数组 content 用例）。
// 2026-08-31 真机回归：deepseek-v4-flash 网关对 content 里字面 "\x"/"\u" 不足位序列报
// "unexpected end of hex escape" → 400；本模块在 provider.chat() 发送前 double 掉这些序列。
import { test } from "node:test"
import assert from "node:assert/strict"
import { escapeMessages, escapeMessageContent, escapeLiteralEscapes, sanitizeLoneSurrogates, sanitizeText, stripLocalMessageFields } from "../src/escape.mjs"

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


// ─── v5 断言（CLI §14.6/§14.7：孤立代理净化 + arguments/reasoning_content 覆盖 + odd-run 修复）───

test("sanitizeLoneSurrogates: 孤立高/低代理 → U+FFFD；完整代理对保留（CLI v5 语义）", () => {
  // 🔴 = D83D+DD34 完整代理对
  assert.equal(sanitizeLoneSurrogates("a\uD83D\uDD34b"), "a\uD83D\uDD34b", "完整代理对原样保留")
  assert.equal(sanitizeLoneSurrogates("a\uD83Db"), "a\uFFFDb", "孤立高代理 → U+FFFD")
  assert.equal(sanitizeLoneSurrogates("a\uDD34b"), "a\uFFFDb", "孤立低代理 → U+FFFD")
  // 孤立代理净化不产生新 400：JSON.stringify 往返合法
  const cleaned = sanitizeLoneSurrogates("x\uD83D")
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(cleaned)), "净化后 JSON 往返合法")
  assert.ok(!JSON.stringify(cleaned).includes("\\ud83d"), "净化后无孤立代理转义输出")
})

test("sanitizeText: hex 中和 + 孤立代理净化同链（v5 总入口）", () => {
  assert.equal(sanitizeText("\\u s"), "\\\\u s", "hex 不足位先 double")
  assert.equal(sanitizeText("坏\uD83D字符"), "坏\uFFFD字符", "孤立代理净化生效")
})

test("escapeLiteralEscapes odd-run 修复：3+ 反斜杠后裸露 \\x/\\u 也 double（v3 修复语义，CLI 同构）", () => {
  assert.equal(escapeLiteralEscapes("\\\\u12中文"), "\\\\u12中文") // 2 反斜杠（偶数）已配对 → 放行
  assert.equal(escapeLiteralEscapes("\\\\\\xzz"), "\\\\\\\\xzz") // 3 反斜杠（奇数）尾部 \\x+zz 裸露 → double 为 4
  assert.equal(escapeLiteralEscapes("\\\\\\\\x41"), "\\\\\\\\x41") // 4 反斜杠（偶数）→ 放行
  assert.equal(escapeLiteralEscapes("\\\\\\u0041"), "\\\\\\u0041") // 3 反斜杠 + 合法 u 序列 → 放行
})

test("escapeMessageContent v5: tool_calls[].arguments 与 reasoning_content 同链净化", () => {
  const out = escapeMessageContent({
    role: "assistant",
    content: "ok",
    tool_calls: [{ id: "c1", type: "function", function: { name: "write", arguments: '{"path":"a\\u b","bad":"\uD83D"}' } }],
    reasoning_content: "思考 \\u 与孤立\uDC00代理",
  })
  assert.equal(out.tool_calls[0].function.arguments, '{"path":"a\\\\u b","bad":"\uFFFD"}', "arguments 中和 hex + 净化孤立代理")
  assert.equal(out.reasoning_content, "思考 \\\\u 与孤立\uFFFD代理", "reasoning_content 同链")
  // 无变化时返回原对象（引用相等）
  const clean = { role: "user", content: "hi" }
  assert.equal(escapeMessageContent(clean), clean, "无变化不新建对象")
})

test("escapeMessages v5: 全链（含 tool_calls/reasoning_content）通过 provider 发送路径", () => {
  const out = escapeMessages([
    { role: "assistant", content: "截断\uD83D", reasoning_content: "r\uD83D", tool_calls: [{ id: "c1", type: "function", function: { name: "edit", arguments: '{"x":1,"bad":"\\u s"}' } }] },
  ])
  const raw = JSON.stringify({ messages: out })
  assert.ok(!raw.includes("\\ud83d"), "发送载荷无孤立代理转义")
  assert.equal(out[0].tool_calls[0].function.arguments, '{"x":1,"bad":"\\\\u s"}', "arguments hex 已 double（\\\\u 字面）")
  assert.equal(out[0].content, "截断\uFFFD")
  assert.equal(out[0].reasoning_content, "r\uFFFD")
})
