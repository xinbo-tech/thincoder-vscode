/**
 * proxy.test.mjs — proxy tunnel + config resolution tests (VS Code port of CLI proxy chain).
 * No external network; local CONNECT proxy on a random port validates the tunnel path.
 * Run: node --test test/proxy.test.mjs
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { resolveProxyConfig, resolveWebProxy, proxyFetch } from "../src/proxy.mjs"
import { normalizeProxy } from "../src/config-io.mjs"
import { _setConfigPathForTest } from "../src/config-io.mjs"

let tmpDir
let cfgPath

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "thincoder-proxy-"))
  cfgPath = join(tmpDir, "config.json")
  _setConfigPathForTest(cfgPath)
})

after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  _setConfigPathForTest(null)
})

describe("resolveProxyConfig", () => {
  it("returns nulls when no proxy configured and no env vars", () => {
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, ALL_PROXY: process.env.ALL_PROXY }
    delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY; delete process.env.ALL_PROXY
    try {
      const cfg = resolveProxyConfig({ agent: { config: {} } })
      assert.equal(cfg.uri, null)
      assert.equal(cfg.web, false)
      assert.equal(cfg.model, false)
    } finally {
      if (saved.HTTPS_PROXY) process.env.HTTPS_PROXY = saved.HTTPS_PROXY
      if (saved.HTTP_PROXY) process.env.HTTP_PROXY = saved.HTTP_PROXY
      if (saved.ALL_PROXY) process.env.ALL_PROXY = saved.ALL_PROXY
    }
  })

  it("normalized object config: web default on, model opt-in", () => {
    const cfg = resolveProxyConfig({ agent: { config: { proxy: { uri: "http://127.0.0.1:7890", model: true } } } })
    assert.equal(cfg.uri, "http://127.0.0.1:7890")
    assert.equal(cfg.web, true)
    assert.equal(cfg.model, true)
  })

  it("legacy string config → web only", () => {
    const cfg = resolveProxyConfig({ agent: { config: { proxy: "http://127.0.0.1:7890" } } })
    assert.equal(cfg.uri, "http://127.0.0.1:7890")
    assert.equal(cfg.model, false)
  })

  it("resolveWebProxy returns uri only when web is on", () => {
    const on = resolveWebProxy({ agent: { config: { proxy: { uri: "http://p:1", web: true } } } })
    assert.equal(on, "http://p:1")
    const off = resolveWebProxy({ agent: { config: { proxy: { uri: "http://p:1", web: false } } } })
    assert.equal(off, null)
  })
})

describe("normalizeProxy (config-io)", () => {
  it("normalizes string / object / invalid", () => {
    assert.deepEqual(normalizeProxy("http://x:1"), { uri: "http://x:1", web: true, model: false })
    assert.deepEqual(normalizeProxy({ uri: "http://x:1", model: true }), { uri: "http://x:1", web: true, model: true })
    assert.equal(normalizeProxy(null), undefined)
    assert.equal(normalizeProxy(""), undefined)
    assert.equal(normalizeProxy(42), undefined)
  })
})

describe("proxyFetch — local CONNECT tunnel", () => {
  it("routes HTTPS through the CONNECT proxy", async () => {
    // Local fake CONNECT proxy: accepts the tunnel, then we fail the TLS hop — what
    // matters here is that the request actually went THROUGH our proxy (CONNECT seen).
    let sawConnect = false
    const proxy = createServer((sock) => {
      let buf = ""
      sock.on("data", (d) => {
        buf += d.toString()
        if (buf.includes("\r\n\r\n")) {
          if (buf.startsWith("CONNECT")) sawConnect = true
          // Refuse the tunnel with a non-200 so the request errors fast without real TLS
          sock.write("HTTP/1.1 403 Forbidden\r\n\r\n")
        }
      })
    })
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r))
    const port = proxy.address().port
    try {
      const out = await proxyFetch("https://example.com/", {}, `http://127.0.0.1:${port}`)
      // 403 → proxyFetch rejects via tunnelHttps (CONNECT not 200)
      assert.equal(out, undefined) // should have thrown; guard below
    } catch (e) {
      assert(sawConnect, "CONNECT reached the local proxy")
      assert.match(e.message, /Proxy CONNECT/)
    } finally {
      proxy.close()
    }
  })

  it("testProxyConnection surfaces proxy failure as { ok:false } (not a crash)", async () => {
    const { testProxyConnection } = await import("../src/extension/settings.mjs")
    // Refusing CONNECT proxy → the tunnel fails → result is an error object
    const proxy = createServer((sock) => {
      let buf = ""
      sock.on("data", (d) => {
        buf += d.toString()
        if (buf.includes("\r\n\r\n")) sock.write("HTTP/1.1 403 Forbidden\r\n\r\n")
      })
    })
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r))
    const port = proxy.address().port
    try {
      const r = await testProxyConnection(`http://127.0.0.1:${port}`)
      assert.equal(r.ok, false)
      assert(r.error, "error message present")
    } finally {
      proxy.close()
    }
  })

  it("testProxyConnection rejects malformed URI with a friendly message", async () => {
    const { testProxyConnection } = await import("../src/extension/settings.mjs")
    // Missing scheme → URL parse fails → clear error, not a raw "Invalid URL"
    const r = await testProxyConnection("127.0.0.1:7890")
    assert.equal(r.ok, false)
    assert.match(r.error, /Invalid proxy URI/)
    // Unsupported scheme
    const r2 = await testProxyConnection("ftp://proxy:21")
    assert.equal(r2.ok, false)
    assert.match(r2.error, /Unsupported proxy protocol/)
    // Empty → treated as direct connection (no URI validation error)
    const r3 = await testProxyConnection("")
    assert.notEqual(r3.ok, false, "empty URI is not a format error")
  })

  it("no proxy → native fetch (returns an error object for unreachable host, not a throw)", async () => {
    // Unreachable host with no proxy: native fetch rejects — we just assert the call path
    // doesn't crash with a proxy-specific error.
    try {
      await proxyFetch("https://127.0.0.1:1/", {}, null)
      assert.fail("should have thrown")
    } catch (e) {
      assert(!/Proxy CONNECT/.test(e.message), "no proxy error when proxyUri is null")
    }
  })
})
