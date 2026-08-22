/**
 * more-file.mjs — Additional file tools: insert_after, apply_patch, ls, delete
 */

import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { resolvePath, formatSize, getOpenDoc, applyEditorRangeEdit, refreshMarkdownPreview } from "./shared.mjs"

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
    refreshMarkdownPreview(abs)
    return `Inserted after line ${target + 1} in ${path}`
  },
}

export function parsePatch(patch) {
  // Patch text often comes from CRLF terminals/model output; strip uniformly.
  const lines = patch.replace(/\r(?=\n|$)/g, "").split("\n")
  const files = []
  let cur = null
  let i = 0
  const stripPrefix = (p) => p.replace(/^[ab]\//, "")
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith("--- ")) {
      const oldPath = line.slice(4).trim()
      const plus = lines[i + 1]
      if (!plus?.startsWith("+++ ")) throw new Error(`Malformed patch: expected "+++" after "${line}"`)
      const newPath = plus.slice(4).trim()
      if (newPath === "/dev/null") throw new Error("Deleting files via patch is not supported — use the delete tool")
      cur = { path: stripPrefix(newPath), isNew: oldPath === "/dev/null", hunks: [] }
      files.push(cur)
      i += 2
      continue
    }
    if (line.startsWith("@@")) {
      if (!cur) throw new Error("Malformed patch: hunk header before any file header")
      const m = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/)
      if (!m) throw new Error(`Malformed patch: bad hunk header "${line}"`)
      let oldNeed = m[1] == null ? 1 : Number(m[1])
      let newNeed = m[2] == null ? 1 : Number(m[2])
      const hunk = { ops: [] }
      i++
      while (oldNeed > 0 || newNeed > 0) {
        if (i >= lines.length) throw new Error("Malformed patch: hunk truncated (line counts in @@ header not satisfied)")
        const hl = lines[i]
        if (hl.startsWith("\\")) { i++; continue } // "\ No newline at end of file"
        const tag = hl === "" ? " " : hl[0]
        const text = hl === "" ? "" : hl.slice(1)
        if (tag === " ") { hunk.ops.push({ type: " ", text }); oldNeed--; newNeed-- }
        else if (tag === "-") { hunk.ops.push({ type: "-", text }); oldNeed-- }
        else if (tag === "+") { hunk.ops.push({ type: "+", text }); newNeed-- }
        else throw new Error(`Malformed patch: unexpected line "${hl.slice(0, 60)}" inside hunk`)
        i++
      }
      cur.hunks.push(hunk)
      continue
    }
    i++
  }
  if (files.length === 0) throw new Error("No file changes found in patch (need --- / +++ headers)")
  return files
}

/** Apply hunks sequentially onto a line array, re-scanning each hunk's context
 *  against the ALREADY-mutated lines — earlier hunks shifting line numbers can
 *  never misalign later hunks (the bug the line-number approach had). */
export function applyHunks(fileLines, hunks, eol, path) {
  const cr = eol === "\r\n" ? "\r" : ""
  for (let h = 0; h < hunks.length; h++) {
    const oldSeq = hunks[h].ops.filter((o) => o.type !== "+").map((o) => o.text)
    if (oldSeq.length === 0) throw new Error(`Hunk ${h + 1} in ${path} has no context/removed lines to locate`)
    const matches = []
    for (let pos = 0; pos + oldSeq.length <= fileLines.length; pos++) {
      let ok = true
      for (let j = 0; j < oldSeq.length; j++) {
        if (fileLines[pos + j].replace(/\r$/, "") !== oldSeq[j]) { ok = false; break }
      }
      if (ok) matches.push(pos)
    }
    if (matches.length === 0) throw new Error(`Hunk ${h + 1} in ${path} does not apply — context not found. Read the file first and regenerate the patch.`)
    if (matches.length > 1) throw new Error(`Hunk ${h + 1} in ${path} matches ${matches.length} locations — add more context lines to make it unique`)
    const pos = matches[0]
    const out = []
    let src = pos
    for (const op of hunks[h].ops) {
      if (op.type === " ") out.push(fileLines[src++])
      else if (op.type === "-") src++
      else out.push(op.text + cr)
    }
    fileLines.splice(pos, oldSeq.length, ...out)
  }
}

