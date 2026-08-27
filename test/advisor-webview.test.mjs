/**
 * advisor-webview.test.mjs — advisor block title carries the review model (T5).
 * Render-end lock of the 0.1.46 断链修复 (ARCHITECTURE.md「子agent/advisor 模型显示」,
 * 评审 #2): the panel-chat bridge now forwards chunk.model; here the renderer side is
 * pinned — a start chunk with model appends "· <model>" to the summary, a model-less
 * start chunk degrades to the bare round title (webview 三元渲染降级为空, T3 边界).
 */
import { describe, it, before, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { setupWebview } from "./helpers/webview-env.mjs"

let env
let ctx, S, advisorChunk

before(async () => {
  env = setupWebview()
  // state.js calls the VS Code webview bridge acquireVsCodeApi() at module top —
  // stub it before importing (ui.test.mjs / search.test.mjs pattern).
  globalThis.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => null, setState: () => {} })
  ;({ ctx, S } = await import("../webview/state.js"))
  ;({ advisorChunk } = await import("../webview/streaming.js"))
})
after(() => env?.cleanup())

beforeEach(() => {
  // Shared ctx (webview/state.js) gets a fresh DOM root per case; no current assistant
  // block → the advisor block appends to messagesEl directly.
  ctx.messagesEl = document.createElement("div")
  ctx.currentBlock = null
  S._advisorBlock = null
})

describe("advisorChunk — block title carries the advisor model (T5)", () => {
  it("start chunk with model → summary shows the round label and the '· deepseek-v4' suffix", () => {
    advisorChunk({ kind: "start", round: 1, model: "deepseek-v4" })
    const summary = ctx.messagesEl.querySelector(".advisor-block summary")
    assert.ok(summary, "start chunk opened an advisor block")
    assert.match(summary.textContent, /round 1/i, "i18n advisor.round prefix carries the round number")
    assert.ok(summary.textContent.includes("· deepseek-v4"), "model suffix appended to the title")
  })

  it("start chunk without model → bare round title, no '·' suffix (graceful degradation)", () => {
    advisorChunk({ kind: "start", round: 2 })
    const summary = ctx.messagesEl.querySelector(".advisor-block summary")
    assert.ok(summary, "start chunk opened an advisor block")
    assert.match(summary.textContent, /round 2/i, "i18n advisor.round prefix carries the round number")
    assert.ok(!summary.textContent.includes("·"), "no model suffix when the chunk carries no model")
  })
})
