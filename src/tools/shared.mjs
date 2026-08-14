/**
 * shared.mjs — Helper functions and constants shared across tool modules
 */

import { join, isAbsolute } from "node:path"
import * as vscode from "vscode"

export const BASH_TIMEOUT_MS = 120000

/** Maximum buffer size per stream (stdout / stderr) before truncation (CLI parity). */
export const MAX_STREAM_BUF = 2_000_000

/** Max chars in a finished tool result (CLI parity). */
export const MAX_OUTPUT_CHARS = 200_000

const ENCODING_DETECT_MAX_TRIM = 3

/** Incremental byte→text decoder with encoding detection (CLI shared.mjs parity).
 *  Plain ASCII fast path; UTF-8 with chunk-boundary safety (stream:true); GBK
 *  fallback for legacy Windows tools. Each call creates an independent instance —
 *  never share across parallel streams (internal state accumulates). */
export function makeDecoder() {
  let decoder = null
  let pending = Buffer.alloc(0)
  return (d, flush = false) => {
    pending = Buffer.concat([pending, d])
    if (!decoder) {
      const hasHighByte = pending.some((b) => b >= 0x80)
      if (!hasHighByte) { const s = pending.toString("ascii"); pending = Buffer.alloc(0); return s }
      for (let trim = 0; trim <= ENCODING_DETECT_MAX_TRIM && !decoder; trim++) {
        try { new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, pending.length - trim)); decoder = new TextDecoder("utf-8") }
        catch { /* continue */ }
      }
      if (!decoder) decoder = new TextDecoder("gbk")
    }
    const s = decoder.decode(pending, { stream: !flush })
    pending = Buffer.alloc(0)
    return s
  }
}

/** Strip ANSI escape sequences and normalize newlines (CLI shared.mjs parity). */
export function sanitizeOutput(s) {
  return s
    // eslint-disable-next-line no-control-regex -- ANSI stripping legitimately matches control chars
    .replace(/\x1b\[[0-9;?]*[\x40-\x7E]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>#][0-9]?/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

/** Get the open TextDocument for a path, or null if not open */
export function getOpenDoc(absPath) {
  try {
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === absPath) || null
  } catch { return null }
}

/** Refresh the built-in Markdown preview after writing a .md file — the preview
 *  caches rendered content and can keep showing stale output after agent-side
 *  writes (2026-08-14 user report). No-op for non-markdown paths / when no
 *  preview is open. */
export function refreshMarkdownPreview(absPath) {
  if (!/\.(?:md|markdown|mdown)$/i.test(absPath)) return
  vscode.commands.executeCommand("markdown.preview.refresh").then(undefined, () => { /* no preview open — fine */ })
}

/** Apply a full text replacement to an open document via WorkspaceEdit.
 *  SAVES after applying — without the save the buffer goes dirty while the disk
 *  stays stale: the next edit hits the isDirty guard (locked by our own edit),
 *  and any external write races the user's later save (split-brain data loss). */
export async function applyEditorEdit(doc, fullText) {
  const edit = new vscode.WorkspaceEdit()
  const range = new vscode.Range(0, 0, doc.lineCount, 0)
  edit.replace(doc.uri, range, fullText)
  await vscode.workspace.applyEdit(edit)
  await doc.save()
  refreshMarkdownPreview(doc.uri.fsPath)
}

/** Apply a range replacement to an open document via WorkspaceEdit.
 *  Saves after applying (see applyEditorEdit — unsaved edits self-lock the
 *  isDirty guard and race external writers). */
export async function applyEditorRangeEdit(doc, startLine, startCol, endLine, endCol, newText) {
  const edit = new vscode.WorkspaceEdit()
  const range = new vscode.Range(startLine, startCol, endLine, endCol)
  edit.replace(doc.uri, range, newText)
  await vscode.workspace.applyEdit(edit)
  await doc.save()
  refreshMarkdownPreview(doc.uri.fsPath)
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

import { execFileSync, spawn } from "node:child_process"

/**
 * Run a child process INTERRUPTIBLY (spawn, not execSync).
 * execSync blocks the extension-host event loop — a Stop click during a long
 * lint/verify run could not even be DELIVERED until the command finished.
 * This spawns asynchronously and kills the child on abort/timeout.
 *
 * Success → resolves the stdout string (execFileSync-compatible call sites).
 * Non-zero exit / spawn error / timeout / abort → rejects an Error whose
 * .stdout/.stderr/.code are populated like execFileSync's error.
 */
export function runInterruptible(cmd, args, opts = {}) {
  const { cwd, timeout, signal, env } = opts
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    } catch (e) {
      reject(e)
      return
    }
    let stdout = "", stderr = "", settled = false, timer = null

    const finish = (err, out) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (err) {
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      } else {
        resolve(out)
      }
    }

    const onAbort = () => {
      child.kill()
      const e = new Error("aborted by user (Stop)")
      e.name = "AbortError"
      finish(e)
    }

    if (timeout) {
      timer = setTimeout(() => {
        child.kill()
        const e = new Error(`timed out after ${timeout}ms`)
        e.name = "TimeoutError"
        finish(e)
      }, timeout)
    }

    child.stdout?.on("data", (d) => { stdout += d })
    child.stderr?.on("data", (d) => { stderr += d })
    child.on("error", (e) => finish(e))
    child.on("close", (code) => {
      if (code === 0) finish(null, stdout)
      else {
        const e = new Error(`command failed with exit code ${code}`)
        e.code = code
        finish(e)
      }
    })

    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}


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

/** SSRF guard (CLI parity): TRUE for private/internal hostnames — callers block them.
 *  Covers loopback, link-local, cloud metadata, IPv6 private ranges, and the
 *  RFC1918 IPv4 prefixes. Invalid/unknown hosts return false (harmless for SSRF). */
export function isPrivateHost(hostname) {
  const h = hostname.toLowerCase()
  if (h === "localhost" || h === "0.0.0.0" || h.endsWith(".localhost")) return true
  if (h === "127.0.0.1" || h.startsWith("127.")) return true
  if (h === "169.254.169.254" || h === "metadata.google.internal") return true
  if (h.includes(":")) {
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd")) return true
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || a === 192 && b === 168 || a === 169 && b === 254 || a === 0) return true
  }
  return false
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

