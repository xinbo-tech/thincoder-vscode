/**
 * tools.mjs — VS Code-adapted tools for the agent
 * Each tool: { name, description, parameters, execute(ctx) }
 */

import * as vscode from "vscode"
import { readFile, writeFile, access, stat } from "node:fs/promises"
import { readFileSync, existsSync } from "node:fs"
import { execSync } from "node:child_process"
import { join, dirname } from "node:path"
import { repoOutlineTool } from "./repomap.mjs"

const BASH_TIMEOUT_MS = 120000

// ─── file tools ──────────────────────────────────────────────

export const readTool = {
  name: "read",
  description:
    "Read a text file. Returns numbered lines. Use offset/limit to page large files.\n" +
    "Parameters:\n" +
    "- path (required): File path, relative to workspace or absolute\n" +
    "- offset: 1-based line number to start reading from\n" +
    "- limit: Max lines to return (default 2000)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      offset: { type: "number", description: "1-based line number to start from" },
      limit: { type: "number", description: "Max lines to return" },
    },
    required: ["path"],
  },
  async execute({ path, offset, limit }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    let text = await readFile(abs, "utf8")
    const lines = text.split("\n")
    const start = Math.max(0, (offset || 1) - 1)
    const end = limit ? start + limit : lines.length
    const chunk = lines.slice(start, end)
    return chunk.map((l, i) => `${String(start + i + 1).padStart(6, " ")}\t${l}`).join("\n")
  },
}

export const writeTool = {
  name: "write",
  description:
    "Write content to a file. Creates parent directories; overwrites existing file.\n" +
    "Parameters:\n" +
    "- path (required): File path, relative to workspace or absolute\n" +
    "- content (required): Full content to write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "Full content to write" },
    },
    required: ["path", "content"],
  },
  async execute({ path, content }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, "utf8")
    // Open in editor
    const doc = await vscode.workspace.openTextDocument(abs)
    await vscode.window.showTextDocument(doc, { preview: false })
    return `Wrote ${content.length} chars to ${path}`
  },
}

export const editTool = {
  name: "edit",
  description:
    "Edit a file by exact string replacement. old_string must match exactly once unless replace_all is set.\n" +
    "Parameters:\n" +
    "- path (required): File path\n" +
    "- old_string (required): Exact text to find and replace\n" +
    "- new_string (required): Replacement text\n" +
    "- replace_all: Replace all occurrences instead of just one (default false)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute({ path, old_string, new_string, replace_all }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    const text = await readFile(abs, "utf8")
    const count = text.split(old_string).length - 1
    if (count === 0) return `Error: old_string not found in ${path}`
    if (!replace_all && count > 1) {
      return `Error: old_string matches ${count} times in ${path} — set replace_all=true or add more context to make it unique`
    }
    const result = replace_all ? text.replaceAll(old_string, new_string) : text.replace(old_string, new_string)
    await writeFile(abs, result, "utf8")
    const doc = await vscode.workspace.openTextDocument(abs)
    await vscode.window.showTextDocument(doc, { preview: false })
    return `Replaced ${replace_all ? count : 1} occurrence(s) in ${path}`
  },
}

// ─── search tools ────────────────────────────────────────────

export const globTool = {
  name: "glob",
  description:
    "Find files by glob pattern. Returns matching paths. Supports ** for recursive matching.\n" +
    "Parameters:\n" +
    "- pattern (required): Glob pattern\n" +
    "- path: Directory to search in (default workspace root)",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
      path: { type: "string", description: "Directory to search in" },
    },
    required: ["pattern"],
  },
  async execute({ pattern, path: dir }, ctx) {
    const base = dir ? resolvePath(dir, ctx.cwd) : ctx.cwd
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(base, pattern),
      "**/node_modules/**"
    )
    if (uris.length === 0) return "(no matches)"
    return uris.slice(0, 200).map((u) => vscode.workspace.asRelativePath(u)).join("\n")
  },
}

