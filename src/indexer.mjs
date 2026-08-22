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

import { readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { embed, cosine } from "./embedding.mjs"
import { encodeVectors, decodeVectors } from "./index-bin.mjs"
import { discoverFiles, kindFor, shouldIndexFile, listMemoryFiles } from "./index-discover.mjs"

const INDEX_DIR = ".thincoder/index"
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

  // 2) Chunk them — skip empty-text chunks. Capture each file's mtime BEFORE reading so a
  //    change during the (slow) embed pass still registers as "needs rebuild", not stale.
  const allChunks = [] // [{ fileIdx, startLine, endLine, text }]
  const fileMtimes = new Array(files.length)
  for (let i = 0; i < files.length; i++) {
    signal?.throwIfAborted()
    try { fileMtimes[i] = statSync(join(cwd, files[i])).mtimeMs } catch { /* leave undefined */ }
    const chunks = chunkFile(cwd, files[i])
    for (const c of chunks) {
      if (c.text && c.text.trim()) allChunks.push({ fileIdx: i, ...c })
    }
  }
  onProgress?.({ phase: "chunk", done: 0, total: allChunks.length })

  // 3) Embed in batches
  const texts = allChunks.map((c) => c.text.slice(0, MAX_CHUNK_TEXT))
  const allVectors = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    signal?.throwIfAborted()
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
      mtime: fileMtimes[fi] ?? 0,
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

  // 6) Write files — vectors first, manifest last: the manifest is the commit point, so a
  //    reader that sees a fresh manifest is guaranteed the vectors were fully written.
  writeFileSync(join(indexDir, "vectors.bin"), encodeVectors(dim, allVectors))
  writeFileSync(join(indexDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")

  onProgress?.({ phase: "done", done: allChunks.length, total: allChunks.length })
  return { files: files.length, chunks: allChunks.length }
}

/**
 * Load just the manifest (skips the vectors decode — cheap existence/status check).
 * Returns null if the index is missing or incomplete.
 */
export function loadIndexManifest(cwd) {
  const indexDir = join(cwd, INDEX_DIR)
  const mfPath = join(indexDir, "manifest.json")
  if (!existsSync(mfPath) || !existsSync(join(indexDir, "vectors.bin"))) return null
  try {
    const m = JSON.parse(readFileSync(mfPath, "utf8"))
    if (!m || m.version !== 1 || typeof m.files !== "object" || m.files === null) return null
    return m
  } catch { return null }
}

/**
 * Load index from disk. Returns null if no index exists.
 */
export function loadIndex(cwd) {
  const manifest = loadIndexManifest(cwd)
  if (!manifest) return null
  try {
    const { dim, vectors } = decodeVectors(readFileSync(join(cwd, INDEX_DIR, "vectors.bin")))
    return { manifest, dim, vectors }
  } catch {
    // corrupt/truncated vectors.bin — treat like a missing index (caller rebuilds)
    return null
  }
}

/**
 * Check if index needs rebuild (new commit or missing index).
 */
export function needsRebuild(cwd) {
  const manifest = loadIndexManifest(cwd)
  if (!manifest) return { needed: true, reason: "no-index" }

  let head = null
  try { head = execSync("git rev-parse HEAD", { cwd, encoding: "utf8", timeout: 5000 }).trim() } catch {}
  if (head && manifest.indexed_commit !== head) {
    return { needed: true, reason: "new-commits", head, indexed: manifest.indexed_commit }
  }

  const indexed = new Set(Object.keys(manifest.files ?? {}))

  // Uncommitted changes: `git status --porcelain` is index-cached (one subprocess) and far
  // cheaper than a full synchronous tree walk + per-file stat on the host thread. Fall back
  // to a walk + mtime only when git is unavailable.
  let dirty = null
  try {
    dirty = new Set(
      execSync("git status --porcelain", { cwd, encoding: "utf8", timeout: 5000 })
        .split("\n").filter(Boolean)
        .map((l) => {
          // "XY path" (2-char code + space) or "XY old -> new" (rename → take the new side)
          let p = l.slice(3)
          if (p.includes(" -> ")) p = p.slice(p.lastIndexOf(" -> ") + 4)
          return p.replace(/^"|"$/g, "").replaceAll("\\", "/")
        }),
    )
  } catch {}

  if (dirty) {
    for (const rel of dirty) if (indexed.has(rel)) return { needed: true, reason: "file-changed", file: rel }
    for (const rel of dirty) if (shouldIndexFile(rel)) return { needed: true, reason: "file-added", file: rel }
    // Memory files under .thincoder/memory/ may be gitignored, so `git status` never reports
    // them — check that one (small) directory directly so they still trigger a rebuild.
    const mem = new Set(listMemoryFiles(cwd))
    for (const f of mem) if (!indexed.has(f)) return { needed: true, reason: "file-added", file: f }
    for (const f of indexed) {
      if (!f.startsWith(".thincoder/memory/")) continue
      if (!mem.has(f)) return { needed: true, reason: "file-removed", file: f }
      let cur = -1
      try { cur = Math.trunc(statSync(join(cwd, f)).mtimeMs) } catch {}
      if (cur < 0) return { needed: true, reason: "file-missing", file: f }
      if (cur !== Math.trunc(manifest.files[f].mtime)) return { needed: true, reason: "file-changed", file: f }
    }
    return { needed: false, reason: "up-to-date" }
  }

  // No git — full discovery + per-file mtime fallback.
  const discovered = new Set(discoverFiles(cwd))
  for (const f of discovered) if (!indexed.has(f)) return { needed: true, reason: "file-added", file: f }
  for (const f of indexed) if (!discovered.has(f)) return { needed: true, reason: "file-removed", file: f }
  for (const relPath of indexed) {
    const info = manifest.files[relPath]
    try {
      if (Math.trunc(statSync(join(cwd, relPath)).mtimeMs) !== Math.trunc(info.mtime)) {
        return { needed: true, reason: "file-changes", file: relPath }
      }
    } catch {
      // deleted/unreadable since discovery — treat as changed so the index rebuilds
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
  if (!idx || idx.vectors.length === 0) return []

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
    // A boundary keyword exactly at the window start (near EOF) would otherwise drop that
    // line — force at least one line into the chunk.
    if (end <= i) end = i + 1
    const chunkLines = lines.slice(i, end)
    chunks.push({ startLine: i + 1, endLine: end, text: chunkLines.join("\n") })
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
