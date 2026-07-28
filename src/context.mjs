/**
 * context.mjs — context compaction + repo outline
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { join, extname, relative } from "node:path"

const COMPACT_THRESHOLD = 80000  // estimated tokens
const TOKEN_ESTIMATE_CHARS = 3.5

/**
 * Estimate token count from message array.
 */
function estimateTokens(messages) {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length
  }
  return Math.ceil(chars / TOKEN_ESTIMATE_CHARS)
}

/**
 * Compact history: summarize old messages, keep recent ones.
 * Returns a new history array or null if no compaction needed.
 */
export function compactHistory(history, systemPrompt) {
  const systemTokens = Math.ceil(systemPrompt.length / TOKEN_ESTIMATE_CHARS)
  const total = systemTokens + estimateTokens(history)

  if (total < COMPACT_THRESHOLD) return null

  // Find cutoff: keep last ~30 messages, summarize the rest
  const keepCount = Math.min(30, Math.floor(history.length * 0.4))
  const oldMessages = history.slice(0, history.length - keepCount)
  const recentMessages = history.slice(history.length - keepCount)

  // Build summary of old messages
  const summary = buildSummary(oldMessages)

  return [
    {
      role: "user",
      content: `[Context compacted: earlier conversation summarized below. Trust the summary — don't redo work it reports done. But re-verify transient state (open editors, file contents) before acting on it.]\n\n<conversation_summary>\n${summary}\n</conversation_summary>`,
    },
    ...recentMessages,
  ]
}

function buildSummary(messages) {
  const parts = []
  let currentSpeaker = null
  let currentText = ""

  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") {
      if (currentText) parts.push(`${currentSpeaker}: ${currentText.slice(0, 300)}`)
      currentSpeaker = "User"
      currentText = m.content
    } else if (m.role === "assistant" && typeof m.content === "string") {
      if (currentSpeaker !== "Assistant") {
        if (currentText) parts.push(`${currentSpeaker}: ${currentText.slice(0, 300)}`)
        currentSpeaker = "Assistant"
        currentText = m.content
      } else {
        currentText += " " + m.content
      }
    } else if (m.role === "tool") {
      if (currentText) parts.push(`${currentSpeaker}: ${currentText.slice(0, 200)}`)
      currentSpeaker = "Tool"
      currentText = `Result: ${String(m.content).slice(0, 100)}`
    }
  }
  if (currentText) parts.push(`${currentSpeaker}: ${currentText.slice(0, 300)}`)

  return parts.join("\n")
}

/**
 * Build a repo dependency outline for the project.
 * Scans .js/.mjs/.ts/.jsx/.tsx files for imports/exports.
 */
export function buildRepoOutline(cwd) {
  try {
    const files = collectSourceFiles(cwd)
    if (files.length === 0) return null
    if (files.length > 2000) return `(too many files: ${files.length} — skipping outline)`

    const imports = new Map()  // file → [imported files]
    const exports = new Map()  // file → [exported symbols]

    for (const f of files) {
      try {
        const content = readFileSync(f, "utf8").slice(0, 50000)
        const deps = parseImports(content)
        const exps = parseExports(content)
        if (deps.length > 0 || exps.length > 0) {
          const rel = relative(cwd, f)
          imports.set(rel, deps)
          exports.set(rel, exps)
        }
      } catch { /* skip unreadable */ }
    }

    if (imports.size === 0) return null

    // Build text outline
    const lines = [`${imports.size} source files indexed.`]
    lines.push("")

    // Group by directory
    const dirs = new Map()
    for (const [file, deps] of imports) {
      const dir = relative(cwd, join(cwd, file)).split("/").slice(0, -1).join("/") || "."
      if (!dirs.has(dir)) dirs.set(dir, { files: [], deps: new Set() })
      const entry = dirs.get(dir)
      entry.files.push(file)
      for (const d of deps) entry.deps.add(d)
    }

    for (const [dir, info] of dirs) {
      const suffix = info.deps.size > 0
        ? ` → depends on ${[...info.deps].slice(0, 6).map((d) => relative(cwd, d)).join(", ")}${info.deps.size > 6 ? ` (+${info.deps.size - 6} more)` : ""}`
        : ""
      lines.push(`${dir}/ (${info.files.length} files)${suffix}`)
    }

    return lines.join("\n")
  } catch {
    return null
  }
}

function collectSourceFiles(root) {
  const results = []
  const stack = [root]
  const seen = new Set(["node_modules", ".git", "dist", "build", ".turbo", "coverage", ".next", "__pycache__"])

  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (seen.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(full)
      } else if (/\.(m?js|tsx?|jsx)$/.test(e.name)) {
        results.push(full)
      }
    }
  }
  return results
}

function parseImports(content) {
  const deps = []
  const re = /(?:import\s.*?\sfrom\s+["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)|import\s*\(\s*["']([^"']+)["']\s*\))/g
  let m
  while ((m = re.exec(content))) {
    const p = m[1] || m[2] || m[3]
    if (p && !p.startsWith("node:") && !p.startsWith("vscode")) {
      deps.push(p)
    }
  }
  return deps
}

function parseExports(content) {
  const exps = []
  const re = /export\s+(?:const|let|var|function|class|default\s+(?:function|class)?)\s+(\w+)/g
  let m
  while ((m = re.exec(content))) {
    exps.push(m[1])
  }
  return exps
}