export const grepTool = {
  name: "grep",
  description:
    "Search file contents with a regex. Returns matching lines.\n" +
    "Parameters:\n" +
    "- pattern (required): JavaScript regular expression\n" +
    "- path: Directory or file to search (default workspace root)\n" +
    "- glob: Only search files matching this glob",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "Directory or file to search" },
      glob: { type: "string", description: "File glob filter" },
    },
    required: ["pattern"],
  },
  async execute({ pattern, path: dir, glob: fileGlob }, ctx) {
    const base = dir ? resolvePath(dir, ctx.cwd) : ctx.cwd
    try {
      const re = new RegExp(pattern, "g")
      // Use ripgrep via child_process for speed if available, otherwise fallback
      const files = fileGlob
        ? await vscode.workspace.findFiles(new vscode.RelativePattern(base, fileGlob), "**/node_modules/**")
        : await vscode.workspace.findFiles(new vscode.RelativePattern(base, "**/*"), "**/node_modules/**")

      const results = []
      for (const uri of files.slice(0, 500)) {
        try {
          const text = await readFile(uri.fsPath, "utf8")
          const lines = text.split("\n")
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0
            if (re.test(lines[i])) {
              results.push(`${vscode.workspace.asRelativePath(uri)}:${i + 1}: ${lines[i].trim()}`)
            }
          }
        } catch { /* skip binary/unreadable */ }
      }
      if (results.length === 0) return "(no matches)"
      if (results.length > 200) return results.slice(0, 200).join("\n") + `\n\n[... ${results.length - 200} more matches truncated]`
      return results.join("\n")
    } catch (e) {
      return `grep error: ${e.message}`
    }
  },
}

// ─── shell tools ─────────────────────────────────────────────

export const bashTool = {
  name: "bash",
  description:
    "Execute a shell command and return stdout+stderr.\n" +
    "Parameters:\n" +
    "- command (required): Shell command to execute\n" +
    "- timeout: Timeout in milliseconds (default 120000)",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command" },
      timeout: { type: "number", description: "Timeout in ms" },
    },
    required: ["command"],
  },
  async execute({ command, timeout }, ctx) {
    try {
      const opts = { cwd: ctx.cwd, encoding: "utf8", timeout: timeout || BASH_TIMEOUT_MS, stdio: "pipe", env: process.env }
      const result = execSync(command, opts)
      return `[stdout]:\n${result}\n\n(exit code 0)`
    } catch (e) {
      const stdout = e.stdout?.toString() || ""
      const stderr = e.stderr?.toString() || ""
      return [
        stdout ? `[stdout]:\n${stdout}` : "",
        stderr ? `[stderr]:\n${stderr}` : "",
        `(exit code ${e.status ?? 1})`,
      ].filter(Boolean).join("\n")
    }
  },
}

// ─── git tools ────────────────────────────────────────────────

export const gitDiffTool = {
  name: "git_diff",
  description: "Show git diff (unified format). Use to see uncommitted changes.",
  parameters: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Show staged changes" },
      path: { type: "string", description: "File or directory to diff" },
    },
  },
  async execute({ staged, path: filePath }, ctx) {
    try {
      const args = ["--no-pager", "diff"]
      if (staged) args.push("--staged")
      if (filePath) args.push(filePath)
      const result = execSync(`git ${args.join(" ")}`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
      return result || "(no changes)"
    } catch (e) {
      return `git diff error: ${e.stderr || e.message}`
    }
  },
}

export const gitStatusTool = {
  name: "git_status",
  description: "Show git status — staged, unstaged, untracked files.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    try {
      const result = execSync("git status --short", { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
      return result || "(working tree clean)"
    } catch (e) {
      return `git status error: ${e.stderr || e.message}`
    }
  },
}

