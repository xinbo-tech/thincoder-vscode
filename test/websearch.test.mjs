/**
 * websearch.test.mjs — Tavily structured search (optional provider).
 * When config.websearch.apiKey is set, websearch calls the Tavily API (stable
 * JSON, no HTML scraping); otherwise it silently falls back to Bing extraction.
 */
import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { websearchTool } from "../src/tools/web.mjs"

let origFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = origFetch })

describe("websearch — Tavily structured search", () => {
  it("uses Tavily when a key is configured (Bing is not reached)", async () => {
    let hitTavily = false
    globalThis.fetch = async (url) => {
      if (String(url).includes("api.tavily.com")) {
        hitTavily = true
        return new Response(JSON.stringify({
          results: [
            { title: "Tavily Hit", url: "https://example.com/a", content: "snippet A", score: 0.9 },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      throw new Error("Bing should not be reached")
    }
    const ctx = { agent: { config: { proxy: { web: false }, websearch: { provider: "tavily", apiKey: "tvly-test" } } } }
    const out = await websearchTool.execute({ query: "hello", limit: 2 }, ctx)
    assert.ok(hitTavily, "Tavily endpoint called")
    assert.match(out, /\[tavily\] Tavily Hit/)
    assert.match(out, /snippet A/)
  })

  it("falls back to Bing when no key is configured", async () => {
    globalThis.fetch = async () => new Response("<html><li class=\"b_algo\"><h2><a href=\"https://e.com\">Bing Result</a></h2><p>bing snippet</p></li></html>", { status: 200 })
    const ctx = { agent: { config: { proxy: { web: false }, websearch: { provider: "tavily", apiKey: "" } } } }
    const out = await websearchTool.execute({ query: "hello", limit: 2 }, ctx)
    assert.doesNotMatch(out, /\[tavily\]/, "no key → no Tavily")
    assert.match(out, /Bing Result/)
  })
})
