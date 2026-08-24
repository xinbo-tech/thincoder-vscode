/**
 * chat-panel.test.mjs — ChatPanel._saveLines session-write contract.
 * Focused regression: the extension must NOT preserve the CLI's `display`
 * (WYSIWYG render snapshot) — it doesn't maintain it, and the CLI resumes
 * from `display` in preference to `history`, so a stale snapshot hides every
 * message added in VS Code (user report: "TUI shows far fewer messages").
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as vscode from "vscode"
import { loadSlot } from "../src/extension/session-io.mjs"

let tmp
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tc-panel-"))
  // _cwd() reads vscode.workspace.workspaceFolders[0].uri.fsPath — point it at tmp
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmp } }]
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe("ChatPanel._saveLines — display cleared (CLI resume parity)", () => {
  it("persists history but clears display so the CLI rebuilds from history", async () => {
    const { ChatPanel } = await import("../src/extension/chat-panel.mjs")
    const panel = new ChatPanel({
      globalStorageUri: { fsPath: tmp },
      workspaceState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    })

    const lines = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]
    panel._saveLines(lines, lines, { activeProvider: "deepseek" })

    const data = loadSlot(tmp, 1)
    assert.ok(data, "slot written")
    assert.equal(data.history.length, 2, "history persisted")
    assert.deepEqual(data.display, [], "display must be cleared (CLI falls back to history)")
  })

  it("clears a PRE-EXISTING stale display (CLI snapshot from before VS Code edits)", async () => {
    const { ChatPanel } = await import("../src/extension/chat-panel.mjs")
    const panel = new ChatPanel({
      globalStorageUri: { fsPath: tmp },
      workspaceState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    })

    // Simulate a stale CLI snapshot already in the slot
    panel._saveLines([{ role: "user", content: "old" }], [{ role: "user", content: "old" }], { activeProvider: "deepseek" })
    const { saveSessionToSlot } = await import("../src/extension/session-io.mjs")
    const stale = loadSlot(tmp, 1)
    stale.display = [{ text: "stale line", color: "dim" }]
    saveSessionToSlot(tmp, 1, stale)

    // A further VS Code turn must wipe that stale snapshot
    panel._saveLines(
      [{ role: "user", content: "old" }, { role: "assistant", content: "new" }],
      [{ role: "user", content: "old" }, { role: "assistant", content: "new" }],
      { activeProvider: "deepseek" },
    )
    assert.deepEqual(loadSlot(tmp, 1).display, [], "stale display cleared on VS Code write")
  })
})

describe("panel message routing — setAdvisorGuard (2026-08-21 advisor switch refactor)", () => {
  let cfgPath
  beforeEach(() => {
    cfgPath = join(tmp, "config.json")
    // Route config-io writes into the sandbox (same pattern as settings-panel.test.mjs)
  })

  it("setAdvisorGuard true → config.json advisor.guard === true, no enabled key written", async () => {
    const { _setConfigPathForTest, loadRaw } = await import("../src/config-io.mjs")
    _setConfigPathForTest(cfgPath)
    const { handlePanelMessage } = await import("../src/extension/panel-messages.mjs")
    const panel = { _pushSettingsLight: () => {} }
    await handlePanelMessage(panel, { type: "setAdvisorGuard", value: true })
    const raw = loadRaw()
    assert.equal(raw.agent.advisor.guard, true, "guard persisted from the toolbar switch")
    assert.ok(!("enabled" in raw.agent.advisor), "deprecated advisor.enabled is never written")
  })

  it("setAdvisorGuard false → advisor.guard === false", async () => {
    const { _setConfigPathForTest, loadRaw } = await import("../src/config-io.mjs")
    _setConfigPathForTest(cfgPath)
    const { handlePanelMessage } = await import("../src/extension/panel-messages.mjs")
    const panel = { _pushSettingsLight: () => {} }
    await handlePanelMessage(panel, { type: "setAdvisorGuard", value: false })
    assert.equal(loadRaw().agent.advisor.guard, false)
  })

  it("legacy setAdvisorEnabled message is a no-op (no config write)", async () => {
    const { _setConfigPathForTest, loadRaw } = await import("../src/config-io.mjs")
    _setConfigPathForTest(cfgPath)
    const { handlePanelMessage } = await import("../src/extension/panel-messages.mjs")
    const panel = { _pushSettingsLight: () => {} }
    await handlePanelMessage(panel, { type: "setAdvisorEnabled", value: true })
    assert.equal(loadRaw().agent, undefined, "unknown legacy message type must not write anything")
  })
})


// ─── Async distillation — panel save + slot guard + rapid-fire (SEND-STALL-DISTILL) ────────────

/** One-frame SSE replies (same shape as continue-on-turn-cap.test.mjs). */
const sseTurn = (content) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
const sseTools = (toolCalls) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
const readCalls = () => ["a.mjs", "b.mjs", "c.mjs"].map((f, i) => ({
  index: i, id: `call_${i}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: f }) },
}))

/** Scripted local provider: onRequest(index, body) → SSE string | { status, body } (may be async). */
async function scriptedLLMServer(onRequest) {
  const http = await import("node:http")
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      requests.push(body)
      Promise.resolve(onRequest(requests.length, body))
        .then((r) => {
          if (r && r.status) { res.writeHead(r.status, { "Content-Type": "application/json" }); res.end(r.body ?? ""); return }
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          res.end(r)
        })
        .catch(() => { try { res.writeHead(500); res.end() } catch { /* socket already closed (client abort) */ } })
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  return { server, port: server.address().port, requests }
}

describe("async distillation — panel save + slot guard + rapid-fire (SEND-STALL-DISTILL)", () => {
  // Distill requests are a single user message carrying EXPLORE_SUMMARY_PROMPT. Detect by
  // message shape + prompt prefix — a raw body.includes() on the prompt fails because JSON
  // escapes the trailing newline (\\n in the wire body).
  const isDistillReq = (body) => {
    try {
      const m = JSON.parse(body)?.messages
      return m?.length === 1 && m[0]?.role === "user" && typeof m[0]?.content === "string"
        && m[0].content.startsWith("You are distilling exploration tool results")
    } catch { return false }
  }
  const noteIn = (ctx) => ctx.some((m) => typeof m.content === "string" && m.content.startsWith("[Exploration summary]"))

  /** Real ChatPanel bound to a stub webview, provider routed to the scripted server. */
  async function makePanel(port, posted) {
    const { ChatPanel } = await import("../src/extension/chat-panel.mjs")
    const { _setConfigPathForTest } = await import("../src/config-io.mjs")
    _setConfigPathForTest(join(tmp, "config.json"))
    writeFileSync(join(tmp, "config.json"), JSON.stringify({
      providers: [{ name: "t", baseURL: `http://127.0.0.1:${port}`, model: "unknown-model", apiKey: "sk-test" }],
      activeProvider: "t",
    }))
    const panel = new ChatPanel({
      globalStorageUri: { fsPath: tmp },
      workspaceState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    })
    panel._panel = { webview: { postMessage: async (m) => posted.push(m) } }
    return panel
  }

  const mkFiles = () => { for (const f of ["a.mjs", "b.mjs", "c.mjs"]) writeFileSync(join(tmp, f), "x\n") }

  it("AC5 — onDistilled re-saves: the session file ends with the compressed machine line", async () => {
    const { server, port } = await scriptedLLMServer(async (i, body) => {
      if (isDistillReq(body)) {
        await new Promise((r) => setTimeout(r, 2000))
        return sseTurn("panel async summary")
      }
      if (i === 1) return sseTools(readCalls())
      return sseTurn("panel final")
    })
    try {
      mkFiles()
      const panel = await makePanel(port, [])
      await panel._chat("first message", undefined, undefined, "t")
      assert.ok(panel._distillState.pending instanceof Promise, "distill pending after the turn")
      await panel._distillState.pending

      const data = loadSlot(tmp, panel._slot)
      assert.ok(data, "session written")
      assert.ok(noteIn(data.contextHistory ?? []), "contextHistory contains the summary note (AC5)")
      assert.ok(!data.history.some((m) => typeof m.content === "string" && m.content.startsWith("[Exploration summary]")), "human line never compressed")
    } finally {
      server.close()
    }
  })

  it("AC6 — slot switch while distill in flight: compressed history is NOT written into the new session", async () => {
    const { server, port } = await scriptedLLMServer(async (i, body) => {
      if (isDistillReq(body)) {
        await new Promise((r) => setTimeout(r, 2000))
        return sseTurn("async summary")
      }
      if (i === 1) return sseTools(readCalls())
      return sseTurn("done")
    })
    try {
      mkFiles()
      // Pre-create slot 2 so the "must stay clean" assertion is meaningful
      const { saveSessionToSlot } = await import("../src/extension/session-io.mjs")
      saveSessionToSlot(tmp, 2, { version: 2, cwd: tmp, updatedAt: Date.now(), title: "", history: [], contextHistory: [], display: [], tasks: [], planMode: false, autoApprove: false, engineering: false })
      const panel = await makePanel(port, [])
      panel._slot = 1
      await panel._chat("first message", undefined, undefined, "t")
      assert.ok(panel._distillState.pending instanceof Promise)
      panel._slot = 2   // user switched sessions while the distill is in flight
      await panel._distillState.pending

      const slot1 = loadSlot(tmp, 1)
      const slot2 = loadSlot(tmp, 2)
      assert.ok(!noteIn(slot2.contextHistory ?? []), "new session must not receive the old turn's compressed line (AC6)")
      assert.equal(slot2.history.length, 0, "new session untouched")
      assert.ok(!noteIn(slot1.contextHistory ?? []), "old session keeps the onComplete (uncompressed) save")
    } finally {
      server.close()
    }
  })

  it("AC6a — rapid second message does not abort the distill; run 2 starts from the compressed line", async () => {
    const { server, port, requests } = await scriptedLLMServer(async (i, body) => {
      if (isDistillReq(body)) {
        await new Promise((r) => setTimeout(r, 2000))
        return sseTurn("async summary")
      }
      if (i === 1) return sseTools(readCalls())
      return sseTurn("done")
    })
    try {
      mkFiles()
      const panel = await makePanel(port, [])
      await panel._chat("first message", undefined, undefined, "t")
      const controller = panel._distillController
      assert.ok(controller && !controller.signal.aborted, "distill controller active")
      assert.ok(panel._distillState.pending instanceof Promise, "distill in flight")

      await panel._chat("second message", undefined, undefined, "t")   // rapid-fire: must NOT abort the distill
      assert.equal(controller.signal.aborted, false, "distill not aborted by the second message (AC6a)")
      assert.equal(panel._distillController, controller, "controller not recreated per turn")

      const run2 = requests.find((b) => !isDistillReq(b) && b.includes("second message"))
      assert.ok(run2, "second-run request captured")
      const msgs = JSON.parse(run2).messages
      const ni = msgs.findIndex((m) => typeof m.content === "string" && m.content.startsWith("[Exploration summary]"))
      const ii = msgs.findIndex((m) => typeof m.content === "string" && m.content.includes("second message"))
      assert.ok(ni >= 0 && ii > ni, "run 2 starts from the compressed machine line (summary before input)")
    } finally {
      server.close()
    }
  })

  it("review #1 — session switch (loadSession) aborts the in-flight distill", async () => {
    const { server, port } = await scriptedLLMServer(async (i, body) => {
      if (isDistillReq(body)) {
        await new Promise((r) => setTimeout(r, 3000))
        return sseTurn("never lands")
      }
      if (i === 1) return sseTools(readCalls())
      return sseTurn("done")
    })
    try {
      mkFiles()
      const panel = await makePanel(port, [])
      await panel._chat("first message", undefined, undefined, "t")
      const controller = panel._distillController
      assert.ok(controller && !controller.signal.aborted)
      await panel._loadSession()   // session switch → abort hook
      assert.equal(controller.signal.aborted, true, "distill controller aborted on session switch")
      assert.equal(await panel._distillState.pending, null, "aborted distill resolves null")
      const data = loadSlot(tmp, panel._slot)
      assert.ok(!noteIn(data?.contextHistory ?? []), "no compressed note saved after abort")
    } finally {
      server.close()
    }
  })
})
