/**
 * project-switcher.test.mjs — multi-root "current project" switching (PROJECT-SWITCHER.md).
 * Covers the cwd override (panel-messages) and the ChatPanel rebind flow.
 * Mock vscode like chat-panel.test.mjs: stub workspace.workspaceFolders, never assert
 * on the mock itself.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as vscode from "vscode"

import { _cwd, setProjectFolder, clearProjectOverride } from "../src/extension/panel-messages.mjs"
import { newSlot, activeSlot, _setSessionsDirForTest, _resetSessionsDirForTest } from "../src/extension/session-io.mjs"

let dirA
let dirB

beforeEach(() => {
  dirA = mkdtempSync(join(tmpdir(), "tc-proj-a-"))
  dirB = mkdtempSync(join(tmpdir(), "tc-proj-b-"))
  _setSessionsDirForTest(join(dirA, "sessions")) // 注入 tmp——hash 按 cwd 隔离，两项目互不影响
  clearProjectOverride()
  vscode.workspace.workspaceFolders = [
    { name: "A", uri: { fsPath: dirA } },
    { name: "B", uri: { fsPath: dirB } },
  ]
})

afterEach(() => {
  _resetSessionsDirForTest()
  clearProjectOverride()
  vscode.workspace.workspaceFolders = []
  rmSync(dirA, { recursive: true, force: true })
  rmSync(dirB, { recursive: true, force: true })
})

describe("cwd override — panel-messages", () => {
  it("defaults to workspaceFolders[0]", () => {
    assert.equal(_cwd(), dirA)
  })

  it("setProjectFolder switches the cwd to another root", () => {
    const r = setProjectFolder(dirB)
    assert.equal(r.ok, true)
    assert.equal(_cwd(), dirB)
  })

  it("rejects a path that is not a workspace folder", () => {
    const r = setProjectFolder(join(tmpdir(), "not-a-root"))
    assert.equal(r.ok, false)
    assert.match(r.error, /Not a workspace folder/)
    assert.equal(_cwd(), dirA, "cwd unchanged after rejection")
  })

  it("clearProjectOverride falls back to workspaceFolders[0]", () => {
    setProjectFolder(dirB)
    clearProjectOverride()
    assert.equal(_cwd(), dirA)
  })
})

describe("ChatPanel — project info + rebind", () => {
  function makePanel() {
    const context = {
      globalStorageUri: { fsPath: dirA },
      workspaceState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    }
    return context
  }

  it("_projectInfo reports multi + current + followActive", async () => {
    const { ChatPanel } = await import("../src/extension/chat-panel.mjs")
    const context = makePanel()
    const panel = new ChatPanel(context)

    let info = panel._projectInfo()
    assert.equal(info.multi, true)
    assert.equal(info.current, dirA)
    assert.equal(info.folders.length, 2)
    assert.equal(info.followActive, false) // mock getConfiguration → undefined → false

    setProjectFolder(dirB)
    info = panel._projectInfo()
    assert.equal(info.current, dirB)
  })

  it("_projectInfo followActive reflects the setting", async () => {
    const saved = vscode.workspace.getConfiguration
    vscode.workspace.getConfiguration = () => ({ get: () => true })
    try {
      const { ChatPanel } = await import("../src/extension/chat-panel.mjs")
      const panel = new ChatPanel(makePanel())
      assert.equal(panel._projectInfo().followActive, true)
    } finally {
      vscode.workspace.getConfiguration = saved
    }
  })

  it("_onProjectChanged rebinds the slot to the NEW cwd's active session", async () => {
    // Prepare one slot per project; make B's slot the active one there.
    newSlot(dirA)
    newSlot(dirB)
    const activeInB = activeSlot(dirB)

    const { ChatPanel } = await import("../src/extension/chat-panel.mjs")
    const panel = new ChatPanel(makePanel())
    // Keep the test hermetic: no real index/embedder/prompt side effects.
    panel._getEmbedder = () => null
    panel._maybePromptIndex = async () => {}

    setProjectFolder(dirB)
    await panel._onProjectChanged()

    assert.equal(panel._slot, activeInB, "panel bound to the new project's session")
    assert.equal(panel._activeData().cwd, dirB, "session data comes from the new cwd")
  })

  it("_applyProjectSwitch refuses while a turn is running", async () => {
    const { ChatPanel } = await import("../src/extension/chat-panel.mjs")
    const panel = new ChatPanel(makePanel())
    panel._turnActive = true
    await panel._applyProjectSwitch(dirB)
    assert.equal(_cwd(), dirA, "cwd unchanged while a turn is active")
  })
})
