/**
 * editor-edit.test.mjs — the editor dual channel must SAVE after WorkspaceEdit.
 *
 * Regression for the 2026-08-13 split-brain incident: applyEditorEdit applied
 * the WorkspaceEdit but never saved, so the buffer went dirty while disk stayed
 * stale — the next edit self-locked on the isDirty guard, and external writers
 * raced the user's later save (two batches of changes were silently lost).
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import * as vscode from "vscode"
import { applyEditorEdit, applyEditorRangeEdit } from "../src/tools/shared.mjs"

function makeDoc(text, fsPath = "d:\\proj\\file.mjs") {
  const calls = []
  return {
    calls,
    uri: vscode.Uri.file(fsPath),
    isDirty: false,
    get lineCount() { return this._lines.length },
    _lines: text.split("\n"),
    _applyEdit(range, newText) {
      // Replace [start.line..end.line] span with newText (full-file shape)
      this._lines.splice(range.start.line, range.end.line - range.start.line, ...newText.split("\n"))
    },
    async save() { calls.push("save"); this.isDirty = false; return true },
  }
}

beforeEach(() => {
  vscode.workspace.textDocuments.length = 0
  vscode.workspace.applyEditCalls.length = 0
})

describe("markdown preview refresh after agent writes", () => {
  it("writing a .md file refreshes the built-in markdown preview", async () => {
    const calls = []
    const orig = vscode.commands.executeCommand
    vscode.commands.executeCommand = async (cmd) => { calls.push(cmd) }
    try {
      const doc = makeDoc("old", "d:\\proj\\README.md")
      vscode.workspace.textDocuments.push(doc)
      await applyEditorEdit(doc, "new")
      assert.deepEqual(calls, ["markdown.preview.refresh"])
    } finally {
      vscode.commands.executeCommand = orig
    }
  })

  it("writing a non-markdown file does NOT touch the preview", async () => {
    const calls = []
    const orig = vscode.commands.executeCommand
    vscode.commands.executeCommand = async (cmd) => { calls.push(cmd) }
    try {
      const doc = makeDoc("old", "d:\\proj\\app.mjs")
      vscode.workspace.textDocuments.push(doc)
      await applyEditorEdit(doc, "new")
      assert.deepEqual(calls, [])
    } finally {
      vscode.commands.executeCommand = orig
    }
  })
})

describe("editor dual channel saves after WorkspaceEdit", () => {
  it("applyEditorEdit applies the edit THEN saves the document", async () => {
    const doc = makeDoc("old content\nline2")
    vscode.workspace.textDocuments.push(doc)
    const order = []
    const origApply = vscode.workspace.applyEdit
    vscode.workspace.applyEdit = async (e) => { order.push("applyEdit"); return origApply(e) }
    const origSave = doc.save.bind(doc)
    doc.save = async () => { order.push("save"); return origSave() }

    await applyEditorEdit(doc, "new content\nline2")

    assert.deepEqual(order, ["applyEdit", "save"], "save must come after applyEdit")
    assert.equal(doc._lines[0], "new content", "edit was applied to the buffer")
    assert.equal(doc.isDirty, false, "document is clean after save (no self-lock on next edit)")
    vscode.workspace.applyEdit = origApply
  })

  it("applyEditorRangeEdit applies the range THEN saves", async () => {
    const doc = makeDoc("a\nb\nc")
    vscode.workspace.textDocuments.push(doc)
    let saved = false
    const origSave = doc.save.bind(doc)
    doc.save = async () => { saved = true; return origSave() }

    await applyEditorRangeEdit(doc, 1, 0, 1, 1, "B")

    assert.equal(saved, true, "range edit also saves")
    assert.equal(doc.isDirty, false)
  })
})
