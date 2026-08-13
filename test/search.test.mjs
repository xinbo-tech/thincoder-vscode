/**
 * search.test.mjs — in-conversation search (Ctrl+F) integration (happy-dom).
 * Loads the real index.html body + chat.js, then drives the search bar.
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
  // chat.js calls the VS Code webview bridge acquireVsCodeApi() at module top —
  // stub it so the module initializes (messages captured via window._vscode).
  globalThis.acquireVsCodeApi = () => ({ postMessage: (m) => env.capturedPosts.push(m), getState: () => null, setState: () => {} })
  await import("../webview/chat.js")
})
after(() => env?.cleanup())

function typeSearch(query) {
  const input = document.getElementById("search-input")
  input.value = query
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
}

describe("in-conversation search (Ctrl+F)", () => {
  it("Ctrl+F opens the search bar", () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }))
    const bar = document.getElementById("search-bar")
    assert.ok(bar, "search bar created")
    assert.equal(bar.style.display, "flex")
  })

  it("typing highlights matches and shows the count", () => {
    const messagesEl = document.getElementById("messages")
    messagesEl.innerHTML = `<div class="message">hello world foo</div><div class="message">bar baz foo qux</div>`
    typeSearch("foo")
    const hits = messagesEl.querySelectorAll("mark.search-hit")
    assert.equal(hits.length, 2, "two 'foo' matches highlighted")
    assert.match(document.getElementById("search-count").textContent, /1\/2/)
  })

  it("next/prev moves the current match", () => {
    const messagesEl = document.getElementById("messages")
    messagesEl.innerHTML = `<div class="message">foo one</div><div class="message">foo two</div><div class="message">foo three</div>`
    typeSearch("foo")
    document.getElementById("search-next").click()
    assert.match(document.getElementById("search-count").textContent, /2\/3/)
    document.getElementById("search-prev").click()
    assert.match(document.getElementById("search-count").textContent, /1\/3/)
  })

  it("empty query and close clear the highlights", () => {
    const messagesEl = document.getElementById("messages")
    messagesEl.innerHTML = `<div class="message">foo bar</div>`
    typeSearch("foo")
    assert.ok(messagesEl.querySelectorAll("mark.search-hit").length > 0)
    document.getElementById("search-close").click()
    assert.equal(messagesEl.querySelectorAll("mark.search-hit").length, 0, "highlights cleared on close")
    assert.equal(messagesEl.textContent, "foo bar", "original text restored")
  })
})
