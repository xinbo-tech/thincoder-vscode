/**
 * file.mjs — File manipulation tools: read, write, edit
 * Dual-channel: open files edit via WorkspaceEdit (undo-integrated),
 * closed files edit directly on disk.
 */

import { readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { resolvePath, getOpenDoc, applyEditorEdit, applyEditorRangeEdit, normalizeEOL, gitDiffOne, hashLine, refreshMarkdownPreview } from "./shared.mjs"

export const readTool = {
  name: "read",
  readonly: true,
  description:
    "Read a text file. Returns numbered lines. Use offset/limit to page large files.\n" +
    "Route to read instead of bash: `cat file` / `type file` / `node -e \"fs.readFileSync(...)\"` → read. Reading a file is a read — never shell out for it.\n" +
    "Parameters:\n" +
    "- path (required): File path, relative to cwd or absolute (alias: filePath)\n" +
    "- offset: 1-based line number to start reading from\n" +
    "- limit: Max lines to return (default 2000)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (alias: filePath)" },
      filePath: { type: "string", description: "Alias for path" },
      offset: { type: "number", description: "1-based line number to start from" },
      limit: { type: "number", description: "Max lines to return" },
    },
    required: ["path"],
  },
  async execute({ path, offset, limit, filePath }, ctx) {
    path = path || filePath
    if (typeof path !== "string" || !path) return "Error: path (or filePath) is required and must be a string"
    const abs = resolvePath(path, ctx.cwd)
    const doc = getOpenDoc(abs)
    const text = doc ? doc.getText() : await readFile(abs, "utf8")
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
    "- path (required): File path, relative to cwd or absolute (alias: filePath)\n" +
    "- content (required): Full content to write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (alias: filePath)" },
      filePath: { type: "string", description: "Alias for path" },
      content: { type: "string", description: "Full content to write" },
    },
    required: ["path", "content"],
  },
  async execute({ path, content, filePath }, ctx) {
    path = path || filePath
    if (typeof path !== "string" || !path) return "Error: path (or filePath) is required and must be a string"
    if (typeof content !== "string") return "Error: content is required and must be a string"
    const abs = resolvePath(path, ctx.cwd)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(dirname(abs), { recursive: true })

    const doc = getOpenDoc(abs)
    if (doc) {
      // Open in editor — apply via WorkspaceEdit (undo-integrated)
      if (doc.isDirty) return `Error: File has unsaved changes in the editor: ${abs}. Save or discard before allowing automated edits.`
      await applyEditorEdit(doc, content)
      return `Wrote ${content.length} chars to ${path} (via editor)`
    }

    // Not open — write to disk directly
    await writeFile(abs, content, "utf8")
    refreshMarkdownPreview(abs)
    return `Wrote ${content.length} chars to ${path}`
  },
}

export const editTool = {
  name: "edit",
  description:
    "Edit a file by exact string replacement. old_string must match exactly once unless replace_all is set.\n" +
    "Parameters:\n" +
    "- path (required): File path, relative to cwd or absolute (alias: filePath)\n" +
    "- old_string (required): Exact text to find and replace\n" +
    "- new_string (required): Replacement text\n" +
    "- replace_all: Replace all occurrences instead of just one (default false)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (alias: filePath)" },
      filePath: { type: "string", description: "Alias for path" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute({ path, old_string, new_string, replace_all, filePath }, ctx) {
    path = path || filePath
    if (typeof path !== "string" || !path) return "Error: path (or filePath) is required and must be a string"
    const abs = resolvePath(path, ctx.cwd)
    const doc = getOpenDoc(abs)
    // EOL normalization on BOTH read paths: disk files are often CRLF (Windows) while
    // the model writes LF in old_string — without normalization every edit on a CRLF
    // file fails with "old_string not found". The editor doc path normalizes too
    // (getText returns the buffer as-is). Write-back restores the file's original
    // EOL style so the diff stays clean (no whole-file EOL rewrite).
    const rawText = doc ? doc.getText() : await readFile(abs, "utf8")
    const fileEol = rawText.includes("\r\n") ? "\r\n" : "\n"
    const text = normalizeEOL(rawText)
    const count = text.split(old_string).length - 1
    if (count === 0) {
      // Helpful diagnosis instead of a bare miss: line ending mismatch vs genuinely absent
      const crlfCount = rawText.split(old_string.replace(/\n/g, "\r\n")).length - 1
      if (crlfCount > 0) return `Error: old_string not found with LF line endings, but matches ${crlfCount} time(s) with CRLF — internal normalization failed (report this)`
      return `Error: old_string not found in ${path}`
    }
    if (!replace_all && count > 1) {
      return `Error: old_string matches ${count} times in ${path} — set replace_all=true or add more context to make it unique`
    }

    if (doc) {
      // Open in editor — apply via WorkspaceEdit
      if (doc.isDirty) return `Error: File has unsaved changes in the editor: ${abs}. Save or discard before allowing automated edits.`
      if (replace_all) {
        // For replace_all, apply the full text replacement
        await applyEditorEdit(doc, text.replaceAll(old_string, () => new_string))
      } else {
        // Find the match position and apply range edit
        const idx = text.indexOf(old_string)
        const pos = doc.positionAt(idx)
        const endPos = doc.positionAt(idx + old_string.length)
        await applyEditorRangeEdit(doc, pos.line, pos.character, endPos.line, endPos.character, new_string)
      }
      return `Replaced ${replace_all ? count : 1} occurrence(s) in ${path} (via editor)`
    }

    // Not open — write to disk. Restore the file's original EOL style.
    const replaced = replace_all ? text.replaceAll(old_string, () => new_string) : text.replace(old_string, () => new_string)
    await writeFile(abs, fileEol === "\r\n" ? replaced.replace(/\n/g, "\r\n") : replaced, "utf8")
    refreshMarkdownPreview(abs)
    return `Replaced ${replace_all ? count : 1} occurrence(s) in ${path}`
  },
}

