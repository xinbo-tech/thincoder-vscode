/**
 * code.mjs — Code understanding tools: code_search, doc_search
 */

import * as vscode from "vscode"

export const codeSearchTool = {
  readonly: true,
  name: "code_search",
  description:
    "Search the project's source code for relevant code. Use this to find functions, classes, or code patterns across the codebase. " +
    "Supports natural language queries and code snippets. Returns matching code chunks with file paths and line numbers.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language or code snippet to search for" },
      limit: { type: "number", description: "Max results (default 5)" },
    },
    required: ["query"],
  },
  async execute({ query, limit }, ctx) {
    const maxResults = limit || 5
    // Extract keywords from query for search
    const keywords = query
      .split(/[\s,.;:()\[\]{}"'`!@#$%^&*+=|\\<>?/~]+/)
      .filter((w) => w.length > 1)
      .slice(0, 6)

    if (keywords.length === 0) keywords.push(query.slice(0, 30))

    // Build a regex pattern: match any of the keywords (case-insensitive)
    const pattern = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    const filePattern = "**/*.{js,mjs,cjs,jsx,ts,tsx,py,rs,go,java,c,cpp,h,hpp}"
    const excludePattern = "**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.turbo/**"

    try {
      const results = []
      const uris = await vscode.workspace.findFiles(filePattern, excludePattern, 2000)

      for (const uri of uris) {
        if (results.length >= maxResults) break
        const relPath = uri.fsPath.slice(ctx.cwd.length + 1).replace(/\\/g, "/")
        try {
          const raw = await vscode.workspace.fs.readFile(uri)
          const text = new TextDecoder().decode(raw)
          const lines = text.split("\n")
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            if (new RegExp(pattern, "i").test(lines[i])) {
              // Grab a few lines of context around the match
              const start = Math.max(0, i - 2)
              const end = Math.min(lines.length, i + 3)
              const snippet = lines.slice(start, end)
                .map((l, j) => `${start + j + 1}: ${l}`)
                .join("\n")
              results.push({ path: relPath, line: i + 1, snippet })
              i += 2 // skip ahead to avoid duplicate results from same file
            }
          }
        } catch { /* skip unreadable */ }
      }

      if (results.length === 0) return "No matches found."
      return results.map((r) => `${r.path}:${r.line}:\n${r.snippet}`).join("\n\n")
    } catch (e) {
      return `Search error: ${e.message}`
    }
  },
}

export const docSearchTool = {
  readonly: true,
  name: "doc_search",
  description:
    "Search the project's documentation (README, design docs, guides, markdown files) for relevant information. " +
    "Use this to find design decisions, coding conventions, architecture docs, or project rules. " +
    "Prefer this over code_search when you need to understand the project's intended design rather than existing implementation.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language search query" },
      limit: { type: "number", description: "Max results (default 5)" },
    },
    required: ["query"],
  },
  async execute({ query, limit }, ctx) {
    const maxResults = limit || 5
    const keywords = query
      .split(/[\s,.;:()\[\]{}"'`!@#$%^&*+=|\\<>?/~]+/)
      .filter((w) => w.length > 1)
      .slice(0, 6)

    if (keywords.length === 0) keywords.push(query.slice(0, 30))

    const pattern = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    const filePattern = "**/*.{md,markdown,txt}"
    const excludePattern = "**/node_modules/**"

    try {
      const results = []
      const uris = await vscode.workspace.findFiles(filePattern, excludePattern, 1000)

      for (const uri of uris) {
        if (results.length >= maxResults) break
        const relPath = uri.fsPath.slice(ctx.cwd.length + 1).replace(/\\/g, "/")
        try {
          const raw = await vscode.workspace.fs.readFile(uri)
          const text = new TextDecoder().decode(raw)
          // Split by ## headings for structured chunks
          const chunks = text.split(/\n(?=#{1,3}\s)/)
          for (const chunk of chunks) {
            if (results.length >= maxResults) break
            if (new RegExp(pattern, "i").test(chunk)) {
              const cleaned = chunk.trim().slice(0, 800)
              results.push(`${relPath}:\n${cleaned}`)
            }
          }
        } catch { /* skip unreadable */ }
      }

      if (results.length === 0) return "No documentation matches found."
      return results.join("\n\n---\n\n")
    } catch (e) {
      return `Search error: ${e.message}`
    }
  },
}
