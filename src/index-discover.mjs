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
        if (isIndexableFile(e.name)) {
          files.push(relative(cwd, join(dir, e.name)).replaceAll("\\", "/"))
        }
      }
    }
  }
  walk(cwd, false)
  return files
}

export function isIndexableFile(filePath) {
  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : ""
  return CODE_EXTS.has(ext) || DOC_EXTS.has(ext)
}

/** Full predicate: is this relative path a file the index tracks? (extension + the same
 *  directory exclusions discoverFiles applies — SKIP_DIRS and hidden dirs, except the
 *  .thincoder/memory/ special case). Used by needsRebuild so "discovery" and "rebuild
 *  decision" can never disagree. */
export function shouldIndexFile(relPath) {
  const p = relPath.replaceAll("\\", "/")
  if (p.startsWith(".thincoder/memory/")) return isIndexableFile(p)
  for (const d of p.split("/").slice(0, -1)) {
    if (SKIP_DIRS.has(d) || d.startsWith(".")) return false
  }
  return isIndexableFile(p)
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

export function listMemoryFiles(cwd) {
  const memDir = join(cwd, ".thincoder/memory")
  try {
    return readdirSync(memDir, { withFileTypes: true })
      .filter((e) => e.isFile() && isIndexableFile(e.name))
      .map((e) => ".thincoder/memory/" + e.name)
  } catch {
    return []
  }
}