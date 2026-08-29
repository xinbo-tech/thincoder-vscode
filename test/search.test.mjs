// search.test.mjs — in-conversation search (Ctrl+F) perf-regression tests.
// 2026-08-28 白屏修复回归：防抖（击键不搜）、mark 上限（DOM 不爆炸）、搜索不自动滚动
// （无强制布局）、i18n 键补齐（不再显示裸键名）。
import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { setupWebview } from "./helpers/webview-env.mjs"

let _scrollCalls = 0
let ctx // shared webview state (state.js exports; dynamic import inside before — top-level would run before the acquireVsCodeApi stub)

before(async () => {
  setupWebview()
  globalThis.acquireVsCodeApi = () => ({})
  // 修复 3 观察点：统计 scrollIntoView 调用次数（真实浏览器该调用触发强制布局）
  Element.prototype.scrollIntoView = () => { _scrollCalls++ }
  const state = await import("../webview/state.js")
  ctx = state.ctx
  await import("../webview/search.js")
})

after(() => {
  try { globalThis.GlobalRegistrator?.unregister?.() } catch { /* noop */ }
})

function messagesEl() {
  return document.getElementById("messages")
}

function toolbarEl() {
  return document.getElementById("toolbar")
}

// 工具：把 messages 区填成"高频词密集"长会话（模拟长会话文本体量；包含 the/fox 等多词）
function fillSession(occurrences) {
  messagesEl().textContent = "the quick brown fox jumps over the lazy dog ".repeat(occurrences)
}

beforeEach(() => {
  _scrollCalls = 0
  document.body.innerHTML = `<div id="messages"></div><div id="toolbar"></div>`
  // 重新绑定共享 ctx 的元素引用（messagesEl / inputEl 每测重建）
  ctx.messagesEl = messagesEl()
  ctx.inputEl = document.createElement("input") // closeSearch 聚焦目标
})

function openBar() {
  const found = document.getElementById("search-input")
  if (found) return found
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }))
  return document.getElementById("search-input")
}

function type(input, value) {
  input.value = value
  input.dispatchEvent(new window.Event("input"))
}

test("debounce: rapid keystrokes do NOT run a search until the 150ms pause (white-screen fix)", async () => {
  fillSession(300)
  const input = openBar()
  type(input, "t")
  type(input, "th")
  type(input, "the")
  // 防抖窗口内（150ms 未到）：不得有任何高亮/扫描
  assert.equal(messagesEl().querySelectorAll("mark.search-hit").length, 0, "keystrokes must be debounced")
  await new Promise((r) => setTimeout(r, 250))
  assert.ok(messagesEl().querySelectorAll("mark.search-hit").length > 0, "search runs after the pause")
})

test("mark cap: high-frequency terms cap the DOM at 500 marks and the count shows '+'", async () => {
  fillSession(700) // 700 个 "the" 潜在匹配
  const input = openBar()
  type(input, "the")
  await new Promise((r) => setTimeout(r, 250))
  const marks = messagesEl().querySelectorAll("mark.search-hit").length
  assert.ok(marks <= 500, `marks ${marks} must be capped at 500`)
  assert.match(document.getElementById("search-count").textContent, /\+$/, "truncated count must show '+'")
})

test("no auto-scroll during search; scroll only on jump (Enter)", async () => {
  fillSession(50)
  const input = openBar()
  type(input, "fox")
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(_scrollCalls, 0, "search itself must NOT call scrollIntoView (avoid forced layout)")
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  assert.ok(_scrollCalls >= 1, "jump must scroll to the match")
})

test("i18n keys resolved — no bare placeholder keys after locale injection", async () => {
  const input = openBar()
  assert.equal(input.getAttribute("placeholder"), "Search messages…")
  assert.ok(!input.getAttribute("placeholder").startsWith("search."), "bare locale key must not surface")
})