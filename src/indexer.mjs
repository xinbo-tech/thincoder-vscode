/**
 * indexer.mjs — unified semantic index: code, docs, memory
 *
 * Index storage: .thincoder/index/
 *   manifest.json  — { version, vector_dim, embed_model, indexed_commit, files: { path: { mtime, kind, chunks: [{idx, startLine, endLine}] } } }
 *   vectors.bin    — [4B dim][4B count][count × 4B offsets][all raw Float32 vectors]
 *
 * Chunking:
 *   code   — split at function/class/export boundaries, ≤30 lines, 3-line overlap
 *   doc    — split at ## headers or blank lines, ≤20 lines
 *   memory — one chunk per file
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs"
import { join, relative } from "node:path"
import { execSync } from "node:child_process"
import { embed, cosine } from "./embedding.mjs"
import { encodeVectors, decodeVectors } from "./index-bin.mjs"

const INDEX_DIR = ".thincoder/index"
const CODE_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp"])
const DOC_EXTS = new Set([".md", ".markdown", ".txt", ".rst", ".adoc"])
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", "coverage", "__pycache__", ".next"])
const CHUNK_LINES_CODE = 30
const CHUNK_LINES_DOC = 20
const CHUNK_OVERLAP = 3
const EMBED_BATCH = 64
const MAX_CHUNK_TEXT = 2000

// ─── Public API ───────────────────────────────────────────────

/**
 * Build or rebuild the full vector index.
 * @param {string} cwd - project root
 * @param {object} embedder - from createEmbedder()
 * @param {{ onProgress?: (p: {phase:string, done:number, total:number}) => void, signal?: AbortSignal }} opts
 */
export async function buildIndex(cwd, embedder, { onProgress, signal } = {}) {
  const indexDir = join(cwd, INDEX_DIR)
  mkdirSync(indexDir, { recursive: true })

  // 1) Discover files
  const files = discoverFiles(cwd, signal)
  onProgress?.({ phase: "scan", done: 0, total: files.length })

  // 2) Chunk them
  const allChunks = [] // [{ fileIdx, startLine, endLine, text }]
  for (let i = 0; i < files.length; i++) {
    signal?.throwIfAborted()
    const chunks = chunkFile(cwd, files[i])
    for (const c of chunks) allChunks.push({ fileIdx: i, ...c })
  }
  onProgress?.({ phase: "chunk", done: 0, total: allChunks.length })

  // 3) Embed in batches
  const texts = allChunks.map((c) => c.text.slice(0, MAX_CHUNK_TEXT))
  const allVectors = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    if (signal?.aborted) signal.throwIfAborted()
    const batch = texts.slice(i, i + EMBED_BATCH)
    const vecs = await embed(embedder, batch, { signal })
    allVectors.push(...vecs)
    onProgress?.({ phase: "embed", done: Math.min(i + EMBED_BATCH, texts.length), total: texts.length })
  }

  // 4) Build manifest
  const dim = allVectors[0]?.length || 0
  const fileMap = {}
  const chunkIdxByFile = new Map() // fileIdx → [{idx, startLine, endLine}]
  for (let ci = 0; ci < allChunks.length; ci++) {
    const c = allChunks[ci]
    if (!chunkIdxByFile.has(c.fileIdx)) chunkIdxByFile.set(c.fileIdx, [])
    chunkIdxByFile.get(c.fileIdx).push({ idx: ci, startLine: c.startLine, endLine: c.endLine })
  }
  for (let fi = 0; fi < files.length; fi++) {
    fileMap[files[fi]] = {
      mtime: statSync(join(cwd, files[fi])).mtimeMs,
      kind: kindFor(files[fi]),
      chunks: chunkIdxByFile.get(fi) || [],
    }
  }

  // 5) Get git HEAD
  let commit = null
  try { commit = execSync("git rev-parse HEAD", { cwd, encoding: "utf8", timeout: 5000 }).trim() } catch {}

  const manifest = {
    version: 1,
    vector_dim: dim,
    embed_model: embedder.model,
    indexed_commit: commit,
    files: fileMap,
  }

  // 6) Write files
  writeFileSync(join(indexDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
  writeFileSync(join(indexDir, "vectors.bin"), encodeVectors(dim, allVectors))

  onProgress?.({ phase: "done", done: allChunks.length, total: allChunks.length })
  return { files: files.length, chunks: allChunks.length }
}

/**
 * Load index from disk. Returns null if no index exists.
 */
export function loadIndex(cwd) {
  const indexDir = join(cwd, INDEX_DIR)
  const mfPath = join(indexDir, "manifest.json")
  const vPath = join(indexDir, "vectors.bin")
  if (!existsSync(mfPath) || !existsSync(vPath)) return null

  const manifest = JSON.parse(readFileSync(mfPath, "utf8"))
  const { dim, vectors } = decodeVectors(readFileSync(vPath))
  return { manifest, dim, vectors }
}

/**
 * Check if index needs rebuild (new commit or missing index).
 */
export function needsRebuild(cwd) {
  const idx = loadIndex(cwd)
  if (!idx) return { needed: true, reason: "no-index" }

  let head = null
  try { head = execSync("git rev-parse HEAD", { cwd, encoding: "utf8", timeout: 5000 }).trim() } catch {}
  if (head && idx.manifest.indexed_commit !== head) {
    return { needed: true, reason: "new-commits", head, indexed: idx.manifest.indexed_commit }
  }
  // Uncommitted edits: compare per-file mtime so search never serves stale line ranges
  // against freshly-edited files (snippet text is re-read live, line spans are not).
  for (const [relPath, info] of Object.entries(idx.manifest.files ?? {})) {
    try {
      if (statSync(join(cwd, relPath)).mtimeMs !== info.mtime) {
        return { needed: true, reason: "file-changes", file: relPath }
      }
    } catch {
      return { needed: true, reason: "file-missing", file: relPath }
    }
  }
  return { needed: false, reason: "up-to-date" }
}

/**
 * Search the index with a query. Returns [{ file, kind, startLine, endLine, score }].
 * @param {string} cwd
 * @param {object} embedder
 * @param {string} query
 * @param {{ kind?: "code"|"doc"|"memory", limit?: number, signal?: AbortSignal }} opts
 */
export async function searchIndex(cwd, embedder, query, { kind, limit = 10, signal } = {}) {
  const idx = loadIndex(cwd)
  if (!idx) return []

  // Embed query
  const [qvec] = await embed(embedder, [query.slice(0, MAX_CHUNK_TEXT)], { signal })
  if (!qvec) return []

  // Score all chunks of matching kind
  const scored = []
  for (const [path, info] of Object.entries(idx.manifest.files)) {
    if (kind && info.kind !== kind) continue
    for (const chunk of info.chunks) {
      if (chunk.idx >= idx.vectors.length) continue
      const score = cosine(qvec, idx.vectors[chunk.idx])
      scored.push({ file: path, kind: info.kind, startLine: chunk.startLine, endLine: chunk.endLine, score })
    }
  }

  // Top-K
  scored.sort((a, b) => b.score - a.score)
  const results = scored.slice(0, limit)

  // Read actual text from files
  for (const r of results) {
    try {
      const text = readFileSync(join(cwd, r.file), "utf8")
      const lines = text.split("\n")
      const start = Math.max(0, r.startLine - 1)
      const end = Math.min(lines.length, r.endLine)
      r.snippet = lines.slice(start, end).map((l, j) => `${start + j + 1}: ${l}`).join("\n")
    } catch {
      r.snippet = "(unreadable)"
    }
  }

  return results
}

// ─── Internal: file discovery ──────────────────────────────────

function discoverFiles(cwd, signal) {
  const files = []
  function walk(dir) {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      signal?.throwIfAborted()
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
        walk(join(dir, e.name))
      } else if (e.isFile()) {
        const ext = e.name.includes(".") ? e.name.slice(e.name.lastIndexOf(".")).toLowerCase() : ""
        if (CODE_EXTS.has(ext) || DOC_EXTS.has(ext)) {
          files.push(relative(cwd, join(dir, e.name)).replaceAll("\\", "/"))
        }
      }
    }
  }
  walk(cwd)
  return files
}

