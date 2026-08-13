/**
 * chat-panel.test.mjs — ChatPanel._saveLines session-write contract.
 * Focused regression: the extension must NOT preserve the CLI's `display`
 * (WYSIWYG render snapshot) — it doesn't maintain it, and the CLI resumes
 * from `display` in preference to `history`, so a stale snapshot hides every
 * message added in VS Code (user report: "TUI shows far fewer messages").
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
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
