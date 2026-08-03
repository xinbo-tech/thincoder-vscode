/**
 * memory.mjs — File-based memory system for ThinCoder VS Code
 *
 * Entries are Markdown files with YAML frontmatter in .thincoder/memory/.
 * Format matches the CLI (thincoder/src/markdown.mjs):
 *
 *   ---
 *   type: rule
 *   title: My convention
 *   tags: [coding, style]
 *   author: unknown
 *   created: 2026-07-29
 *   ---
 *   Content goes here...
 *
 * Filename: YYYYMMDD-<slug>-<rand4>.md
 *
 * Backward compatible: also reads legacy .json files (written by older VSCode versions).
 *
 * Zero dependencies — uses only node:fs sync APIs.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { getEmbedder, setVSCodeEmbedder } from "./embed-config.mjs"
import { loadIndex, searchIndex } from "./indexer.mjs"

const VALID_TYPES = new Set(["rule", "knowledge", "decision", "pattern"])

function memoryDir(cwd) {
  return join(cwd, ".thincoder", "memory")
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ─── Filename ──────────────────────────────────────────────────

/** Convert title to filename slug: keep alphanumeric + CJK, convert rest to hyphens */
function slugify(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "untitled"
}

/** Generate entry filename: YYYYMMDD-<slug>-<rand4>.md */
function entryFilename(title) {
  const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "")
  const rand = Math.random().toString(36).slice(2, 6)
  return `${ymd}-${slugify(title)}-${rand}.md`
}

// ─── Markdown serialization ─────────────────────────────────────

/** Collapse to single line (prevent frontmatter injection via newlines) */
function oneLine(v) {
  return String(v).replace(/\s*\r?\n\s*/g, " ").trim()
}

/**
 * Serialize entry to markdown with YAML frontmatter.
 * Format identical to thincoder CLI (thincoder/src/markdown.mjs).
 */
function serializeEntry({ type, title, content, tags }) {
  const tagList = (tags || "").trim().split(/\s+/).filter(Boolean)
  const tagStr = tagList.map(t => oneLine(t).replaceAll(",", " ")).join(", ")
  return [
    "---",
    `type: ${type}`,
    `title: ${oneLine(title)}`,
    `tags: [${tagStr}]`,
    `author: unknown`,
    `created: ${new Date().toISOString().slice(0, 10)}`,
    "---",
    "",
    content.trim(),
    "",
  ].join("\n")
}

// ─── Markdown parsing ───────────────────────────────────────────

/**
 * Minimal YAML frontmatter parser.
 * Only supports `key: value` and `key: [a, b, c]` — our own format,
 * no need for full YAML. Identical to thincoder CLI.
 */
function parseFrontmatter(text) {
  const meta = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const [, key, raw] = m
    const value = raw.trim()
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    } else {
      meta[key] = value
    }
  }
  return meta
}

/**
 * Parse a markdown entry. Returns { meta, content } or null on failure.
 */
function parseEntry(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null
  const meta = parseFrontmatter(match[1])
  const content = match[2].trim()
  if (!VALID_TYPES.has(meta.type) || !meta.title) return null
  // tags may be array (from parser) or string; normalize to space-separated string
  const tags = Array.isArray(meta.tags) ? meta.tags.join(" ") : (meta.tags || "")
  return {
    type: meta.type,
    title: meta.title,
    content,
    tags,
    created: meta.created || "",
  }
}

// ─── File I/O ────────────────────────────────────────────────────

/** Read all memory entries (both .md and legacy .json). */
function readAllEntries(dir) {
  if (!existsSync(dir)) return []
  const entries = []
  try {
    for (const file of readdirSync(dir)) {
      try {
        const raw = readFileSync(join(dir, file), "utf8")
        if (file.endsWith(".md")) {
          const parsed = parseEntry(raw)
          if (parsed) entries.push({ ...parsed, _file: file })
        } else if (file.endsWith(".json")) {
          // Legacy JSON format — read for backward compatibility
          const parsed = JSON.parse(raw)
          if (VALID_TYPES.has(parsed.type) && parsed.title) {
            entries.push({
              type: parsed.type,
              title: parsed.title,
              content: parsed.content || "",
              tags: parsed.tags || "",
              created: (parsed.created_at || parsed.updated_at || "").slice(0, 10),
              _file: file,
            })
          }
        }
      } catch { /* skip corrupted files */ }
    }
  } catch { /* skip unreadable dir */ }
  return entries
}

// ─── Tokenization & scoring ─────────────────────────────────────

