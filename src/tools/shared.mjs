/**
 * shared.mjs — Helper functions and constants shared across tool modules
 */

import { join } from "node:path"
import * as vscode from "vscode"

export const BASH_TIMEOUT_MS = 120000

/** Check if a file is open in an editor with unsaved changes */
export function checkDirtyEditors(absPath) {
  try {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && doc.uri.fsPath === absPath) return `File has unsaved changes in the editor: ${absPath}. Save or discard before allowing automated edits.`
    }
  } catch { /* vscode not available (test env) */ }
  return null
}

/** Resolve a path relative to cwd or absolute */
export function resolvePath(p, cwd) {
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return p
  return join(cwd, p)
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