export const gitLogTool = {
  name: "git_log",
  description: "Show recent git commit history.",
  parameters: {
    type: "object",
    properties: {
      count: { type: "number", description: "Number of commits (default 10)" },
      path: { type: "string", description: "File or directory" },
      oneline: { type: "boolean", description: "One-line format" },
    },
  },
  async execute({ count, path: filePath, oneline }, ctx) {
    try {
      const args = ["--no-pager", "log", oneline ? "--oneline" : "", `-${count || 10}`]
      if (filePath) args.push("--", filePath)
      const result = execSync(`git ${args.filter(Boolean).join(" ")}`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
      return result || "(no commits)"
    } catch (e) {
      return `git log error: ${e.stderr || e.message}`
    }
  },
}

// ─── web tools ────────────────────────────────────────────────

export const websearchTool = {
  name: "websearch",
  description:
    "Search the web. Returns result titles, URLs, and snippets.\n" +
    "Parameters:\n" +
    "- query (required): Search query\n" +
    "- limit: Max results (default 8)",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results" },
    },
    required: ["query"],
  },
  async execute({ query, limit }) {
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit || 8}`
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ThinCoder-VSCode/0.1" },
      })
      const html = await res.text()
      // Simple extraction: find result snippets
      const results = []
      const snippetRe = /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi
      let match
      while ((match = snippetRe.exec(html)) && results.length < (limit || 8)) {
        results.push({
          url: match[1],
          title: match[2].replace(/<[^>]+>/g, "").trim(),
          snippet: match[3].replace(/<[^>]+>/g, "").trim(),
        })
      }
      if (results.length === 0) return "(no results found)"
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n")
    } catch (e) {
      return `websearch error: ${e.message}`
    }
  },
}

export const fetchTool = {
  name: "fetch",
  description:
    "Fetch a URL and return its content as text.\n" +
    "Parameters:\n" +
    "- url (required): http/https URL",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
    },
    required: ["url"],
  },
  async execute({ url }) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 ThinCoder-VSCode/0.1" },
        signal: AbortSignal.timeout(20000),
      })
      const text = await res.text()
      // Strip HTML tags for cleaner output
      const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
      return stripped.slice(0, 20000)
    } catch (e) {
      return `fetch error: ${e.message}`
    }
  },
}

// ─── helpers ──────────────────────────────────────────────────

/** Resolve a path relative to cwd or absolute */
function resolvePath(p, cwd) {
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return p
  return join(cwd, p)
}

// ─── more file tools ──────────────────────────────────────────

export const insertAfterTool = {
  name: "insert_after",
  description:
    "Insert a line of text after a specific line in a file.\n" +
    "Parameters:\n" +
    "- path (required): File path\n" +
    "- content (required): Text to insert as a new line\n" +
    "- after_line: Line number to insert after (1-based), takes priority over after_regex\n" +
    "- after_regex: JavaScript regex to find the line to insert after",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "Text to insert" },
      after_line: { type: "number", description: "Line number (1-based)" },
      after_regex: { type: "string", description: "Regex to match the line" },
    },
    required: ["path", "content"],
  },
  async execute({ path, content, after_line, after_regex }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    const text = await readFile(abs, "utf8")
    const lines = text.split("\n")

    let target
    if (after_line != null) {
      target = after_line - 1
    } else if (after_regex) {
      const re = new RegExp(after_regex)
      const matches = []
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) matches.push(i)
      }
      if (matches.length === 0) return `Error: regex "${after_regex}" matched no lines in ${path}`
      if (matches.length > 1) return `Error: regex "${after_regex}" matched ${matches.length} lines (${matches.map((i) => i + 1).join(", ")}) — add more context`
      target = matches[0]
    } else {
      return "Error: either after_line or after_regex is required"
    }

    if (target < 0 || target >= lines.length) return `Error: line ${target + 1} out of range (file has ${lines.length} lines)`
    lines.splice(target + 1, 0, content)
    await writeFile(abs, lines.join("\n"), "utf8")
    const doc = await vscode.workspace.openTextDocument(abs)
    await vscode.window.showTextDocument(doc, { preview: false })
    return `Inserted after line ${target + 1} in ${path}`
  },
}

export const applyPatchTool = {
  name: "apply_patch",
  description:
    "Apply a unified diff to one or more files. Use for multi-file changes.\n" +
    "Parameters:\n" +
    "- patch (required): Unified diff text",
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "Unified diff" },
    },
    required: ["patch"],
  },
  async execute({ patch }, ctx) {
    // Simple unified diff parser
    const sections = patch.split(/^diff --git /gm).filter(Boolean)
    if (sections.length === 0) return "Error: no diff sections found"
    const results = []

    for (const section of sections) {
      const headerMatch = section.match(/^a\/(.+?) b\/(.+?)$/m)
      if (!headerMatch) continue
      const filePath = headerMatch[2]
      const abs = resolvePath(filePath, ctx.cwd)

      // Extract hunks
      const hunkRe = /@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*?)(?=@@|$)/gs
      let content
      try { content = await readFile(abs, "utf8") } catch { content = "" }
      const lines = content.split("\n")
      let match, applied = 0

      while ((match = hunkRe.exec(section)) !== null) {
        const oldStart = parseInt(match[1]) - 1
        const hunkBody = match[5]
        const hunkLines = hunkBody.split("\n").filter((l) => l !== "")

        const result = []
        let srcIdx = oldStart
        for (const l of hunkLines) {
          if (l.startsWith(" ")) {
            if (srcIdx < lines.length && lines[srcIdx] === l.slice(1)) {
              result.push(lines[srcIdx])
            } else {
              result.push(l.slice(1))
            }
            srcIdx++
          } else if (l.startsWith("-")) {
            if (srcIdx < lines.length && lines[srcIdx] === l.slice(1)) {
              srcIdx++ // skip
            } else {
              srcIdx++
            }
          } else if (l.startsWith("+")) {
            result.push(l.slice(1))
          }
        }
        // Replace the affected range
        const before = lines.slice(0, oldStart)
        const after = lines.slice(srcIdx)
        const newContent = [...before, ...result, ...after]
        lines.length = 0
        lines.push(...newContent)
        applied++
      }

      await writeFile(abs, lines.join("\n"), "utf8")
      try {
        const doc = await vscode.workspace.openTextDocument(abs)
        await vscode.window.showTextDocument(doc, { preview: false })
      } catch { /* ok if file doesn't open */ }
      results.push(`Patched ${filePath}: ${applied} hunk(s) applied`)
    }

    return results.join("\n") || "No files patched"
  },
}

export const syntaxCheckTool = {
  name: "syntax_check",
  readonly: true,
  description:
    "Check a JavaScript file for syntax errors using node --check.\n" +
    "Parameters:\n" +
    "- path (required): File path (.js/.mjs/.cjs only)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
    },
    required: ["path"],
  },
  async execute({ path }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    try {
      execSync(`node --check "${abs}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
      return "Syntax OK"
    } catch (e) {
      return e.stderr || e.message || "Syntax error"
    }
  },
}

