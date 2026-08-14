/**
 * file-links.test.mjs — workspace-real path extraction for clickable tool-card links,
 * plus the native-diff and completion-notification helpers.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as vscode from "vscode"
import { extractFileLinks } from "../src/extension/file-links.mjs"
import { openDiffPreview } from "../src/extension/diff-preview.mjs"
import { notifyCompletionIfUnfocused } from "../src/extension/notify.mjs"

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thincoder-links-"))
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src", "app.mjs"), "x")
  writeFileSync(join(dir, "README.md"), "x")
})
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

describe("extractFileLinks", () => {
  it("links only paths that exist on disk (relative to cwd)", () => {
    const links = extractFileLinks(dir, "Wrote 42 chars to src/app.mjs and touched ghost/none.mjs")
    assert.equal(links.length, 1)
    assert.equal(links[0].raw, "src/app.mjs")
    assert.equal(links[0].path, join(dir, "src", "app.mjs"))
  })

  it("captures :line suffixes and skips URLs", () => {
    const links = extractFileLinks(dir, "see README.md:12 and https://example.com/a.png")
    assert.equal(links.length, 1)
    assert.equal(links[0].line, 12)
  })

  it("dedupes and stays silent on path-free output", () => {
    assert.equal(extractFileLinks(dir, "hello world, nothing here").length, 0)
    assert.equal(extractFileLinks(dir, "src/app.mjs src/app.mjs").length, 1)
  })
})

describe("openDiffPreview", () => {
  it("old/new diff opens vscode.diff with virtual documents", async () => {
    const calls = []
    const orig = vscode.commands.executeCommand
    vscode.commands.executeCommand = async (cmd, ...args) => { calls.push([cmd, ...args]) }
    try {
      await openDiffPreview({ old: "a\n", new: "b\n", path: "src/app.mjs" })
      assert.equal(calls.length, 1)
      assert.equal(calls[0][0], "vscode.diff")
      assert.match(String(calls[0][1]), /thincoder-diff:.*\/old\//)
      assert.match(String(calls[0][2]), /\/new\//)
    } finally { vscode.commands.executeCommand = orig }
  })

  it("patch diff opens a plain diff-language document", async () => {
    const docs = []
    const origOpen = vscode.workspace.openTextDocument
    vscode.workspace.openTextDocument = async (arg) => { docs.push(arg); return origOpen(arg) }
    try {
      await openDiffPreview({ patch: "@@ -1 +1 @@\n-a\n+b" })
      assert.equal(docs.length, 1)
      assert.equal(docs[0].language, "diff")
    } finally { vscode.workspace.openTextDocument = origOpen }
  })
})

describe("notifyCompletionIfUnfocused", () => {
  it("focused window → no notification; unfocused → notification + View focuses the panel", async () => {
    const origInfo = vscode.window.showInformationMessage
    const origCmd = vscode.commands.executeCommand
    const notes = []
    const cmds = []
    try {
      vscode.window.state.focused = true
      vscode.window.showInformationMessage = async (...a) => { notes.push(a); return undefined }
      notifyCompletionIfUnfocused()
      assert.equal(notes.length, 0, "focused → silent")

      vscode.window.state.focused = false
      vscode.window.showInformationMessage = async (...a) => { notes.push(a); return a[1] /* click "View" */ }
      vscode.commands.executeCommand = async (c) => { cmds.push(c) }
      notifyCompletionIfUnfocused()
      await new Promise((r) => setTimeout(r, 10))
      assert.equal(notes.length, 1, "unfocused → notification")
      assert.deepEqual(cmds, ["workbench.view.extension.thincoder"], "View focuses the panel")
    } finally {
      vscode.window.showInformationMessage = origInfo
      vscode.commands.executeCommand = origCmd
      vscode.window.state.focused = true
    }
  })
})
