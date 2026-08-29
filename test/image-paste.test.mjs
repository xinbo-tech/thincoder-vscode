/**
 * image-paste.test.mjs — pasted-image pipeline regression (GitHub thincoder#3, Plan B)
 *
 * Two bugs locked here:
 * 1. webview/send.js: `ctx._pastedImages = []` orphanized the array shared BY
 *    REFERENCE with autocomplete.js (chat.js passes it into initAutocomplete) —
 *    the paste bar kept rendering the old array while send() read the new empty
 *    one, so only the first paste+send ever carried images.
 * 2. src/extension/image-handler.mjs savePastedImages had zero callers — the
 *    "pasted image never reaches the model" root cause. Plan B wires it into
 *    panel-messages userMessage: dataURLs → files under <cwd>/.thincoder/tmp/
 *    → PATHS into _chat → setupAgentRun appends the "[Attached images: ...]"
 *    pointer → model views via read_image.
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setupWebview } from "./helpers/webview-env.mjs"
import { runAgent } from "../src/agent.mjs"

// 1x1 transparent PNG — dataURL prefix + base64 body
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const PNG_URL = `data:image/png;base64,${PNG_B64}`
const JPEG_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="

let env
before(() => {
  env = setupWebview()
  // state.js calls acquireVsCodeApi() at module top and RE-EXPORTS the handle —
  // route it into the same capturedPosts setupWebview's window._vscode feeds.
  globalThis.acquireVsCodeApi = () => ({
    postMessage: (m) => env.capturedPosts.push(m),
    getState: () => null,
    setState: () => {},
  })
})
after(() => {
  // panels.js registered a 2s autoCleanPanels interval (cleared on window unload) —
  // fire unload so the timer can't fire mid-teardown and touch a dropped DOM node.
  try { window.dispatchEvent(new window.Event("unload")) } catch { /* noop */ }
  env?.cleanup()
})

// ─── Bug 1: send() must not orphanize the shared pastedImages array ─────────

describe("webview send — pasted images alias regression (GitHub thincoder#3 bug 1)", () => {
  function installFixture() {
    const el = (id, tag = "div") => {
      const n = document.createElement(tag)
      n.id = id
      document.body.appendChild(n)
      return n
    }
    const inputEl = el("input", "textarea")
    const messagesEl = el("messages")
    const sendBtn = el("send-btn", "button")
    const abortBtn = el("abort-btn", "button")
    const sessionTitle = el("session-title")
    el("paste-bar")
    el("paste-badge")
    // autocomplete.js file-upload wiring needs these two (attach-btn click → file-input click)
    el("attach-btn", "button")
    el("file-input", "input")
    // send() → clearPanels() hides the three side panels by id
    el("subagent-panel")
    el("goal-panel")
    el("task-panel")
    return { inputEl, messagesEl, sendBtn, abortBtn, sessionTitle }
  }

  it("two paste→send cycles both post non-empty images equal to what was pasted", async () => {
    const dom = installFixture()
    // Dynamic import AFTER happy-dom registration (state.js touches document at module top)
    const state = await import("../webview/state.js")
    const ctx = state.ctx
    // Point ctx's DOM refs at this fixture (module-top getElementById ran before it existed)
    ctx.inputEl = dom.inputEl
    ctx.messagesEl = dom.messagesEl
    ctx.sendBtn = dom.sendBtn
    ctx.abortBtn = dom.abortBtn
    ctx.sessionTitle = dom.sessionTitle

    // chat.js wiring under test: autocomplete receives the array BY REFERENCE
    const { initAutocomplete } = await import("../webview/autocomplete.js")
    const { send } = await import("../webview/send.js")
    const { capturedPosts } = env
    initAutocomplete({
      inputEl: dom.inputEl,
      atDropdown: document.createElement("div"),
      vscode: state.vscode,
      pastedImages: ctx._pastedImages, // ← same array instance send() must keep honoring
    })
    // autocomplete.js renders the paste bar via getElementById — the fixture supplies them

    // ── cycle 1: paste one image, send ──
    ctx._pastedImages.push(PNG_URL) // what readImageFile's FileReader.onload does
    dom.inputEl.value = "first look"
    send()
    const post1 = capturedPosts.filter((m) => m.type === "userMessage").at(-1)
    assert.ok(post1, "cycle 1 posted userMessage")
    assert.deepEqual(post1.images, [PNG_URL], "cycle 1 carries the pasted dataURL")
    assert.equal(ctx._pastedImages.length, 0, "shared array cleared in place after send")

    // ── cycle 2: paste a DIFFERENT image, send again — the regression: this used to post images: [] ──
    ctx._pastedImages.push(JPEG_URL)
    ctx.isRunning = false // reset between turns
    dom.inputEl.value = "second look"
    send()
    const post2 = capturedPosts.filter((m) => m.type === "userMessage").at(-1)
    assert.ok(post2, "cycle 2 posted userMessage")
    assert.deepEqual(post2.images, [JPEG_URL], "cycle 2 ALSO carries its pasted dataURL (alias bug fixed)")

    // ── the ✕-chip delete path still mutates the SAME array autocomplete renders ──
    ctx._pastedImages.push(PNG_URL, JPEG_URL)
    ctx._pastedImages.splice(0, 1) // what the paste-chip ✕ click handler does
    assert.deepEqual(ctx._pastedImages, [JPEG_URL], "shared identity preserved for chip deletion")
  })
})