export const hashlineEditTool = {
  name: "hashline_edit",
  readonly: false,
  description:
    "Edit a file using content-hash addressing instead of string matching. More reliable than edit when whitespace or encoding varies — hashes are computed from exact line bytes on disk.\n" +
    "Parameters:\n" +
    "- path (required): File path\n" +
    "- old_hashes (required): Array of SHA256 hashes (12-char hex) identifying lines to replace. Read the file with hashes=true first to obtain these hashes. For a single line, pass [hash]; for a contiguous block, pass [hash1, hash2, ...] in order.\n" +
    "- new_content (required): Replacement text (multi-line ok, \\n separated)\n\n" +
    "Notes:\n" +
    "- The hash of each line is computed as SHA256(line_content).slice(0, 12) — the same algorithm used by read(hashes=true)\n" +
    "- Hashes are position-independent: they identify lines by content, not by line number (which changes after edits)\n" +
    "- If the hash sequence isn't found, the error will include the current file's hashes so you can retry with corrected values\n" +
    "- Prefer this over edit when: 1) the file may have mixed whitespace/encoding, 2) you want to edit a block of lines with a single call",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_hashes: { type: "array", items: { type: "string" }, description: "SHA256 hashes (12 chars) of the lines to replace. Read the file with hashes=true first to obtain these hashes. Single line: pass 1 hash; multiple lines: pass the exact sequence of hashes." },
      new_content: { type: "string", description: "Replacement text (can span multiple lines)" },
    },
    required: ["path", "old_hashes", "new_content"],
  },
  touchedPaths(args) { return args.path ? [args.path] : [] },
  async execute({ path, old_hashes, new_content }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    if (!old_hashes?.length) throw new Error("old_hashes must not be empty — read the file with hashes=true to get line hashes")
    const text = normalizeEOL(await readFile(abs, "utf8"))
    const lines = text.split("\n")
    const fileHashes = lines.map((l) => hashLine(l))
    const target = old_hashes

    // Sliding-window match: find all occurrences of the hash sequence.
    const matches = []
    for (let i = 0; i <= fileHashes.length - target.length; i++) {
      let match = true
      for (let j = 0; j < target.length; j++) {
        if (fileHashes[i + j] !== target[j]) { match = false; break }
      }
      if (match) matches.push(i)
    }

    if (matches.length === 0) {
      const maxShow = Math.min(fileHashes.length, 50)
      const hashDump = fileHashes.slice(0, maxShow).map((h, i) => `${h}  L${i + 1}: ${lines[i].slice(0, 80)}`).join("\n")
      const preview = target.join(" ")
      throw new Error(
        `Hash sequence not found in ${path}: ${preview}\n` +
        `The file may have been modified since you last read it. Current hashes (first ${maxShow} lines):\n${hashDump}`
      )
    }

    if (matches.length > 1) {
      const c = 2
      const detail = matches.map((m) => {
        const start = Math.max(0, m - c)
        const end = Math.min(lines.length, m + target.length + c)
        const preview = lines.slice(start, end).map((l, i) => {
          const ln = start + i + 1
          const marker = m <= ln - 1 && ln - 1 < m + target.length ? ">" : " "
          return `${marker} L${ln}: ${l.slice(0, 80)}`
        }).join("\n")
        return `  Match at line ${m + 1} (${target.length} line(s)):\n${preview}`
      }).join("\n\n")
      throw new Error(
        `Hash sequence matches ${matches.length} positions in ${path} — ambiguous.\n` +
        `Include more surrounding lines (unique-hash lines before/after the target) to disambiguate.\n\n` +
        `All matches with surrounding context:\n\n${detail}`
      )
    }

    const pos = matches[0]
    const newLines = new_content.split("\n")
    lines.splice(pos, target.length, ...newLines)
    const updated = lines.join("\n")

    // Open in editor → WorkspaceEdit; otherwise write to disk
    const doc = getOpenDoc(abs)
    if (doc) {
      if (doc.isDirty) return `Error: File has unsaved changes in the editor: ${abs}. Save or discard before allowing automated edits.`
      await applyEditorEdit(doc, updated)
    } else {
      await writeFile(abs, updated, "utf8")
      refreshMarkdownPreview(abs)
    }
    const diff = gitDiffOne(ctx.cwd, abs)
    return `Edited ${path}: replaced ${target.length} line(s) at L${pos + 1} with ${newLines.length} line(s)${diff ? "\n" + diff : ""}`
  },
}
