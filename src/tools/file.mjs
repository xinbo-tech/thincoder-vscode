/**
 * file.mjs — File manipulation tools: read, write, edit
 * Dual-channel: open files edit via WorkspaceEdit (undo-integrated),
 * closed files edit directly on disk.
 */

import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { resolvePath, getOpenDoc, applyEditorEdit, applyEditorRangeEdit, normalizeEOL, stripBom, lfOffsetToRaw, detectFileEol, joinWithEol, majorityEol, findCandidates, FFFD_WARNING, gitDiffOne, hashLine, refreshMarkdownPreview } from "./shared.mjs"

export const readTool = {
  name: "read",
  readonly: true,
  description:
    "Read a text file. Returns numbered lines. Use offset/limit to page large files.\n" +
    "Route to read instead of bash: `cat file` / `type file` / `node -e \"fs.readFileSync(...)\"` → read. Reading a file is a read — never shell out for it.\n" +
    "Parameters:\n" +
    "- path (required): File path, relative to cwd or absolute (alias: filePath)\n" +
    "- offset: 1-based line number to start reading from\n" +
    "- limit: Max lines to return (default 2000)\n" +
    "- hashes: Include SHA256 line hashes (for hashline_edit)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (alias: filePath)" },
      filePath: { type: "string", description: "Alias for path" },
      offset: { type: "number", description: "1-based line number to start from" },
      limit: { type: "number", description: "Max lines to return" },
      hashes: { type: "boolean", description: "Include SHA256 line hashes for hash-based editing (default false). Use when you plan to edit the file with hashline_edit." },
    },
    required: ["path"],
  },
  async execute({ path, offset, limit, hashes, filePath }, ctx) {
    path = path || filePath
    if (typeof path !== "string" || !path) return "Error: path (or filePath) is required and must be a string"
    const abs = resolvePath(path, ctx.cwd)
    const doc = getOpenDoc(abs)
    const text = doc ? doc.getText() : await readFile(abs, "utf8")
    // Unify the hash domain with hashline_edit: strip a leading BOM and normalize
    // EOL before splitting — otherwise CRLF lines keep a trailing \r and a BOM
    // sticks to line 1, so every line hash mismatches what hashline_edit computes.
    const lines = normalizeEOL(stripBom(text)).split("\n")
    const start = Math.max(0, (offset || 1) - 1)
    const end = limit ? start + limit : lines.length
    const chunk = lines.slice(start, end)
    if (hashes) {
      // Parity with CLI read (review R9#3): hashline_edit is unusable without a way
      // to obtain line hashes — read is that way on the CLI side; mirror it here.
      return chunk.map((l, i) => `${String(start + i + 1).padStart(6, " ")}${hashLine(l)}  ${l}`).join("\n")
    }
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
      // Open in editor — apply via WorkspaceEdit (undo-integrated). Overwriting an
      // open file restores ITS original EOL style (F1) — passing LF content straight
      // through silently flipped an open CRLF file to LF.
      if (doc.isDirty) return `Error: File has unsaved changes in the editor: ${abs}. Save or discard before allowing automated edits.`
      const eol = detectFileEol(doc.getText())
      const out = eol === "\r\n" ? normalizeEOL(content).replace(/\n/g, "\r\n") : normalizeEOL(content)
      await applyEditorEdit(doc, out)
      return `Wrote ${content.length} chars to ${path} (via editor)`
    }

    // Not open — write to disk directly. EOL semantics (CLI parity): overwriting
    // an existing file restores ITS original EOL style (F1); a new file follows
    // the directory's majority style, defaulting to LF (F2).
    const prev = existsSync(abs) ? await readFile(abs, "utf8").catch(() => null) : null
    const eol = prev != null ? detectFileEol(prev) : majorityEol(dirname(abs))
    // Normalize first in BOTH branches: CRLF content written to an LF file would
    // otherwise leave bare CRLF (mixed line endings) in the output.
    const out = eol === "\r\n" ? normalizeEOL(content).replace(/\n/g, "\r\n") : normalizeEOL(content)
    await writeFile(abs, out, "utf8")
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
    "- replace_all: Replace all occurrences instead of just one (default false)\n" +
    "- edits: 2026-08-31 工具顺手度（CLI ebd70eb parity）：一次多文件原子替换 [{path, old_string, new_string, replace_all?}, ...]——先全量检查所有替换可执行，任一失败全不写。与 path/old_string/new_string 互斥。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (alias: filePath)" },
      filePath: { type: "string", description: "Alias for path" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences" },
      edits: {
        type: "array",
        description: "一次多文件原子替换——任一失败全不写",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    required: [],
  },
  async execute(args, ctx) {
    // 2026-08-31 工具顺手度（CLI ebd70eb parity）：数组形态——一次多文件原子替换
    if (args.edits) {
      if (!Array.isArray(args.edits) || args.edits.length === 0) {
        return "Error: edits must be a non-empty array of {path, old_string, new_string}"
      }
      if (args.path || args.old_string !== undefined || args.new_string !== undefined) {
        return "Error: edits array is mutually exclusive with path/old_string/new_string"
      }
      // 原子：先全量检查（所有文件都能替换）——任一失败全不写
      const prepared = []
      for (const e of args.edits) {
        if (!e.path) return "Error: each edit must have a path"
        if (!e.old_string) return `Error: edit for ${e.path}: old_string must not be empty`
        const oldS = normalizeEOL(e.old_string)
        const newS = normalizeEOL(e.new_string)
        const abs = resolvePath(e.path, ctx.cwd)
        const doc = getOpenDoc(abs)
        const rawText = doc ? doc.getText() : await readFile(abs, "utf8").catch(() => null)
        if (rawText === null) return `Error: edit aborted (atomic — no files written): cannot read ${e.path}`
        const fileEol = detectFileEol(rawText)
        const text = normalizeEOL(rawText)
        const count = text.split(oldS).length - 1
        if (count === 0) {
          return `Error: edit aborted (atomic — no files written): old_string not found in ${e.path}\n` +
            `  searched: "${oldS.slice(0, 100).split("\n")[0]}${oldS.length > 100 ? "…" : ""}"`
        }
        if (!e.replace_all && count > 1) {
          return `Error: edit aborted (atomic — no files written): old_string matches ${count} times in ${e.path}; ` +
            `provide more context or set replace_all`
        }
        if (doc?.isDirty) return `Error: edit aborted (atomic — no files written): ${e.path} has unsaved changes in the editor`
        prepared.push({ abs, path: e.path, doc, rawText, fileEol, text, oldS, newS, count, replaceAll: !!e.replace_all })
      }
      // 全部检查通过——逐个执行
      const results = []
      for (const p of prepared) {
        if (p.doc) {
          if (p.replaceAll) {
            const replaced = p.text.replaceAll(p.oldS, () => p.newS)
            const out = p.fileEol === "\r\n" ? normalizeEOL(replaced).replace(/\n/g, "\r\n") : replaced
            await applyEditorEdit(p.doc, out)
          } else {
            const idx = p.text.indexOf(p.oldS)
            const start = lfOffsetToRaw(p.rawText, idx)
            const end = lfOffsetToRaw(p.rawText, idx + p.oldS.length)
            const newText = p.fileEol === "\r\n" ? normalizeEOL(p.newS).replace(/\n/g, "\r\n") : normalizeEOL(p.newS)
            const pos = p.doc.positionAt(start)
            const endPos = p.doc.positionAt(end)
            await applyEditorRangeEdit(p.doc, pos.line, pos.character, endPos.line, endPos.character, newText)
          }
          results.push(`Replaced ${p.replaceAll ? p.count : 1} occurrence(s) in ${p.path} (via editor)`)
        } else {
          const replaced = p.replaceAll ? p.text.replaceAll(p.oldS, () => p.newS) : p.text.replace(p.oldS, () => p.newS)
          const out = p.fileEol === "\r\n" ? normalizeEOL(replaced).replace(/\n/g, "\r\n") : replaced
          await writeFile(p.abs, out, "utf8")
          refreshMarkdownPreview(p.abs)
          results.push(`Replaced ${p.replaceAll ? p.count : 1} occurrence(s) in ${p.path}`)
        }
      }
      return results.join("\n")
    }

    // 单文件（现状路径）
    let { path, old_string, new_string, replace_all, filePath } = args
    path = path || filePath
    if (typeof path !== "string" || !path) return "Error: path (or filePath) is required and must be a string"
    if (typeof old_string !== "string" || typeof new_string !== "string") return "Error: old_string and new_string must be strings"
    // A model may paste old_string/new_string straight from a raw CRLF read — its
    // `\r\n` would fail the count gate against the LF-normalized text (entry bug,
    // same family). Normalize both at the entry so every downstream check agrees.
    old_string = normalizeEOL(old_string)
    new_string = normalizeEOL(new_string)
    const abs = resolvePath(path, ctx.cwd)
    const doc = getOpenDoc(abs)
    // EOL normalization on BOTH read paths: disk files are often CRLF (Windows) while
    // the model writes LF in old_string — without normalization every edit on a CRLF
    // file fails with "old_string not found". The editor doc path normalizes too
    // (getText returns the buffer as-is). Write-back restores the file's original
    // EOL style so the diff stays clean (no whole-file EOL rewrite).
    const rawText = doc ? doc.getText() : await readFile(abs, "utf8")
    // First-newline rule (CLI parity): the file's first newline decides the EOL
    // style — never count occurrences (mixed files follow the first line).
    const fileEol = detectFileEol(rawText)
    const text = normalizeEOL(rawText)
    const count = text.split(old_string).length - 1
    if (count === 0) {
      // Helpful diagnosis instead of a bare miss: line ending mismatch vs genuinely absent
      const crlfCount = rawText.split(old_string.replace(/\n/g, "\r\n")).length - 1
      if (crlfCount > 0) return `Error: old_string not found with LF line endings, but matches ${crlfCount} time(s) with CRLF — internal normalization failed (report this)`
      // Similarity candidates (LCS, line-level, top 3, score ≥ 0.5) — turns the
      // "not found" black box into a pointer at the most likely intended line.
      // Multi-line old_string: only its first line is scored (marked accordingly). CLI parity.
      const cands = findCandidates(text.split("\n"), old_string)
      let candText = ""
      if (cands.length > 0) {
        const header = old_string.includes("\n")
          ? `\n  similar lines (old_string line 1: "${old_string.split("\n")[0].slice(0, 80)}"):`
          : "\n  similar lines:"
        candText = header + "\n" + cands.map((c) => `    L${c.line}: ${c.preview} (${Math.round(c.score * 100)}%)`).join("\n")
      }
      return `Error: old_string not found in ${path}${candText}`
    }
    if (!replace_all && count > 1) {
      return `Error: old_string matches ${count} times in ${path} — set replace_all=true or add more context to make it unique`
    }

    if (doc) {
      // Open in editor — apply via WorkspaceEdit
      if (doc.isDirty) return `Error: File has unsaved changes in the editor: ${abs}. Save or discard before allowing automated edits.`
      if (replace_all) {
        // For replace_all, apply the full text replacement. Restore the file's
        // original EOL style — passing the LF-normalized text straight through
        // silently flipped a CRLF file to LF.
        const replaced = text.replaceAll(old_string, () => new_string)
        const out = fileEol === "\r\n" ? normalizeEOL(replaced).replace(/\n/g, "\r\n") : replaced
        await applyEditorEdit(doc, out)
      } else {
        // Find the match position and apply a range edit. `idx` is an LF-domain
        // offset (normalizeEOL dropped each \r) but doc.positionAt expects raw
        // CRLF offsets — map back first or the edit drifts by one char per
        // preceding newline (line 粘连/截断/重复).
        const idx = text.indexOf(old_string)
        if (idx === -1) return `Error: old_string not found in ${path}`
        const start = lfOffsetToRaw(rawText, idx)
        const end = lfOffsetToRaw(rawText, idx + old_string.length)
        const newText = fileEol === "\r\n" ? normalizeEOL(new_string).replace(/\n/g, "\r\n") : normalizeEOL(new_string)
        const pos = doc.positionAt(start)
        const endPos = doc.positionAt(end)
        await applyEditorRangeEdit(doc, pos.line, pos.character, endPos.line, endPos.character, newText)
      }
      return `Replaced ${replace_all ? count : 1} occurrence(s) in ${path} (via editor)`
    }

    // Not open — write to disk. Restore the file's original EOL style.
    const replaced = replace_all ? text.replaceAll(old_string, () => new_string) : text.replace(old_string, () => new_string)
    // normalizeEOL(replaced) first: new_string may carry \r\n (pasted from a raw CRLF read);
    // without it the \n→\r\n conversion doubles the \r into \r\r\n (review R9#1).
    const out = fileEol === "\r\n" ? normalizeEOL(replaced).replace(/\n/g, "\r\n") : replaced
    await writeFile(abs, out, "utf8")
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
    const raw = await readFile(abs, "utf8")
    // Strip the BOM for the hash domain (hashLine never sees it) but remember it —
    // the disk write-back must restore it, while the editor path passes BOM-less
    // text (VS Code re-adds the BOM on save per its file encoding).
    const hadBom = raw.charCodeAt(0) === 0xFEFF
    const text = normalizeEOL(stripBom(raw))
    // Encoding-corruption probe (CLI parity): U+FFFD means the file is not clean
    // UTF-8 — hash addressing may be unreliable. Warn (never block).
    const corrupted = text.includes("\uFFFD")
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
        `The file may have been modified since you last read it. Current hashes (first ${maxShow} lines):\n${hashDump}` +
        (corrupted ? `\n${FFFD_WARNING}` : "")
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
    const newLines = normalizeEOL(new_content).split("\n") // normalize: CRLF in new_content would join into \r\r\n
    lines.splice(pos, target.length, ...newLines)
    // Write back in the file's original EOL style (same rule as edit / apply_patch).
    const updated = joinWithEol(lines, raw)

    // Open in editor → WorkspaceEdit; otherwise write to disk
    const doc = getOpenDoc(abs)
    if (doc) {
      if (doc.isDirty) return `Error: File has unsaved changes in the editor: ${abs}. Save or discard before allowing automated edits.`
      // BOM-less text: the editor re-adds the BOM on save — passing it would double it.
      await applyEditorEdit(doc, updated)
    } else {
      await writeFile(abs, (hadBom ? "\uFEFF" : "") + updated, "utf8")
      refreshMarkdownPreview(abs)
    }
    const diff = gitDiffOne(ctx.cwd, abs)
    return `Edited ${path}: replaced ${target.length} line(s) at L${pos + 1} with ${newLines.length} line(s)${diff ? "\n" + diff : ""}${corrupted ? `\n${FFFD_WARNING}` : ""}`
  },
}
