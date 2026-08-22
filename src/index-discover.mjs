/**
 * index-discover.mjs — file discovery + kind classification for the semantic index
 * (split out of indexer.mjs).
 */
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"

const CODE_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp"])
const DOC_EXTS = new Set([".md", ".markdown", ".txt", ".rst", ".adoc"])
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", "coverage", "__pycache__", ".next"])

export function discoverFiles(cwd, signal) {
  const files = []
  function walk(dir, inThincoder) {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      signal?.throwIfAborted()
      // Inside .thincoder keep ONLY memory/ (skip index/, sessions/, checklist.md, …)
      if (inThincoder && e.name !== "memory") continue
      if (e.isDirectory()) {
        // Enter .thincoder at the project root (and its memory/ subdir); skip other dot-dirs.
        if (SKIP_DIRS.has(e.name)) continue
        if (e.name.startsWith(".") && e.name !== ".thincoder") continue
        walk(join(dir, e.name), e.name === ".thincoder")
      } else if (e.isFile()) {
        const ext = e.name.includes(".") ? e.name.slice(e.name.lastIndexOf(".")).toLowerCase() : ""
        if (CODE_EXTS.has(ext) || DOC_EXTS.has(ext)) {
          files.push(relative(cwd, join(dir, e.name)).replaceAll("\\", "/"))
        }
      }
    }
  }
  walk(cwd, false)
  return files
}

export function kindFor(filePath) {
  // memory files live in .thincoder/memory/ — check FIRST: they're .md, DOC_EXTS would
  // otherwise classify them as docs.
  if (filePath.startsWith(".thincoder/memory/")) return "memory"
  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : ""
  if (CODE_EXTS.has(ext)) return "code"
  if (DOC_EXTS.has(ext)) return "doc"
  return "doc"
}