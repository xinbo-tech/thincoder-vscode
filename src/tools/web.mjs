/**
 * web.mjs — Web tools: websearch, fetch
 * Both route through the shared proxy when config proxy.web is on (CLI parity).
 */

import { proxyFetch, resolveWebProxy } from "../proxy.mjs"
import { isPrivateHost } from "./shared.mjs"
import { URL } from "node:url"

/** True when the URL resolves to a private/internal host (SSRF guard). */
function isPrivateUrl(urlStr) {
  let u; try { u = new URL(urlStr) } catch { return true }
  return isPrivateHost(u.hostname)
}

/** Structured search via Tavily (optional — config.websearch.apiKey). Returns a
 *  formatted result string, or null to fall back to Bing HTML scraping. */
async function fetchTavily(query, limit, ctx) {
  const apiKey = ctx?.agent?.config?.websearch?.apiKey
  if (!apiKey) return null
  try {
    const res = await proxyFetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ query, search_depth: "basic", max_results: limit, include_answer: false, include_raw_content: false }),
      signal: AbortSignal.timeout(15000),
    }, resolveWebProxy(ctx))
    if (!res.ok) return null
    const data = await res.json()
    const results = Array.isArray(data.results) ? data.results : []
    if (results.length === 0) return null
    return results.slice(0, limit).map((r, i) => `${i + 1}. [tavily] ${r.title ?? ""}\n   ${r.url}\n   ${r.content ?? ""}`).join("\n\n")
  } catch {
    return null // any failure → Bing fallback
  }
}

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
    const max = limit || 8
    // Structured search first when a Tavily key is configured (stable, no HTML
    // scraping); silently falls back to Bing HTML extraction.
    const tavily = await fetchTavily(query, max, ctx)
    if (tavily) return tavily
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${max}`
      const res = await proxyFetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ThinCoder-VSCode/0.1" },
      }, resolveWebProxy(ctx))
      const html = await res.text()
      // Simple extraction: find result snippets
      const results = []
      const snippetRe = /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi
      let match
      while ((match = snippetRe.exec(html)) && results.length < max) {
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
    // SSRF guard (CLI parity): http/https only, and no private/internal targets.
    if (!/^https?:\/\//.test(url)) return "fetch error: url must start with http:// or https://"
    if (isPrivateUrl(url)) return "fetch error: internal/private/metadata addresses are not allowed"
    try {
      const res = await proxyFetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 ThinCoder-VSCode/0.1" },
        signal: AbortSignal.timeout(20000),
        // No automatic redirect following: a 3xx could bounce a public URL into
        // a private host (SSRF via redirect). Refuse instead of chasing it.
        redirect: "manual",
      }, resolveWebProxy(ctx))
      if ([301, 302, 307, 308].includes(res.status)) {
        return `fetch error: redirect (HTTP ${res.status}) not followed`
      }
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
