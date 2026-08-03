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

// ─── Git helpers (CLI shared.mjs parity — keep in sync) ─────────

import { execFileSync } from "node:child_process"

/** Run git with args, return trimmed stdout ("" on failure). CLI parity. */
export function runGit(cwd, cmdArgs) {
  try {
    return execFileSync("git", cmdArgs, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/\r/g, "")
  } catch (e) {
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER: e.stdout contains partial output, return first 200 lines
    if (e.stdout) return String(e.stdout).trim().replace(/\r/g, "").split("\n").slice(0, 200).join("\n")
    return ""
  }
}

/** Unified diff of one file (for tool result feedback). CLI parity. */
export function gitDiffOne(cwd, abs) {
  try {
    const diff = execFileSync("git", ["--no-pager", "diff", "--no-color", "--", abs], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 10 * 1024 * 1024,
    }).trim()
    if (!diff) return ""
    const lines = diff.split("\n")
    if (lines.length <= 200) return diff
    return lines.slice(0, 200).join("\n") + `\n... (${lines.length - 200} more diff lines)`
  } catch (e) {
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && e.stdout) {
      const lines = e.stdout.toString().split("\n")
      return lines.slice(0, 200).join("\n") + `\n... (diff too large, showing first 200 of more lines)`
    }
    return ""
  }
}

/** Normalize CRLF to LF (hash/compare stability). CLI parity. */
export function normalizeEOL(text) {
  return text.replace(/\r\n/g, "\n")
}

/** Truncate text to max chars with a notice. CLI parity. */
export function truncate(text, max = 200_000) {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n[... truncated: ${text.length - max} chars omitted — redirect to a file if you need the full output]`
}

/** SHA256(line).slice(0,12) — the hashline_edit addressing algorithm. CLI parity. */
import { createHash } from "node:crypto"
export function hashLine(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 12)
}

