/**
 * more-file.mjs — Additional file tools: insert_after, apply_patch, syntax_check, ls, delete
 */

import { readFile, writeFile } from "node:fs/promises"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { resolvePath, formatSize, getOpenDoc, applyEditorRangeEdit } from "./shared.mjs"

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
    const doc = getOpenDoc(abs)
    const text = doc ? doc.getText() : await readFile(abs, "utf8")
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

    if (doc) {
      // Open in editor — insert via WorkspaceEdit at the line position
      if (doc.isDirty) return `Error: File has unsaved changes in the editor: ${abs}. Save or discard before allowing automated edits.`
      const insertLine = target + 1 // line number to insert AFTER
      const lineCount = doc.lineCount
      if (insertLine >= lineCount) {
        // Append at end
        const lastLine = doc.lineAt(lineCount - 1)
        await applyEditorRangeEdit(doc, lastLine.lineNumber, lastLine.text.length, lastLine.lineNumber, lastLine.text.length, "\n" + content)
      } else {
        // Insert between lines — insert at start of the next line with a newline prefix
        const nextLine = doc.lineAt(insertLine)
        await applyEditorRangeEdit(doc, nextLine.lineNumber, 0, nextLine.lineNumber, 0, content + "\n")
      }
      return `Inserted after line ${target + 1} in ${path} (via editor)`
    }

    // Not open — write to disk
    lines.splice(target + 1, 0, content)
    await writeFile(abs, lines.join("\n"), "utf8")
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
    // Parse sections — support both git diff format AND standard unified diff.
    // Git diff uses "diff --git a/path b/path" headers; standard unified uses "--- a/path\n+++ b/path".
    let sections
    if (/^diff --git /m.test(patch)) {
      sections = patch.split(/^diff --git /gm).filter(Boolean)
    } else {
      // Standard unified diff — split on "--- a/" headers (first char on line is "---")
      sections = patch.split(/^(?=--- (?:a\/|\/dev\/null))/m).filter(Boolean)
    }
    if (sections.length === 0) return "Error: no diff sections found"
    const results = []

    for (const section of sections) {
      // Try git diff header first: "a/path b/path" on first line
      let filePath
      let headerMatch = section.match(/^a\/(.+?) b\/(.+?)$/m)
      if (headerMatch) {
        filePath = headerMatch[2]
      } else {
        // Standard unified diff: "--- a/path" line followed by "+++ b/path"
        const stdMatch = section.match(/^--- (?:a\/|\/dev\/null\s*\n\+\+\+ b\/)(.+?)$/m)
        if (stdMatch) filePath = stdMatch[1]
      }
      if (!filePath) continue
      // /dev/null means new file — skip header-only sections
      if (filePath === "/dev/null") continue

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

      const dirtyErr = getOpenDoc(abs)?.isDirty ? `File has unsaved changes in the editor: ${abs}. Save or discard first.` : null
      if (dirtyErr) return `Error: ${dirtyErr}`
      await writeFile(abs, lines.join("\n"), "utf8")
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
    "- path (required): File path, relative to cwd or absolute (alias: filePath)\n" +
    "- force: Allow deleting git-tracked files (default false)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (alias: filePath)" },
      filePath: { type: "string", description: "Alias for path" },
      force: { type: "boolean", description: "Force delete git-tracked files" },
    },
    required: ["path"],
  },
  async execute({ path, force, filePath }, ctx) {
    path = path || filePath
    if (typeof path !== "string" || !path) return "Error: path (or filePath) is required and must be a string"
    const abs = resolvePath(path, ctx.cwd)
    const { unlink } = await import("node:fs/promises")
    // Check if git-tracked — normalize to forward slashes for git (Windows compat)
    const gitPath = abs.replace(/\\/g, "/")
    try {
      execSync(`git ls-files --error-unmatch "${gitPath}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 5000, stdio: "pipe" })
      if (!force) return `Error: ${path} is git-tracked. Set force=true to delete anyway.`
    } catch { /* not git-tracked or not a git repo */ }
    await unlink(abs)
    return `Deleted ${path}`
  },
}
