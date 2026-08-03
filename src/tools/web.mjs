/**
 * web.mjs — Web tools: websearch, fetch
 * Both route through the shared proxy when config proxy.web is on (CLI parity).
 */

import { proxyFetch, resolveWebProxy } from "../proxy.mjs"

export const websearchTool = {
  readonly: true,
  name: "websearch",
  description:
    "Search the web. Returns result titles, URLs, and snippets.\n" +
    "Parameters:\n" +
    "- query (required): Search query\n" +
    "- limit: Max results (default 8)",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results" },
    },
    required: ["query"],
  },
  async execute({ query, limit }, ctx) {
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit || 8}`
      const res = await proxyFetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ThinCoder-VSCode/0.1" },
      }, resolveWebProxy(ctx))
      const html = await res.text()
      // Simple extraction: find result snippets
      const results = []
      const snippetRe = /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi
      let match
      while ((match = snippetRe.exec(html)) && results.length < (limit || 8)) {
        results.push({
          url: match[1],
          title: match[2].replace(/<[^>]+>/g, "").trim(),
          snippet: match[3].replace(/<[^>]+>/g, "").trim(),
        })
      }
      if (results.length === 0) return "(no results found)"
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n")
    } catch (e) {
      return `websearch error: ${e.message}`
    }
  },
}

export const fetchTool = {
  readonly: true,
  name: "fetch",
  description:
    "Fetch a URL and return its content as text.\n" +
    "Parameters:\n" +
    "- url (required): http/https URL",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
    },
    required: ["url"],
  },
  async execute({ url }, ctx) {
    try {
      const res = await proxyFetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 ThinCoder-VSCode/0.1" },
        signal: AbortSignal.timeout(20000),
      }, resolveWebProxy(ctx))
      const text = await res.text()
      // Strip HTML tags for cleaner output
      const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
      return stripped.slice(0, 20000)
    } catch (e) {
      return `fetch error: ${e.message}`
    }
  },
}
