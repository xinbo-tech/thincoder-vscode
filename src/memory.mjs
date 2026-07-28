/**
 * memory.mjs — File-based memory system for ThinCoder VS Code
 *
 * Each entry is a JSON file in .thincoder/memory/.
 * Data model: { id, type, title, content, tags, created_at, updated_at }
 * Types: "rule" | "knowledge" | "decision" | "pattern"
 *
 * Zero dependencies — uses only node:fs sync APIs.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

const VALID_TYPES = new Set(["rule", "knowledge", "decision", "pattern"])

function memoryDir(cwd) {
  return join(cwd, ".thincoder", "memory")
}

function generateId() {
  const ts = Date.now().toString(36)
  const rand = randomBytes(4).toString("hex")
  return `${ts}-${rand}`
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readAllEntries(dir) {
  if (!existsSync(dir)) return []
  const entries = []
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue
      try {
        const raw = readFileSync(join(dir, file), "utf8")
        entries.push(JSON.parse(raw))
      } catch { /* skip corrupted files */ }
    }
  } catch { /* skip unreadable dir */ }
  return entries
}

/**
 * Split query into meaningful keywords.
 * Lowercase, remove stopwords, return unique non-empty tokens.
 */
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
  ])
  return query
    .toLowerCase()
    .split(/[\s,.;:()\[\]{}"'`!@#$%^&*+=|\\<>?/~]+/)
    .filter(w => w.length > 1 && !stopwords.has(w))
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

export const memoryPutTool = {
  name: "memory_put",
  description:
    "Save a piece of knowledge to long-term memory. Use when you learn something worth remembering across sessions: " +
    "a project convention, a debugging insight, an architecture decision. " +
    "Types: rule (coding standards), knowledge (project facts), decision (architecture decisions), pattern (debugging/workflow patterns). " +
    "Parameters:\n" +
    "- type (required): Entry type — \"rule\", \"knowledge\", \"decision\", or \"pattern\"\n" +
    "- title (required): Short title\n" +
    "- content (required): Full content to remember\n" +
    "- tags (optional): Space-separated tags\n" +
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

    const now = new Date().toISOString()
    const id = generateId()
    const entry = {
      id,
      type,
      title: title.trim(),
      content: content.trim(),
      tags: (tags || "").trim(),
      created_at: now,
      updated_at: now,
    }

    const filePath = join(dir, `${id}.json`)
    writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf8")
    return `Saved memory entry "${title}" (type: ${type}, id: ${id})`
  },
}

/**
 * Search memory entries. Returns [{ id, type, title, content, tags, score }] sorted by relevance.
 * Used by both the memory_search tool and automatic context injection.
 */
export function search(cwd, query, { limit = 5 } = {}) {
  const dir = memoryDir(cwd)
  if (!existsSync(dir)) return []

  const entries = readAllEntries(dir)
  if (entries.length === 0) return []

  const keywords = tokenizeQuery(query)
  if (keywords.length === 0) {
    const raw = query.toLowerCase().split(/[\s,.;:()\[\]{}"'`!@#$%^&*+=|\\<>?/~]+/).filter(w => w.length > 1)
    if (raw.length === 0) {
      entries.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
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
  name: "memory_search",
  description:
    "Search long-term memory across all entries for relevant knowledge saved in previous sessions. " +
    "Use the same language as the memories being searched. " +
    "Parameters:\n" +
    "- query (required): Natural language search query\n" +
    "- limit (optional): Max results (default 5)",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language search query" },
      limit: { type: "number", description: "Max results (default 5)" },
    },
    required: ["query"],
  },
  execute({ query, limit }, ctx) {
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
