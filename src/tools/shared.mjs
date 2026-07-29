/**
 * shared.mjs — Helper functions and constants shared across tool modules
 */

import { join, isAbsolute } from "node:path"
import * as vscode from "vscode"

export const BASH_TIMEOUT_MS = 120000

/** Get the open TextDocument for a path, or null if not open */
export function getOpenDoc(absPath) {
  try {
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === absPath) || null
  } catch { return null }
}

/** Apply a full text replacement to an open document via WorkspaceEdit */
export async function applyEditorEdit(doc, fullText) {
  const edit = new vscode.WorkspaceEdit()
  const range = new vscode.Range(0, 0, doc.lineCount, 0)
  edit.replace(doc.uri, range, fullText)
  await vscode.workspace.applyEdit(edit)
}

/** Apply a range replacement to an open document via WorkspaceEdit */
export async function applyEditorRangeEdit(doc, startLine, startCol, endLine, endCol, newText) {
  const edit = new vscode.WorkspaceEdit()
  const range = new vscode.Range(startLine, startCol, endLine, endCol)
  edit.replace(doc.uri, range, newText)
  await vscode.workspace.applyEdit(edit)
}

/** Resolve a path relative to cwd or absolute */
export function resolvePath(p, cwd) {
  if (isAbsolute(p)) return p
  return join(cwd, p)
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