export const lsTool = {
  name: "ls",
  readonly: true,
  description:
    "List directory contents with type and size.\n" +
    "Parameters:\n" +
    "- path: Directory path (default workspace root)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path" },
    },
  },
  async execute({ path }, ctx) {
    const dir = path ? resolvePath(path, ctx.cwd) : ctx.cwd
    const { readdir, stat: fsStat } = await import("node:fs/promises")
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const items = []
      for (const e of entries.slice(0, 500)) {
        const full = join(dir, e.name)
        let size = ""
        try { const s = await fsStat(full); size = s.isDirectory() ? "" : ` (${formatSize(s.size)})` } catch { /* */ }
        items.push(`${e.isDirectory() ? "d" : " "} ${e.name}${size}`)
      }
      if (entries.length > 500) items.push(`... (${entries.length - 500} more entries)`)
      return items.join("\n") || "(empty directory)"
    } catch (e) {
      return `ls error: ${e.message}`
    }
  },
}

export const deleteTool = {
  name: "delete",
  description:
    "Delete a file. Refuses to delete git-tracked files as a safety measure.\n" +
    "Parameters:\n" +
    "- path (required): File path, relative to workspace or absolute\n" +
    "- force: Allow deleting git-tracked files (default false)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      force: { type: "boolean", description: "Force delete git-tracked files" },
    },
    required: ["path"],
  },
  async execute({ path, force }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    const { unlink } = await import("node:fs/promises")
    // Check if git-tracked
    try {
      execSync(`git ls-files --error-unmatch "${abs}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 5000, stdio: "pipe" })
      if (!force) return `Error: ${path} is git-tracked. Set force=true to delete anyway.`
    } catch { /* not git-tracked or not a git repo */ }
    await unlink(abs)
    return `Deleted ${path}`
  },
}

export const checkpointTool = {
  name: "checkpoint",
  description:
    "Git-based workspace snapshots. action=create|list|rewind.\n" +
    "Parameters:\n" +
    "- action (required): create a snapshot / list snapshots / rewind to a snapshot",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "list"], description: "create or list" },
    },
    required: ["action"],
  },
  async execute({ action }, ctx) {
    try {
      if (action === "list") {
        const result = execSync("git stash list", { cwd: ctx.cwd, encoding: "utf8", timeout: 5000 })
        return result || "(no snapshots)"
      }
      if (action === "create") {
        const msg = `thincoder-vscode-${Date.now()}`
        execSync(`git stash push -m "${msg}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 })
        return `Snapshot created: ${msg}`
      }
      return `Error: unknown action "${action}". Use "create" or "list".`
    } catch (e) {
      return `checkpoint error: ${e.stderr || e.message}`
    }
  },
}

