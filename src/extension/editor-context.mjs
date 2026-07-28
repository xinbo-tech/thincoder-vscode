/**
 * editor-context.mjs — inject active editor content into prompt
 * Extracted from extension.mjs ChatPanel class.
 */

import * as vscode from "vscode"

/** Read active editor and append selected/full file content to the prompt text */
export function injectEditorContext(text, cwd) {
  const activeEditor = vscode.window.activeTextEditor
  if (!activeEditor || !activeEditor.document.uri.fsPath.startsWith(cwd)) return text

  const relPath = activeEditor.document.uri.fsPath.slice(cwd.length + 1)
  const selection = activeEditor.selection
  const doc = activeEditor.document
  const hasSelection = !selection.isEmpty
  const contextText = hasSelection
    ? doc.getText(selection).slice(0, 3000)
    : doc.getText().slice(0, 3000)
  if (!contextText) return text

  const rangeInfo = hasSelection
    ? `lines ${selection.start.line + 1}-${selection.end.line + 1}`
    : `full file (first 3000 chars)`
  return `${text}\n\n[Current file: ${relPath} (${rangeInfo})\n\`\`\`\n${contextText}\n\`\`\`]`
}
