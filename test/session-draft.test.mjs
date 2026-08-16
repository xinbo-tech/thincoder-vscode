/**
 * session-draft.test.mjs — switching sessions must NOT clear the input box.
 * Empirical check of the full switch path: clearMessages + historyPage.
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { setupWebview } from "./helpers/webview-env.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
let env

before(async () => {
  env = setupWebview()
  const html = readFileSync(join(__dirname, "..", "webview", "index.html"), "utf8")
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? ""
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "")
  globalThis.acquireVsCodeApi = () => ({ postMessage: (m) => env.capturedPosts.push(m), getState: () => null, setState: () => {} })
  await import("../webview/chat.js")
})
after(() => env?.cleanup())

function postToWebview(msg) {
  // chat.js listens on window "message"
  window.dispatchEvent(new window.MessageEvent("message", { data: msg }))
}

describe("session switch keeps the input draft", () => {
  it("clearMessages + historyPage (the switch sequence) leaves inputEl.value intact", () => {
    const input = document.getElementById("input")
    input.value = "my half-written prompt"
    postToWebview({ type: "clearMessages" })
    postToWebview({ type: "historyPage", messages: [{ kind: "user", text: "old", idx: 0 }], hasOlder: false, older: false })
    assert.equal(input.value, "my half-written prompt", "draft survives the session switch")
  })
})

describe("live tool-output streaming into the running card", () => {
  it("toolOutput chunks append to the card body and open it; toolResult collapses again", () => {
    postToWebview({ type: "toolCall", name: "bash", args: "{}", id: "stream-1" })
    const card = document.querySelector('[data-tool-id="stream-1"]')
    assert.ok(card, "tool card created")
    postToWebview({ type: "toolOutput", name: "bash", text: "line one\n", id: "stream-1" })
    postToWebview({ type: "toolOutput", name: "bash", text: "line two\n", id: "stream-1" })
    const body = card.querySelector(".tool-call-body")
    assert.match(body.textContent, /line one\nline two/)
    assert.equal(body.classList.contains("open"), true, "body opens while streaming")
    postToWebview({ type: "toolResult", name: "bash", id: "stream-1", text: "line one\nline two\n(exit code 0)" })
    assert.equal(body.classList.contains("open"), false, "success finish collapses again")
  })
})

describe("clickable file links in tool cards", () => {
  it("toolResult links render as .file-link spans and click posts openFile", () => {
    postToWebview({ type: "toolCall", name: "write", args: "{}", id: "w1" })
    postToWebview({
      type: "toolResult", name: "write", id: "w1", text: "Wrote 42 chars to src/app.mjs",
      links: [{ raw: "src/app.mjs", path: "d:\\proj\\src\\app.mjs", line: 12 }],
    })
    const link = document.querySelector('[data-tool-id="w1"] .file-link')
    assert.ok(link, "path wrapped as a link")
    assert.equal(link.textContent, "src/app.mjs")
    assert.equal(link.dataset.line, "12")
    const before = env.capturedPosts.filter((m) => m.type === "openFile").length
    link.click()
    const open = env.capturedPosts.filter((m) => m.type === "openFile")
    assert.equal(open.length, before + 1, "click posts openFile")
    assert.equal(open[open.length - 1].path, "d:\\proj\\src\\app.mjs")
    assert.equal(open[open.length - 1].line, 12)
  })

  it("no links → plain text body (no spans)", () => {
    postToWebview({ type: "toolCall", name: "bash", args: "{}", id: "w2" })
    postToWebview({ type: "toolResult", name: "bash", id: "w2", text: "plain output", links: [] })
    assert.equal(document.querySelectorAll('[data-tool-id="w2"] .file-link').length, 0)
  })
})

describe("native diff viewer button on large permission diffs", () => {
  it("big diff shows the view-in-editor button; small diff does not", () => {
    const old = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")
    const newText = Array.from({ length: 30 }, (_, i) => (i % 2 ? `CHANGED ${i}` : `line ${i}`)).join("\n")
    postToWebview({ type: "permissionRequest", tool: "write", args: "{}", diff: { old, new: newText, path: "src/big.mjs" } })
    const prompts = document.querySelectorAll(".permission-prompt")
    const last = prompts[prompts.length - 1]
    assert.ok(last.querySelector(".view-diff"), "big diff has the view-in-editor button")
    const before = env.capturedPosts.filter((m) => m.type === "openDiff").length
    last.querySelector(".view-diff").click()
    assert.equal(env.capturedPosts.filter((m) => m.type === "openDiff").length, before + 1)
    last.querySelector(".deny").click() // clean up the prompt

    postToWebview({ type: "permissionRequest", tool: "write", args: "{}", diff: { old: "a\n", new: "b\n", path: "src/tiny.mjs" } })
    const prompts2 = document.querySelectorAll(".permission-prompt")
    assert.equal(prompts2[prompts2.length - 1].querySelector(".view-diff"), null, "small diff has no button")
    prompts2[prompts2.length - 1].querySelector(".deny").click()
  })
})

describe("consult panel — per-model status blocks (reuses the subagent channel)", () => {
  it("consult children render in the subagent panel with status transitions", () => {
    postToWebview({ type: "subagent", id: "c1", role: "consult", model: "deepseek:m-a", status: "started" })
    postToWebview({ type: "subagent", id: "c2", role: "consult", model: "openai:m-b", status: "started" })
    postToWebview({ type: "subagent", id: "c1", role: "consult", model: "deepseek:m-a", status: "answered" })
    postToWebview({ type: "subagent", id: "c2", role: "consult", model: "openai:m-b", status: "terminated" })
    const panel = document.getElementById("subagent-panel")
    assert.ok(panel, "subagent panel exists")
    assert.match(panel.textContent, /consult/, "consult role visible")
    assert.match(panel.textContent, /answered/, "answered status shown")
    assert.match(panel.textContent, /terminated/, "terminated status shown")
  })
})

describe("needsSetup error re-opens the welcome panel", () => {
  const welcomePanel = () => document.getElementById("welcome-panel")
  const visible = () => welcomePanel().style.display !== "none"

  it("send with no configured provider re-opens welcome even after Skip dismissed it", () => {
    // Seed provider status (unconfigured) → welcome shows
    postToWebview({ type: "providerStatus", status: { presets: [{ name: "deepseek", desc: "DeepSeek", model: "deepseek-v4-pro" }] }, keyOk: false })
    assert.equal(visible(), true, "welcome shows when unconfigured")
    // User skips → dismissed for the session
    document.getElementById("welcome-skip-btn").click()
    assert.equal(visible(), false, "skip hides the panel")
    // A send fails with needsSetup → welcome must come back
    postToWebview({ type: "error", text: "No provider configured", needsSetup: true })
    assert.equal(visible(), true, "needsSetup error re-opens the welcome panel")
    assert.ok(document.getElementById("welcome-provider").innerHTML.includes("deepseek"), "presets populated from cached status")
  })

  it("a plain error (no needsSetup) does NOT re-open welcome", () => {
    document.getElementById("welcome-skip-btn").click() // dismissed
    postToWebview({ type: "error", text: "some other failure" })
    assert.equal(visible(), false)
  })
})

describe("reasoning renders markdown (not plain text)", () => {
  it("reasoning chunks with headers/code render as HTML elements in the block", async () => {
    postToWebview({ type: "reasoning", text: "## Plan\nLook at code: " })
    postToWebview({ type: "reasoning", text: "**bold idea** and `inline`" })
    // Rendering is rAF-throttled (2026-08-16 Stop-latency fix): flush one frame before asserting.
    await new Promise((r) => requestAnimationFrame(() => r()))
    const block = document.querySelector(".reasoning-block")
    assert.ok(block, "reasoning block exists")
    const content = block.querySelector(".reasoning-content")
    assert.ok(content, "content div exists")
    assert.ok(content.querySelector("h2"), "header rendered as markdown")
    assert.ok(content.textContent.includes("bold idea"), "bold text present")
    assert.ok(content.querySelector("code"), "inline code rendered")
  })
})