export const questionTool = {
  name: "question",
  readonly: true,
  description:
    "Ask the user a question and wait for their response.\n" +
    "Parameters:\n" +
    "- question (required): The question to ask\n" +
    "- options: Array of single-choice options (optional)",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "Question to ask" },
      options: { type: "array", items: { type: "string" }, description: "Single-choice options" },
    },
    required: ["question"],
  },
  async execute({ question, options }, ctx) {
    let answer
    if (options?.length) {
      // Use createQuickPick for proper title support
      const picker = vscode.window.createQuickPick()
      picker.title = question
      picker.items = options.map((o) => ({ label: o }))
      picker.placeholder = question
      answer = await new Promise((resolve) => {
        picker.onDidAccept(() => {
          const sel = picker.selectedItems[0]
          resolve(sel?.label || null)
          picker.hide()
        })
        picker.onDidHide(() => resolve(null))
        picker.show()
      })
    } else {
      answer = await vscode.window.showInputBox({ prompt: question })
    }
    return answer ?? "(user cancelled)"
  },
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export const readImageTool = {
  name: "read_image",
  readonly: true,
  description:
    "Read an image file and return it as base64 data. Supports png, jpg, gif, webp, bmp, svg.\n" +
    "Parameters:\n" +
    "- path (required): Image file path",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Image file path" },
    },
    required: ["path"],
  },
  async execute({ path }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    try {
      const data = readFileSync(abs)
      const ext = abs.split(".").pop()?.toLowerCase()
      const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" }[ext] || "image/png"
      const b64 = data.toString("base64")
      return `data:${mime};base64,${b64.slice(0, 100)}... (${data.length} bytes, full base64 in tool result)`
    } catch (e) {
      return `Error reading image: ${e.message}`
    }
  },
}

// ─── code understanding ─────────────────────────────────────────