// ─── savePastedImages: dataURL → files under <cwd>/.thincoder/tmp/ ──────────

describe("savePastedImages — dataURL to file (Plan B)", () => {
  it("saves a png dataURL: file exists, .png extension, bytes round-trip", async () => {
    const { savePastedImages } = await import("../src/extension/image-handler.mjs")
    const dir = mkdtempSync(join(tmpdir(), "tc-paste-"))
    try {
      const paths = savePastedImages([PNG_URL], dir)
      assert.equal(paths.length, 1, "one path returned")
      assert.ok(existsSync(paths[0]), "file landed on disk")
      assert.match(paths[0], /paste-[a-z0-9]+-0\.png$/, "paste-* naming with .png ext (in .thincoder/tmp)")
      assert.ok(paths[0].includes(join(".thincoder", "tmp")), "inside <cwd>/.thincoder/tmp (offloadToolResult sweep covers it)")
      const written = readFileSync(paths[0])
      assert.ok(written.length > 0, "non-empty payload")
      assert.deepEqual(written.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]), "decoded PNG magic bytes")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("jpeg maps to .jpg extension", async () => {
    const { savePastedImages } = await import("../src/extension/image-handler.mjs")
    const dir = mkdtempSync(join(tmpdir(), "tc-paste-"))
    try {
      const paths = savePastedImages([JPEG_URL], dir)
      assert.equal(paths.length, 1)
      assert.match(paths[0], /\.jpg$/, "image/jpeg → .jpg")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("skips invalid entries, keeps valid ones (mixed input)", async () => {
    const { savePastedImages } = await import("../src/extension/image-handler.mjs")
    const dir = mkdtempSync(join(tmpdir(), "tc-paste-"))
    try {
      const paths = savePastedImages(["not a data url", PNG_URL, "data:text/html;base64,PGI+", "", null, JPEG_URL], dir)
      assert.equal(paths.length, 2, "only the two valid dataURLs landed")
      assert.match(paths[0], /\.png$/)
      assert.match(paths[1], /\.jpg$/)
      assert.equal(readdirSync(join(dir, ".thincoder", "tmp")).length, 2, "no junk files written for skipped entries")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("all-invalid input returns []", async () => {
    const { savePastedImages } = await import("../src/extension/image-handler.mjs")
    const dir = mkdtempSync(join(tmpdir(), "tc-paste-"))
    try {
      assert.deepEqual(savePastedImages(["garbage", 42, undefined], dir), [])
      assert.deepEqual(savePastedImages([], dir), [])
      assert.deepEqual(savePastedImages(undefined, dir), [])
      assert.ok(!existsSync(join(dir, ".thincoder")), "no directory created for empty/invalid input")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("creates the .thincoder/tmp directory recursively when missing", async () => {
    const { savePastedImages } = await import("../src/extension/image-handler.mjs")
    const dir = mkdtempSync(join(tmpdir(), "tc-paste-"))
    try {
      const paths = savePastedImages([PNG_URL], dir)
      assert.equal(paths.length, 1)
      assert.ok(existsSync(join(dir, ".thincoder", "tmp")), "nested path auto-created")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ─── setup.mjs injection: pointer appended to the REAL user message ─────────

describe("setupAgentRun image injection — pointer on the user message (Plan B)", () => {
  // Same trick as time-injection.test.mjs (setup has fully run before the first
  // chat call) — but the signal is PRE-aborted: the loop head's aborted check
  // (agent.mjs) throws before any network attempt, so capture is instant and
  // silent (no unreachable-host retry backoff, no ECONNREFUSED noise).
  const provider = (model) => ({ baseURL: "http://127.0.0.1:1", apiKey: "x", model })

  async function captureSetup(model, images) {
    const history = []
    const fullHistory = []
    let setupError = null
    const ac = new AbortController()
    ac.abort()
    try {
      await runAgent(provider(model), process.cwd(), "看这张图", {}, ac.signal, true, {
        history, fullHistory, mcpServers: [], skills: [], injections: [], images,
      })
    } catch (e) {
      setupError = e // AbortError at loop head / setup throw for the text-only model
    }
    return { history, fullHistory, setupError }
  }

  it("appends the pointer to the user message STRING — input kept, reminder untouched, fullHistory synced", async () => {
    const { history, fullHistory } = await captureSetup("kimi-k3", ["C:\\proj\\.thincoder\\tmp\\paste-abc-0.png"])
    const userMsg = history.find((m) => m.role === "user" && String(m.content).includes("看这张图"))
    assert.ok(userMsg, "user message present")
    assert.equal(typeof userMsg.content, "string", "content stays a STRING — no image_url parts array")
    assert.ok(userMsg.content.startsWith("看这张图"), "original input preserved verbatim at the front")
    assert.ok(userMsg.content.includes("[Attached images:"), "pointer appended")
    assert.ok(userMsg.content.includes("paste-abc-0.png"), "file path named in the pointer")
    assert.ok(userMsg.content.includes("read_image"), "model is told to use read_image")
    // Bug 2 regression: the LAST message is the transient time reminder and must be untouched
    const last = history.at(-1)
    assert.match(last.content, /current time is \d{4}-\d{2}-\d{2}/, "time reminder is the last message")
    assert.equal(last.transient, true)
    assert.ok(!last.content.includes("Attached images"), "time reminder NOT overwritten with the pointer (bug 2)")
    assert.notEqual(last, userMsg, "pointer did not land on the reminder object")
    // dual-line: the same (mutated) object is in the human line — session files show the attachment
    const fullUser = fullHistory.find((m) => m.role === "user" && String(m.content).includes("看这张图"))
    assert.equal(fullUser, userMsg, "pushReal reference identity — fullHistory sees the pointer too")
    assert.ok(fullUser.content.includes("[Attached images:"), "fullHistory content synced")
  })

  it("no images → user message is the bare input (no pointer)", async () => {
    const { history } = await captureSetup("kimi-k3", undefined)
    const userMsg = history.find((m) => m.role === "user" && m.content === "看这张图")
    assert.ok(userMsg, "bare user message present")
    assert.equal(userMsg.content, "看这张图")
  })

  it("text-only model + images still throws (non-multimodal guard kept)", async () => {
    // qwen3.7-max is the verified text-only id (DashScope 400 on image parts)
    const { setupError } = await captureSetup("qwen3.7-max", ["C:\\x\\paste-1.png"])
    assert.ok(setupError, "setup rejects")
    assert.match(setupError.message, /does not support pasted images/, "same guard, same message")
  })
})


// ─── setup.mjs injection: pointer appended to the REAL user message ─────────

describe("panel-messages userMessage — Plan B wiring", () => {
  it("with images: saves to disk under the workspace cwd and passes PATHS to _chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-paste-"))
    try {
      const vscode = await import("vscode")
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir } }]
      const { handlePanelMessage } = await import("../src/extension/panel-messages.mjs")
      let got
      const panel = { _chat: (...args) => { got = args } }
      await handlePanelMessage(panel, { type: "userMessage", text: "look", images: [PNG_URL] })
      assert.equal(got[0], "look")
      assert.ok(Array.isArray(got[4]) && got[4].length === 1, "5th arg is the path array")
      assert.match(got[4][0], /paste-[a-z0-9]+-0\.png$/, "_chat receives a PATH, not the dataURL")
      assert.ok(!String(got[4][0]).startsWith("data:"), "no dataURL leaks downstream")
      assert.ok(existsSync(got[4][0]), "the referenced file exists")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("without images: _chat 5th arg stays undefined (no save attempted)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-paste-"))
    try {
      const vscode = await import("vscode")
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir } }]
      const { handlePanelMessage } = await import("../src/extension/panel-messages.mjs")
      let got
      const panel = { _chat: (...args) => { got = args } }
      await handlePanelMessage(panel, { type: "userMessage", text: "plain" })
      assert.equal(got[4], undefined, "no images → undefined (runOpts.images falsy, setup skips injection)")
      assert.ok(!existsSync(join(dir, ".thincoder")), "nothing saved for a plain text message")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