function kindFor(filePath) {
  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : ""
  if (CODE_EXTS.has(ext)) return "code"
  if (DOC_EXTS.has(ext)) return "doc"
  // memory files live in .thincoder/memory/
  if (filePath.startsWith(".thincoder/memory/")) return "memory"
  return "doc"
}

// ─── Internal: chunking ────────────────────────────────────────

function chunkFile(cwd, relPath) {
  const abs = join(cwd, relPath)
  let text
  try { text = readFileSync(abs, "utf8") } catch { return [] }
  const lines = text.split("\n")
  const kind = kindFor(relPath)

  if (kind === "memory") {
    // Memory files are single-chunk (they're short markdown)
    return [{ startLine: 1, endLine: lines.length, text: text.slice(0, MAX_CHUNK_TEXT) }]
  }

  return kind === "code" ? chunkCode(lines) : chunkDoc(lines)
}

function chunkCode(lines) {
  const chunks = []
  let i = 0
  while (i < lines.length) {
    // Try to find a natural boundary: function/class/export keyword
    let end = Math.min(i + CHUNK_LINES_CODE, lines.length)
    // Look for a better boundary near end (within last 5 lines of the chunk)
    for (let j = end - 1; j >= Math.max(i, end - 5); j--) {
      const trimmed = lines[j].trim()
      if (/^(export\s+)?(async\s+)?function\s|^class\s|^(export\s+)?const\s|^\/\*\*|^import\s|^export\s/.test(trimmed)) {
        end = j
        break
      }
    }
    const startLine = i + 1
    const chunkLines = lines.slice(i, end)
    chunks.push({ startLine, endLine: end, text: chunkLines.join("\n") })
    i = Math.max(i + 1, end - CHUNK_OVERLAP)
  }
  return chunks
}

function chunkDoc(lines) {
  const chunks = []
  let start = 0
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    // Split at ## headers
    if (/^##\s/.test(trimmed) && i > start) {
      chunks.push({ startLine: start + 1, endLine: i, text: lines.slice(start, i).join("\n") })
      start = i
    }
    // Split at blank lines when chunk gets too long
    if (i - start >= CHUNK_LINES_DOC && trimmed === "") {
      chunks.push({ startLine: start + 1, endLine: i, text: lines.slice(start, i).join("\n") })
      start = i + 1
    }
  }
  // Remainder
  if (start < lines.length) {
    chunks.push({ startLine: start + 1, endLine: lines.length, text: lines.slice(start).join("\n") })
  }
  return chunks
}