function tokenizeQuery(query) {
  const stopwords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "and", "but", "or",
    "nor", "not", "so", "yet", "both", "either", "neither", "each",
    "every", "all", "any", "few", "more", "most", "other", "some",
    "such", "no", "only", "own", "same", "than", "too", "very",
    "just", "about", "also", "it", "its", "this", "that", "these",
    "those", "i", "me", "my", "we", "our", "you", "your", "he",
    "she", "him", "her", "they", "them", "their", "what", "which",
    "who", "whom", "when", "where", "why", "how",
    // Chinese stopwords
    "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一",
    "一个", "这", "那", "也", "要", "会", "可", "没", "到", "说", "去",
    "你", "他", "她", "它", "们", "吗", "吧", "呢", "啊", "哦", "嗯",
  ])
  const tokens = query
    .toLowerCase()
    .split(/[\s,.;:()[\]{}"'`!@#$%^&*+=|\\<>?/~]+/)
    .filter(w => w.length > 1 && !stopwords.has(w))

  // De-duplicate
  const result = [...new Set(tokens)]

  // CJK fallback: if query has CJK chars but tokenization produced ≤ 2 tokens,
  // also include CJK bigrams and individual chars for better matching
  const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/u
  if (result.length <= 2 && hasCJK.test(query)) {
    const chars = query.replace(/[^\u4e00-\u9fff\u3400-\u4dbf]/gu, "")
    for (let i = 0; i < chars.length; i++) {
      result.push(chars[i])
      if (i < chars.length - 1) result.push(chars[i] + chars[i + 1])
    }
  }

  return [...new Set(result.filter(w => w.length > 1 || hasCJK.test(w)))]
}

/**
 * Score an entry against keywords.
 * title match = 3pts, tag match = 2pts, content match = 1pt
 */
function scoreEntry(entry, keywords) {
  if (!keywords.length) return 0
  const title = (entry.title || "").toLowerCase()
  const content = (entry.content || "").toLowerCase()
  const tags = (entry.tags || "").toLowerCase()
  let score = 0
  for (const kw of keywords) {
    if (title.includes(kw)) score += 3
    if (tags.includes(kw)) score += 2
    if (content.includes(kw)) score += 1
  }
  return score
}

// ─── tools ────────────────────────────────────────────────────

// exported for testing
export { tokenizeQuery, scoreEntry }

export const memoryPutTool = {
  name: "memory_put",
  description:
    "Save a piece of knowledge to long-term memory. Use when you learn something worth remembering across sessions: " +
    "a project convention, a debugging insight, an architecture decision. " +
    "Types: rule (coding standards), knowledge (project facts), decision (architecture decisions), pattern (debugging/workflow patterns). " +
    "If a vector index exists, memory_search uses semantic search (natural language queries work). " +
    "Parameters:\n" +
    "- type (required): Entry type\n" +
    "- title (required): Short title\n" +
    "- content (required): Full content to remember\n" +
    "- tags (optional): Space-separated tags (include bilingual keywords)\n" +
    "- scope (optional): \"personal\" or \"project\" (default \"personal\")",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: [...VALID_TYPES], description: "Entry type" },
      title: { type: "string", description: "Short title" },
      content: { type: "string", description: "Full content to remember" },
      tags: { type: "string", description: "Space-separated tags" },
      scope: { type: "string", enum: ["personal", "project"], description: "Where to save (default personal)" },
    },
    required: ["type", "title", "content"],
  },
  execute({ type, title, content, tags }, ctx) {
    if (!VALID_TYPES.has(type)) {
      return `Error: invalid type "${type}". Must be one of: ${[...VALID_TYPES].join(", ")}`
    }
    const dir = memoryDir(ctx.cwd)
    ensureDir(dir)

    const filePath = join(dir, entryFilename(title))
    const markdown = serializeEntry({ type, title: title.trim(), content: content.trim(), tags })
    writeFileSync(filePath, markdown, "utf8")
    return `Saved memory entry "${title}" (type: ${type})`
  },
}

/**
 * Search memory entries. Returns [{ type, title, content, tags, score }] sorted by relevance.
 * Used by both the memory_search tool and automatic context injection.
 */
export function search(cwd, query, { limit = 5 } = {}) {
  const dir = memoryDir(cwd)
  if (!existsSync(dir)) return []

  const entries = readAllEntries(dir)
  if (entries.length === 0) return []

  const keywords = tokenizeQuery(query)
  if (keywords.length === 0) {
    const raw = query.toLowerCase().split(/[\s,.;:()[\]{}"'`!@#$%^&*+=|\\<>?/~]+/).filter(w => w.length > 1)
    if (raw.length === 0) {
      entries.sort((a, b) => (b.created || "").localeCompare(a.created || ""))
      return entries.slice(0, limit)
    }
    keywords.push(...raw.slice(0, 6))
  }

  const scored = entries.map(e => ({
    ...e,
    score: scoreEntry(e, keywords),
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.filter(s => s.score > 0).slice(0, limit)
}

export const memorySearchTool = {
  readonly: true,
  name: "memory_search",
  description:
    "Search long-term memory across all entries for relevant knowledge saved in previous sessions. " +
    "Uses vector semantic search when available, falling back to keyword-based matching. " +
    "For vector search: use natural language queries. For keyword fallback: use short, specific terms. " +
    "Parameters:\n" +
    "- query (required): Search query (natural language preferred when vector index exists)\n" +
    "- limit (optional): Max results (default 5)",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results (default 5)" },
    },
    required: ["query"],
  },
  execute({ query, limit }, ctx) {
    // Try vector search first if embedder + index available
    try {
      const embedder = getEmbedder()
      const idx = embedder ? loadIndex(ctx.cwd) : null
      if (idx) {
        return (async () => {
          try {
            const vecResults = await searchIndex(ctx.cwd, embedder, query, { kind: "memory", limit: limit || 5 })
            if (vecResults.length > 0) {
              return vecResults.map((r) =>
                `${r.file}:${r.startLine}-${r.endLine} (score:${r.score.toFixed(3)})\n${r.snippet}`
              ).join("\n\n")
            }
          } catch {}
          const results = search(ctx.cwd, query, { limit })
          if (results.length === 0) return "No matching memories found."
          return formatResults(results)
        })()
      }
    } catch {}
    const results = search(ctx.cwd, query, { limit })
    if (results.length === 0) return "No matching memories found."
    return formatResults(results)
  },
}

function formatResults(entries) {
  return entries.map(e => {
    const title = e.title || "(untitled)"
    const type = e.type || "unknown"
    const tags = e.tags ? ` [${e.tags}]` : ""
    const content = (e.content || "").slice(0, 200)
    const truncated = e.content && e.content.length > 200 ? "..." : ""
    return `[${type}]${tags} ${title}\n  ${content}${truncated}`
  }).join("\n\n")
}
