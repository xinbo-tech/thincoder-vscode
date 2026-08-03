/**
 * provider-panel.test.mjs — settings panel provider management (batch A, SETTINGS-PANEL.md)
 * Tests the pure persistence functions shared by the panel and QuickPick paths.
 * Run: node --test test/provider-panel.test.mjs
 */
import { describe, it, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { addProviderEntry, removeProviderEntry, setActiveProviderEntry } from "../src/extension/provider-flows.mjs"
import { handleSetProviderProxy } from "../src/extension/settings.mjs"
import { _setConfigPathForTest, resolveProviders } from "../src/config-io.mjs"

let tmpDir
let cfgPath

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "thincoder-provpanel-"))
  cfgPath = join(tmpDir, "config.json")
  _setConfigPathForTest(cfgPath)
})

after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  _setConfigPathForTest(null)
})

beforeEach(() => {
  if (existsSync(cfgPath)) rmSync(cfgPath)
})

function raw() { return JSON.parse(readFileSync(cfgPath, "utf8")) }

describe("addProviderEntry — preset", () => {
  it("adds a preset entry with preset values and optional key", () => {
    // Note: on an EMPTY config, resolveProviders falls back to the default deepseek
    // entry (CLI loadConfig parity), so deepseek counts as "already there" — use kimi.
    const err = addProviderEntry({ preset: "kimi", key: "sk-kimi" })
    assert.equal(err, null)
    const { providers } = resolveProviders()
    const kimi = providers.find((p) => p.name === "kimi")
    assert(kimi)
    assert.equal(kimi.baseURL, "https://api.moonshot.cn/v1")
    assert.equal(kimi.model, "kimi-k3")
    assert.equal(kimi.apiKey, "sk-kimi")
  })

  it("rejects an unknown preset", () => {
    const err = addProviderEntry({ preset: "nope" })
    assert.match(err, /Unknown preset/)
  })

  it("rejects a duplicate preset", () => {
    addProviderEntry({ preset: "glm" })
    const err = addProviderEntry({ preset: "glm" })
    assert.match(err, /already exists/)
  })
})

describe("addProviderEntry — custom", () => {
  it("adds a custom entry with format written for non-openai", () => {
    const err = addProviderEntry({
      custom: { name: "mygw", baseURL: "https://gw.example.com/v1/", model: "gw-model", format: "anthropic" },
      key: "sk-gw",
    })
    assert.equal(err, null)
    const e = raw().providers.find((p) => p.name === "mygw")
    assert.equal(e.baseURL, "https://gw.example.com/v1") // trailing slash stripped
    assert.equal(e.format, "anthropic")
    assert.equal(e.apiKey, "sk-gw")
  })

  it("omits format for openai (default)", () => {
    addProviderEntry({ custom: { name: "plain", baseURL: "https://x.test/v1", model: "m", format: "openai" } })
    const e = raw().providers.find((p) => p.name === "plain")
    assert.equal("format" in e, false)
  })

  it("rejects missing name / baseURL / model", () => {
    assert.match(addProviderEntry({ custom: { baseURL: "u", model: "m" } }), /name is required/i)
    assert.match(addProviderEntry({ custom: { name: "n", model: "m" } }), /Base URL is required/i)
    assert.match(addProviderEntry({ custom: { name: "n", baseURL: "u" } }), /Model is required/i)
  })

  it("rejects unknown format and duplicate name", () => {
    assert.match(addProviderEntry({ custom: { name: "n", baseURL: "u", model: "m", format: "soap" } }), /Unknown API format/)
    addProviderEntry({ custom: { name: "dup", baseURL: "u", model: "m" } })
    assert.match(addProviderEntry({ custom: { name: "dup", baseURL: "u", model: "m" } }), /already in use/)
    // A preset name is also reserved
    assert.match(addProviderEntry({ custom: { name: "glm", baseURL: "u", model: "m" } }), /already in use/)
  })

  it("allows multiple custom providers (D4)", () => {
    addProviderEntry({ custom: { name: "c1", baseURL: "u1", model: "m1" } })
    addProviderEntry({ custom: { name: "c2", baseURL: "u2", model: "m2" } })
    const { providers } = resolveProviders()
    assert(providers.some((p) => p.name === "c1"))
    assert(providers.some((p) => p.name === "c2"))
  })
})

describe("removeProviderEntry", () => {
  it("removes a non-active provider", () => {
    writeFileSync(cfgPath, JSON.stringify({
      providers: [
        { name: "a", baseURL: "u", model: "m", apiKey: "k" },
        { name: "b", baseURL: "u", model: "m" },
      ],
      activeProvider: "a",
    }))
    assert.equal(removeProviderEntry("b"), null)
    const { providers } = resolveProviders()
    assert.equal(providers.some((p) => p.name === "b"), false)
    assert(providers.some((p) => p.name === "a"))
  })

  it("protects the active provider", () => {
    writeFileSync(cfgPath, JSON.stringify({
      providers: [{ name: "a", baseURL: "u", model: "m" }],
      activeProvider: "a",
    }))
    assert.match(removeProviderEntry("a"), /cannot be removed/)
  })

  it("rejects unknown name", () => {
    writeFileSync(cfgPath, JSON.stringify({ providers: [{ name: "a", baseURL: "u", model: "m" }], activeProvider: "a" }))
    assert.match(removeProviderEntry("zzz"), /No provider/)
  })
})

describe("setActiveProviderEntry", () => {
  it("points activeProvider at an existing entry", () => {
    writeFileSync(cfgPath, JSON.stringify({
      providers: [
        { name: "a", baseURL: "u", model: "m" },
        { name: "b", baseURL: "u", model: "m" },
      ],
      activeProvider: "a",
    }))
    assert.equal(setActiveProviderEntry("b"), null)
    assert.equal(raw().activeProvider, "b")
  })

  it("rejects unknown name", () => {
    writeFileSync(cfgPath, JSON.stringify({ providers: [{ name: "a", baseURL: "u", model: "m" }], activeProvider: "a" }))
    assert.match(setActiveProviderEntry("zzz"), /No provider/)
    assert.equal(raw().activeProvider, "a")
  })
})

// ─── per-provider proxy flag (row checkbox, preset/custom agnostic) ───

describe("handleSetProviderProxy", () => {
  it("sets proxy: true on the entry", () => {
    writeFileSync(cfgPath, JSON.stringify({ providers: [{ name: "a", baseURL: "u", model: "m" }], activeProvider: "a" }))
    handleSetProviderProxy("a", true)
    assert.equal(raw().providers[0].proxy, true)
  })

  it("false deletes the field (not written as false)", () => {
    writeFileSync(cfgPath, JSON.stringify({ providers: [{ name: "a", baseURL: "u", model: "m", proxy: true }], activeProvider: "a" }))
    handleSetProviderProxy("a", false)
    const entry = raw().providers[0]
    assert.equal("proxy" in entry, false)
  })

  it("unknown provider is a no-op", () => {
    writeFileSync(cfgPath, JSON.stringify({ providers: [{ name: "a", baseURL: "u", model: "m" }], activeProvider: "a" }))
    handleSetProviderProxy("zzz", true)
    assert.equal("proxy" in raw().providers[0], false)
  })

  it("works for custom providers too (preset/custom agnostic)", () => {
    writeFileSync(cfgPath, JSON.stringify({ providers: [{ name: "custom", baseURL: "u", model: "m" }], activeProvider: "custom" }))
    handleSetProviderProxy("custom", true)
    assert.equal(raw().providers[0].proxy, true)
  })
})