export const applyPatchTool = {
  name: "apply_patch",
  description:
    "Apply a unified diff to one or more files. Use for multi-file changes.\n" +
    "Parameters:\n" +
    "- patch (required): Unified diff text (--- / +++ headers per file, @@ hunks; --- /dev/null creates a file)",
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "Unified diff" },
    },
    required: ["patch"],
  },
  async execute({ patch }, ctx) {
    let files
    try { files = parsePatch(patch) } catch (e) { return `Error: ${e.message}` }
    const results = []
    for (const f of files) {
      const abs = resolvePath(f.path, ctx.cwd)
      const dirtyErr = getOpenDoc(abs)?.isDirty ? `File has unsaved changes in the editor: ${abs}. Save or discard first.` : null
      if (dirtyErr) return `Error: ${dirtyErr}`
      let content
      if (f.isNew) {
        if (existsSync(abs)) throw new Error(`Cannot create ${f.path}: file already exists`)
        content = f.hunks.flatMap((h) => h.ops.filter((o) => o.type === "+").map((o) => o.text)).join("\n") + "\n"
      } else {
        const raw = getOpenDoc(abs)?.getText() ?? await readFile(abs, "utf8").catch(() => { throw new Error(`File not found: ${f.path}`) })
        const eol = raw.includes("\r\n") ? "\r\n" : "\n"
        const lines = raw.split("\n")
        applyHunks(lines, f.hunks, eol, f.path)
        content = lines.join("\n")
      }
      await writeFile(abs, content, "utf8")
      refreshMarkdownPreview(abs)
      results.push(`Patched ${f.path} (${f.isNew ? "created" : "modified"})`)
    }
    return results.join("\n") || "No files patched"
  },
}

export const lsTool = {
  name: "ls",
  readonly: true,
  description:
    "List directory contents with type and size.\n" +
    "Parameters:\n" +
    "- path: Directory path (default workspace root)\n" +
    "- filter: Only list entries matching this wildcard (e.g. '*.mjs', '*test*')",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path" },
      filter: { type: "string", description: "Only list entries matching this wildcard (e.g. '*.mjs', '*test*')" },
    },
  },
  async execute({ path, filter }, ctx) {
    const dir = path ? resolvePath(path, ctx.cwd) : ctx.cwd
    const { readdir, stat: fsStat } = await import("node:fs/promises")
    const filterRe = filter ? wildcardToRegex(filter) : null
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const matched = filterRe ? entries.filter((e) => filterRe.test(e.name)) : entries
      const items = []
      for (const e of matched.slice(0, 500)) {
        const full = join(dir, e.name)
        let size = ""
        try { const s = await fsStat(full); size = s.isDirectory() ? "" : ` (${formatSize(s.size)})` } catch { /* */ }
        items.push(`${e.isDirectory() ? "d" : " "} ${e.name}${size}`)
      }
      if (matched.length > 500) items.push(`... (${matched.length - 500} more entries)`)
      return items.join("\n") || "(empty directory)"
    } catch (e) {
      return `ls error: ${e.message}`
    }
  },
}

function wildcardToRegex(pattern) {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${re}$`, "i")
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
    // Check if git-tracked — execFileSync (array args, no shell) so a path with
    // shell metacharacters can't inject.
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", abs.replace(/\\/g, "/")], { cwd: ctx.cwd, encoding: "utf8", timeout: 5000, stdio: "pipe" })
      if (!force) return `Error: ${path} is git-tracked. Set force=true to delete anyway.`
    } catch { /* not git-tracked or not a git repo */ }
    await unlink(abs)
    return `Deleted ${path}`
  },
}