export const codeSearchTool = {
  name: "code_search",
  description:
    "Search the project's source code for relevant code. Use this to find functions, classes, or code patterns across the codebase. " +
    "Supports natural language queries and code snippets. Returns matching code chunks with file paths and line numbers.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language or code snippet to search for" },
      limit: { type: "number", description: "Max results (default 5)" },
    },
    required: ["query"],
  },
  async execute({ query, limit }, ctx) {
    const maxResults = limit || 5
    // Extract keywords from query for search
    const keywords = query
      .split(/[\s,.;:()\[\]{}"'`!@#$%^&*+=|\\<>?/~]+/)
      .filter((w) => w.length > 1)
      .slice(0, 6)

    if (keywords.length === 0) keywords.push(query.slice(0, 30))

    // Build a regex pattern: match any of the keywords (case-insensitive)
    const pattern = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    const filePattern = "**/*.{js,mjs,cjs,jsx,ts,tsx,py,rs,go,java,c,cpp,h,hpp}"
    const excludePattern = "**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.turbo/**"

    try {
      const results = []
      const uris = await vscode.workspace.findFiles(filePattern, excludePattern, 2000)

      for (const uri of uris) {
        if (results.length >= maxResults) break
        const relPath = uri.fsPath.slice(ctx.cwd.length + 1).replace(/\\/g, "/")
        try {
          const raw = await vscode.workspace.fs.readFile(uri)
          const text = new TextDecoder().decode(raw)
          const lines = text.split("\n")
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            if (new RegExp(pattern, "i").test(lines[i])) {
              // Grab a few lines of context around the match
              const start = Math.max(0, i - 2)
              const end = Math.min(lines.length, i + 3)
              const snippet = lines.slice(start, end)
                .map((l, j) => `${start + j + 1}: ${l}`)
                .join("\n")
              results.push({ path: relPath, line: i + 1, snippet })
              i += 2 // skip ahead to avoid duplicate results from same file
            }
          }
        } catch { /* skip unreadable */ }
      }

      if (results.length === 0) return "No matches found."
      return results.map((r) => `${r.path}:${r.line}:\n${r.snippet}`).join("\n\n")
    } catch (e) {
      return `Search error: ${e.message}`
    }
  },
}

export const docSearchTool = {
  name: "doc_search",
  description:
    "Search the project's documentation (README, design docs, guides, markdown files) for relevant information. " +
    "Use this to find design decisions, coding conventions, architecture docs, or project rules. " +
    "Prefer this over code_search when you need to understand the project's intended design rather than existing implementation.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language search query" },
      limit: { type: "number", description: "Max results (default 5)" },
    },
    required: ["query"],
  },
  async execute({ query, limit }, ctx) {
    const maxResults = limit || 5
    const keywords = query
      .split(/[\s,.;:()\[\]{}"'`!@#$%^&*+=|\\<>?/~]+/)
      .filter((w) => w.length > 1)
      .slice(0, 6)

    if (keywords.length === 0) keywords.push(query.slice(0, 30))

    const pattern = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    const filePattern = "**/*.{md,markdown,txt}"
    const excludePattern = "**/node_modules/**"

    try {
      const results = []
      const uris = await vscode.workspace.findFiles(filePattern, excludePattern, 1000)

      for (const uri of uris) {
        if (results.length >= maxResults) break
        const relPath = uri.fsPath.slice(ctx.cwd.length + 1).replace(/\\/g, "/")
        try {
          const raw = await vscode.workspace.fs.readFile(uri)
          const text = new TextDecoder().decode(raw)
          // Split by ## headings for structured chunks
          const chunks = text.split(/\n(?=#{1,3}\s)/)
          for (const chunk of chunks) {
            if (results.length >= maxResults) break
            if (new RegExp(pattern, "i").test(chunk)) {
              const cleaned = chunk.trim().slice(0, 800)
              results.push(`${relPath}:\n${cleaned}`)
            }
          }
        } catch { /* skip unreadable */ }
      }

      if (results.length === 0) return "No documentation matches found."
      return results.join("\n\n---\n\n")
    } catch (e) {
      return `Search error: ${e.message}`
    }
  },
}

/** All built-in tools */
export const builtinTools = [
  readTool, writeTool, editTool, insertAfterTool, applyPatchTool,
  syntaxCheckTool, lsTool, deleteTool,
  globTool, grepTool, bashTool,
  gitDiffTool, gitStatusTool, gitLogTool, checkpointTool,
  websearchTool, fetchTool, questionTool,
  repoOutlineTool, codeSearchTool, docSearchTool,
]

/** Convert a tool definition to OpenAI function schema */
export function toOpenAISchema(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}
