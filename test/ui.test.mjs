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
} from "../webview/ui.js"

let env
before(() => { env = setupWebview() })
after(() => env.cleanup())

const ctx = () => ({ messagesEl: document.createElement("div") })

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

  it("historical message (idx set) gets edit + delete buttons", () => {
    const el = buildUserMessage(ctx(), "hi", undefined, 3)
    assert.match(el.innerHTML, /msg-edit-btn/)
    assert.match(el.innerHTML, /data-idx="3"/)
    assert.match(el.innerHTML, /msg-del-btn/)
  })

  it("live message (no idx) has no action buttons", () => {
    const el = buildUserMessage(ctx(), "hi", undefined, undefined)
    assert.doesNotMatch(el.innerHTML, /msg-edit-btn|msg-del-btn/)
  })
})

describe("buildAssistantHistory", () => {
  it("renders ThinCoder label, copy button, and markdown content", () => {
    const el = buildAssistantHistory(ctx(), "**bold**", undefined, undefined)
    assert.match(el.innerHTML, /ThinCoder:/)
    assert.match(el.innerHTML, /msg-copy-btn/)
    assert.match(el.innerHTML, /<strong>bold<\/strong>/)
  })

  it("historical assistant message (idx) gets a delete button", () => {
    const el = buildAssistantHistory(ctx(), "x", undefined, 5)
    assert.match(el.innerHTML, /msg-del-btn/)
    assert.match(el.innerHTML, /data-idx="5"/)
  })
})

describe("buildToolHistory", () => {
  it("renders a collapsed tool card with name, done status, summary, and delete", () => {
    const el = buildToolHistory(ctx(), "bash", "ls\napp.js", 7)
    assert.match(el.innerHTML, /tool-call-name/)
    assert.match(el.innerHTML, /bash/)
    assert.match(el.innerHTML, /app\.js/) // summary (last line)
    assert.match(el.innerHTML, /data-idx="7"/)
    assert.match(el.innerHTML, /aria-expanded="false"/)
  })
})

describe("buildHistoryMessage (lazy-load dispatch)", () => {
  it("dispatches user / assistant / tool by kind", () => {
    assert.ok(buildHistoryMessage(ctx(), { kind: "user", text: "u", idx: 1 }))
    assert.ok(buildHistoryMessage(ctx(), { kind: "assistant", text: "a", idx: 2 }))
    assert.ok(buildHistoryMessage(ctx(), { kind: "tool", name: "read", text: "r", idx: 3 }))
  })

  it("returns null for unknown kind or null msg", () => {
    assert.equal(buildHistoryMessage(ctx(), { kind: "bogus" }), null)
    assert.equal(buildHistoryMessage(ctx(), null), null)
    assert.equal(buildHistoryMessage(ctx(), undefined), null)
  })
})
