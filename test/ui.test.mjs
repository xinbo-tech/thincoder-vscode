/**
 * ui.test.mjs — webview DOM builders (happy-dom).
 * First DOM-level coverage for the message/tool rendering layer — the area
 * where i18n loss ("msg.user"), bad tool cards, and broken diff previews lived.
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { setupWebview } from "./helpers/webview-env.mjs"
import {
  buildUserMessage, buildAssistantHistory, buildToolHistory, buildHistoryMessage, escHtml,
  newBlock, addUser, buildAdvisorBlock, appendAdvisorChunk, finishTool,
} from "../webview/ui.js"

let env
before(() => { env = setupWebview() })
after(() => env?.cleanup())

const ctx = () => ({ messagesEl: document.createElement("div") })

describe("newBlock — one ThinCoder label per turn (live streaming)", () => {  it("paints the label only on the turn's first block — segments after tool batches get none", () => {
    const c = { messagesEl: document.createElement("div"), assistantLabeled: false }
    newBlock(c)  // turn start
    newBlock(c)  // next LLM segment after a tool batch
    newBlock(c)  // and another
    const labels = c.messagesEl.querySelectorAll(".msg-label")
    assert.equal(labels.length, 1)
    assert.equal(labels[0].textContent, "❯ ThinCoder:")
  })

  it("a new user message resets the guard so the next turn paints again", () => {
    const c = { messagesEl: document.createElement("div"), assistantLabeled: false }
    newBlock(c)
    addUser(c, "second question")
    newBlock(c)
    const labels = c.messagesEl.querySelectorAll(".msg-label")
    assert.equal(labels.length, 3, "ThinCoder + You + ThinCoder (one per turn)")
    assert.equal(labels[0].textContent, "❯ ThinCoder:")
    assert.match(labels[1].textContent, /You:/)
    assert.equal(labels[2].textContent, "❯ ThinCoder:")
  })
})

describe("escHtml", () => {
  it("escapes the four dangerous characters", () => {
    assert.equal(escHtml('<a b="c">&'), "&lt;a b=&quot;c&quot;&gt;&amp;")
  })
  it("is idempotent-safe for plain text", () => {
    assert.equal(escHtml("hello world"), "hello world")
  })
})

describe("buildUserMessage", () => {
  it("renders You label and inline content", () => {
    const el = buildUserMessage(ctx(), "hello <b>", undefined, undefined)
    assert.match(el.innerHTML, /You:/)
    assert.match(el.innerHTML, /hello &lt;b&gt;/) // esc before mdInline
  })

  it("historical message carries data-idx on the element (lazy paging) — no action buttons", () => {
    const el = buildUserMessage(ctx(), "hi", undefined, 3)
    assert.equal(el.dataset.idx, "3")
    assert.doesNotMatch(el.innerHTML, /msg-edit-btn|msg-del-btn|msg-copy-btn/)
  })

  it("live message (no idx) has no data-idx and no action buttons", () => {
    const el = buildUserMessage(ctx(), "hi", undefined, undefined)
    assert.equal(el.dataset.idx, undefined)
    assert.doesNotMatch(el.innerHTML, /msg-edit-btn|msg-del-btn|msg-copy-btn/)
  })
})

describe("buildAssistantHistory", () => {
  it("renders ThinCoder label and markdown content (turn start)", () => {
    const el = buildAssistantHistory(ctx(), "**bold**", undefined, undefined, true)
    assert.match(el.innerHTML, /ThinCoder:/)
    assert.doesNotMatch(el.innerHTML, /msg-copy-btn|msg-del-btn/)
    assert.match(el.innerHTML, /<strong>bold<\/strong>/)
  })

  it("mid-turn segment (turnStart=false) renders NO label — one label per turn", () => {
    const el = buildAssistantHistory(ctx(), "continuation", undefined, 5, false)
    assert.doesNotMatch(el.innerHTML, /ThinCoder:/)
    assert.equal(el.dataset.idx, "5") // data-idx on the element for paging
    assert.match(el.innerHTML, /continuation/)
  })
})

describe("advisor review block (in-conversation streaming)", () => {
  it("buildAdvisorBlock creates an open details block with the round label and a scrolling content region", () => {
    const el = buildAdvisorBlock("Advisor Review (Round 2)")
    assert.match(el.className, /advisor-block/)
    assert.equal(el.open, true)
    assert.equal(el.querySelector("summary").textContent, "Advisor Review (Round 2)")
    assert.ok(el.querySelector(".advisor-content"))
  })

  it("appendAdvisorChunk merges same-kind runs, marks think dim, and appends tool lines", () => {
    const el = buildAdvisorBlock("Advisor Review (Round 1)")
    appendAdvisorChunk(el, "text", "Hello")
    appendAdvisorChunk(el, "text", " world")  // same-kind merge
    assert.equal(el.querySelectorAll(".advisor-text").length, 1, "same-kind runs merge")
    assert.equal(el.querySelector(".advisor-text").textContent, "Hello world")
    appendAdvisorChunk(el, "think", "thinking…")
    assert.equal(el.querySelector(".advisor-think").textContent, "thinking…")
    appendAdvisorChunk(el, "tool", "read file.mjs")
    assert.equal(el.querySelector(".advisor-tool-line").textContent, "read file.mjs")
  })

  it("NEVER truncates — a huge review chunk stays complete inside the block", () => {
    const el = buildAdvisorBlock("Advisor Review (Round 1)")
    const huge = "x".repeat(50000) // far beyond any panel cap
    appendAdvisorChunk(el, "text", huge)
    assert.equal(el.querySelector(".advisor-content").textContent.length, 50000)
  })
})

describe("finishTool — scroll follow + auto-collapse", () => {
  function setup() {
    const messagesEl = document.createElement("div")
    let scrollCalls = 0
    // Intercept the scrollTop setter — happy-dom has no layout, so scrollHeight is 0.
    Object.defineProperty(messagesEl, "scrollTop", { set: () => { scrollCalls++ }, get: () => 0 })
    const ctx = { messagesEl, _toolRefs: {}, hadToolResult: false }
    return { ctx, getScrollCalls: () => scrollCalls }
  }

  it("success collapses the card to its summary line (header keeps → last line)", () => {
    const { ctx, getScrollCalls } = setup()
    const h = document.createElement("div")
    h.innerHTML = `<span class="tool-call-icon"></span><span class="tool-call-status"></span>`
    const b = document.createElement("div")
    b.classList.add("open") // simulate streaming-open state
    ctx._toolRefs["t1"] = { h, b, name: "bash", id: "t1", startTime: Date.now() }
    finishTool(ctx, "bash", "t1", "Wrote 42 chars to app.js")
    assert.ok(getScrollCalls() > 0, "finishTool scrolled the conversation to the bottom")
    assert.equal(ctx.hadToolResult, true)
    assert.equal(b.classList.contains("open"), false, "successful tool output auto-collapses")
    assert.equal(h.getAttribute("aria-expanded"), "false")
    assert.match(h.querySelector(".tool-call-summary").textContent, /→ Wrote 42 chars/)
  })

  it("bash wrapper lines are skipped in the collapsed summary ('(exit code 0)' never shows)", () => {
    const { ctx } = setup()
    const h = document.createElement("div")
    h.innerHTML = `<span class="tool-call-icon"></span><span class="tool-call-status"></span>`
    const b = document.createElement("div")
    ctx._toolRefs["t3"] = { h, b, name: "bash", id: "t3", startTime: Date.now() }
    finishTool(ctx, "bash", "t3", "[stdout]:\nbuild succeeded\n[stderr]:\n(exit code 0)")
    assert.match(h.querySelector(".tool-call-summary").textContent, /→ build succeeded/)
  })

  it("error stays expanded — the user must see what failed", () => {
    const { ctx } = setup()
    const h = document.createElement("div")
    h.innerHTML = `<span class="tool-call-icon"></span><span class="tool-call-status"></span>`
    const b = document.createElement("div")
    ctx._toolRefs["t2"] = { h, b, name: "bash", id: "t2", startTime: Date.now() }
    finishTool(ctx, "bash", "t2", "Error: command failed")
    assert.equal(b.classList.contains("open"), true, "error output stays expanded")
    assert.equal(h.getAttribute("aria-expanded"), "true")
  })
})

describe("buildToolHistory", () => {
  it("renders a collapsed tool card with name, done status, and summary — no delete button", () => {
    const el = buildToolHistory(ctx(), "bash", "ls\napp.js", 7)
    assert.match(el.innerHTML, /tool-call-name/)
    assert.match(el.innerHTML, /bash/)
    assert.match(el.innerHTML, /app\.js/) // summary (last line)
    assert.equal(el.dataset.idx, "7")
    assert.match(el.innerHTML, /aria-expanded="false"/)
    assert.doesNotMatch(el.innerHTML, /msg-del-btn/)
  })
})

describe("buildHistoryMessage (lazy-load dispatch)", () => {
  it("dispatches to the right element type by kind", () => {
    const u = buildHistoryMessage(ctx(), { kind: "user", text: "u", idx: 1 })
    assert.ok(u.classList.contains("message") && u.classList.contains("user"), "user → .message.user")

    const a = buildHistoryMessage(ctx(), { kind: "assistant", text: "a", idx: 2 })
    assert.ok(a.classList.contains("message") && a.classList.contains("assistant"), "assistant → .message.assistant")

    const t = buildHistoryMessage(ctx(), { kind: "tool", name: "read", text: "r", idx: 3 })
    assert.ok(t.classList.contains("tool-call"), "tool → .tool-call")
  })

  it("returns null for unknown kind or null msg", () => {
    assert.equal(buildHistoryMessage(ctx(), { kind: "bogus" }), null)
    assert.equal(buildHistoryMessage(ctx(), null), null)
    assert.equal(buildHistoryMessage(ctx(), undefined), null)
  })
})
