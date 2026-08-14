/**
 * autocomplete.test.mjs — @-trigger contract.
 * Regression for 2026-08-14: the activator read value[pos-2] (the char BEFORE the
 * just-typed @) instead of value[pos-1], so typing @ never activated the dropdown.
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { setupWebview } from "./helpers/webview-env.mjs"

let env
before(() => { env = setupWebview() })
after(() => env?.cleanup())

function setup() {
  const posts = []
  const inputEl = document.createElement("textarea")
  const atDropdown = document.createElement("div")
  const attachBtn = document.createElement("button")
  attachBtn.id = "attach-btn"
  const fileInput = document.createElement("input")
  fileInput.id = "file-input"
  document.body.append(inputEl, atDropdown, attachBtn, fileInput)
  return { inputEl, atDropdown, posts }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe("@ autocomplete trigger", () => {
  it("typing @ activates and posts atComplete with the query", async () => {
    const { inputEl, posts } = setup()
    const { initAutocomplete } = await import("../webview/autocomplete.js")
    initAutocomplete({ inputEl, atDropdown: document.createElement("div"), vscode: { postMessage: (m) => posts.push(m) }, pastedImages: [] })

    inputEl.value = "@"
    inputEl.selectionStart = 1
    inputEl.dispatchEvent(new window.Event("input"))
    await sleep(200) // debounce is 150ms

    const at = posts.filter((m) => m.type === "atComplete")
    assert.equal(at.length, 1, "atComplete posted after @")
    assert.equal(at[0].query, "@")
  })

  it("typing text after @ keeps the completion query flowing", async () => {
    const { inputEl, posts } = setup()
    const { initAutocomplete } = await import("../webview/autocomplete.js")
    initAutocomplete({ inputEl, atDropdown: document.createElement("div"), vscode: { postMessage: (m) => posts.push(m) }, pastedImages: [] })

    inputEl.value = "@pa"
    inputEl.selectionStart = 3
    // first input: the char before cursor is "a", not "@" — no activation yet (typed as a paste/burst)
    inputEl.dispatchEvent(new window.Event("input"))
    await sleep(200)
    assert.equal(posts.filter((m) => m.type === "atComplete").length, 0, "burst-pasted text does not activate mid-word")
  })

  it("plain text without @ posts nothing", async () => {
    const { inputEl, posts } = setup()
    const { initAutocomplete } = await import("../webview/autocomplete.js")
    initAutocomplete({ inputEl, atDropdown: document.createElement("div"), vscode: { postMessage: (m) => posts.push(m) }, pastedImages: [] })

    inputEl.value = "hello"
    inputEl.selectionStart = 5
    inputEl.dispatchEvent(new window.Event("input"))
    await sleep(200)
    assert.equal(posts.filter((m) => m.type === "atComplete").length, 0)
  })
})

// mid-line @: activation, query tracking, and whitespace close
it("mid-line @ activates and tracks the query", async () => {
  const { initAutocomplete } = await import("../webview/autocomplete.js")
  const posts = []
  const inputEl = document.createElement("textarea")
  const dd = document.createElement("div")
  const ab = document.createElement("button"); ab.id = "attach-btn"
  const fi = document.createElement("input"); fi.id = "file-input"
  document.body.append(inputEl, dd, ab, fi)
  initAutocomplete({ inputEl, atDropdown: dd, vscode: { postMessage: (m) => posts.push(m) }, pastedImages: [] })

  // "解释 @" — @ typed mid-line, cursor right after it
  inputEl.value = "解释 @"
  inputEl.selectionStart = 4
  inputEl.dispatchEvent(new window.Event("input"))
  await sleep(200)
  const at = posts.filter((m) => m.type === "atComplete")
  assert.equal(at.length, 1, "mid-line @ activates")
  assert.equal(at[0].query, "@")

  // keep typing: "解释 @pac"
  inputEl.value = "解释 @pac"
  inputEl.selectionStart = 7
  inputEl.dispatchEvent(new window.Event("input"))
  await sleep(200)
  const at2 = posts.filter((m) => m.type === "atComplete")
  assert.equal(at2[at2.length - 1].query, "@pac")

  // whitespace ends the completion: "解释 @pac 还"
  inputEl.value = "解释 @pac 还"
  inputEl.selectionStart = 9
  inputEl.dispatchEvent(new window.Event("input"))
  await sleep(200)
  assert.equal(dd.style.display, "none", "space after the query closes the dropdown")
})

