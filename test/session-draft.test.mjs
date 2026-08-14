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
