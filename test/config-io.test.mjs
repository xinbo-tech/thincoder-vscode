/**
 * config-io.test.mjs — shared config.json I/O + legacy migration (pure Node, no VS Code).
 * Run: node --test test/config-io.test.mjs
 */
import { describe, it, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  PROVIDER_PRESETS, presetToEntry,
  _setConfigPathForTest, loadRaw, saveRaw, persistRaw,
  findProvider, resolveProviders, resolveKey, resolveModel,
  providerFromConfig, setProviderKey, removeProviderKeyFromConfig,
  selectProviderModel, providerNamesInConfig,
  loadEmbeddingConfig, saveEmbeddingConfig, migrateCore,
  loadMcpServers, addMcpServer, removeMcpServer,
  loadAgentSettings, saveAgentSettings, saveAgentSettingsFromPanel,
} from "../src/config-io.mjs"

let tmpDir
let cfgPath
const savedEnv = {}

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "thincoder-cfgio-"))
  cfgPath = join(tmpDir, "config.json")
  _setConfigPathForTest(cfgPath)
  for (const k of ["THINCODER_BASE_URL", "THINCODER_MODEL", "THINCODER_ACTIVE_MODEL", "THINCODER_ACTIVE_PROVIDER"]) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  if (existsSync(cfgPath)) rmSync(cfgPath)
})

function writeCfg(obj) {
  writeFileSync(cfgPath, JSON.stringify(obj, null, 2))
}
function readCfg() {
  return JSON.parse(readFileSync(cfgPath, "utf8"))
}

// ─── Preset table ─────────────────────────────────────────────

describe("PROVIDER_PRESETS — CLI parity", () => {
  it("mirrors the CLI preset values (endpoints, models, field names)", () => {
    assert.equal(Object.keys(PROVIDER_PRESETS).length, 18)
    assert.equal(PROVIDER_PRESETS.deepseek.baseURL, "https://api.deepseek.com") // no /v1
    assert.equal(PROVIDER_PRESETS.minimax.baseURL, "https://api.minimaxi.com/v1")
    assert.equal(PROVIDER_PRESETS.grok.model, "grok-4.5")
    assert.equal(PROVIDER_PRESETS.kimi.thinking, null)
    assert.equal(PROVIDER_PRESETS["kimi-code"].baseURL, "https://api.kimi.com/coding/v1") // IK5VGJ
    assert.equal(PROVIDER_PRESETS["kimi-code"].model, "k3")
    assert.equal(PROVIDER_PRESETS["glm-code"].baseURL, "https://open.bigmodel.cn/api/coding/paas/v4") // Zhipu coding plan
    assert.equal(PROVIDER_PRESETS["glm-code"].model, "glm-5.2")
    assert.equal(PROVIDER_PRESETS.qwen.reasoningEffort, "high")
    // field names use CLI vocabulary: reasoningEffort / desc (not defaultEffort / label)
    assert.equal("reasoningEffort" in PROVIDER_PRESETS.deepseek, true)
    assert.equal("desc" in PROVIDER_PRESETS.deepseek, true)
    assert.equal("defaultEffort" in PROVIDER_PRESETS.deepseek, false)
    assert.equal("label" in PROVIDER_PRESETS.deepseek, false)
  })

  it("presetToEntry strips desc, keeps everything else", () => {
    const entry = presetToEntry("claude")
    assert.equal(entry.name, "claude")
    assert.equal(entry.format, "anthropic")
    assert.equal("desc" in entry, false)
    assert.equal(presetToEntry("nope"), null)
  })
})

// ─── Raw read / write ─────────────────────────────────────────

describe("loadRaw / saveRaw", () => {
  it("returns {} when file is missing", () => {
    assert.deepEqual(loadRaw(), {})
  })

  it("throws on invalid JSON (CLI parity)", () => {
    writeFileSync(cfgPath, "{ not json")
    assert.throws(() => loadRaw(), /not valid JSON/)
  })

  it("round-trips with $schema injection and trailing newline", () => {
    saveRaw({ providers: [{ name: "a", apiKey: "k" }], activeProvider: "a" })
    const text = readFileSync(cfgPath, "utf8")
    assert(text.endsWith("\n"))
    const parsed = readCfg()
    assert.equal(parsed.$schema, "https://thincoder.dev/schemas/config.json")
    assert.equal(parsed.activeProvider, "a")
  })

  it("persistRaw reads, mutates, writes", () => {
    writeCfg({ providers: [{ name: "x" }] })
    persistRaw((raw) => { raw.activeProvider = "x" })
    assert.equal(readCfg().activeProvider, "x")
    assert.equal(readCfg().providers[0].name, "x") // existing data preserved
  })
})

// ─── Providers resolution ─────────────────────────────────────

describe("resolveProviders", () => {
  it("resolves to an EMPTY list when config is missing (no synthetic preset entries)", () => {
    const { providers, activeProvider } = resolveProviders()
    assert.equal(providers.length, 0)
    assert.equal(activeProvider, undefined)
  })

  it("resolves to an empty list when providers[] is empty", () => {
    writeCfg({ providers: [] })
    const { providers, activeProvider } = resolveProviders()
    assert.equal(providers.length, 0)
    assert.equal(activeProvider, undefined)
  })

  it("normalizes baseURL trailing slashes and drops nameless entries", () => {
    writeCfg({ providers: [{ name: "a", baseURL: "https://x.test/v1///" }, { baseURL: "https://y.test" }] })
    const { providers } = resolveProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0].baseURL, "https://x.test/v1")
  })

  it("ignores THINCODER_ACTIVE_PROVIDER env (config.json is the only source)", () => {
    writeCfg({ providers: [{ name: "a" }, { name: "b" }], activeProvider: "a" })
    process.env.THINCODER_ACTIVE_PROVIDER = "b"
    try {
      assert.equal(resolveProviders().activeProvider, "a")
    } finally {
      delete process.env.THINCODER_ACTIVE_PROVIDER
    }
  })
})

describe("findProvider", () => {
  it("throws on unknown name with available list (typo protection, CLI parity)", () => {
    assert.throws(() => findProvider([{ name: "a" }], "b"), /not in providers list/)
  })
  it("returns first provider when name is empty", () => {
    assert.equal(findProvider([{ name: "a" }], "").name, "a")
    assert.equal(findProvider([], ""), undefined)
  })
})

// ─── Key / model resolution ───────────────────────────────────

describe("resolveKey — config-only (env vars are not a key source)", () => {
  it("provider.apiKey wins and is trimmed", () => {
    assert.equal(resolveKey({ apiKey: " pk " }), "pk")
  })
  it("returns null when the entry has no key — even with env vars set", () => {
    process.env.THINCODER_API_KEY = "env-key"
    process.env.DEEPSEEK_API_KEY = "ds-key"
    try {
      assert.equal(resolveKey({}), null)
      assert.equal(resolveKey({ name: "deepseek" }), null)
      assert.equal(resolveKey(undefined), null)
    } finally {
      delete process.env.THINCODER_API_KEY
      delete process.env.DEEPSEEK_API_KEY
    }
  })
})

describe("resolveModel — config-only (env vars are ignored)", () => {
  it("config activeModel overrides provider.model", () => {
    assert.equal(resolveModel({ model: "m0" }, "m1"), "m1")
  })
  it("falls back to provider.model and ignores THINCODER_MODEL / THINCODER_ACTIVE_MODEL", () => {
    process.env.THINCODER_MODEL = "env-model"
    process.env.THINCODER_ACTIVE_MODEL = "env-active"
    try {
      assert.equal(resolveModel({ model: "m0" }, null), "m0")
      assert.equal(resolveModel({ model: "m0" }, "m1"), "m1", "config activeModel still wins")
    } finally {
      delete process.env.THINCODER_ACTIVE_MODEL
      delete process.env.THINCODER_MODEL
    }
  })
})

// ─── providerFromConfig / key mutation ────────────────────────

describe("providerFromConfig", () => {
  it("returns null when no key resolvable", () => {
    writeCfg({ providers: [{ name: "a", baseURL: "https://x.test/v1", model: "m" }] })
    assert.equal(providerFromConfig("a"), null)
  })

  it("builds the runtime provider (key + model, config-only; THINCODER_BASE_URL ignored)", () => {
    writeCfg({ providers: [{ name: "a", baseURL: "https://x.test/v1/", model: "m0", apiKey: "k" }], activeProvider: "a" })
    const p = providerFromConfig("a")
    assert.equal(p.apiKey, "k")
    assert.equal(p.model, "m0")
    assert.equal(p.baseURL, "https://x.test/v1") // trailing slash normalized
    process.env.THINCODER_BASE_URL = "https://override.test/v1/"
    try {
      assert.equal(providerFromConfig("a").baseURL, "https://x.test/v1")
    } finally {
      delete process.env.THINCODER_BASE_URL
    }
  })

  it("throws on unknown provider name", () => {
    writeCfg({ providers: [{ name: "a", apiKey: "k" }] })
    assert.throws(() => providerFromConfig("zzz"), /not in providers list/)
  })

  it("setProviderKey / removeProviderKeyFromConfig mutate the entry", () => {
    writeCfg({ providers: [{ name: "a", baseURL: "https://x.test/v1", model: "m" }] })
    setProviderKey("a", "new-key")
    assert.equal(readCfg().providers[0].apiKey, "new-key")
    removeProviderKeyFromConfig("a")
    const entry = readCfg().providers[0]
    assert.equal("apiKey" in entry, false)
    assert.equal(entry.name, "a") // entry itself stays
  })

  it("providerNamesInConfig lists names", () => {
    writeCfg({ providers: [{ name: "a" }, { name: "b" }] })
    assert.deepEqual(providerNamesInConfig(), ["a", "b"])
  })
})

// ─── selectProviderModel (CLI selectModel semantics) ──────────

describe("selectProviderModel", () => {
  it("selecting provider default clears activeModel (omit from file)", () => {
    writeCfg({ providers: [{ name: "a", model: "m0", apiKey: "k" }], activeProvider: "b", activeModel: "old" })
    selectProviderModel("a", "m0")
    const cfg = readCfg()
    assert.equal(cfg.activeProvider, "a")
    assert.equal("activeModel" in cfg, false)
    assert.equal(cfg.providers[0].model, "m0")
  })

  it("selecting an override records activeModel", () => {
    writeCfg({ providers: [{ name: "a", model: "m0", apiKey: "k" }] })
    selectProviderModel("a", "m1")
    const cfg = readCfg()
    assert.equal(cfg.activeProvider, "a")
    assert.equal(cfg.activeModel, "m1")
  })

  it("unknown provider name is a no-op", () => {
    writeCfg({ providers: [{ name: "a", model: "m0" }] })
    selectProviderModel("zzz", "m1")
    const cfg = readCfg()
    assert.equal(cfg.providers[0].model, "m0")
    assert.equal("activeProvider" in cfg, false)
  })
})

// ─── Embedding config ─────────────────────────────────────────

describe("embedding config", () => {
  it("loadEmbeddingConfig returns null when absent", () => {
    assert.equal(loadEmbeddingConfig(), null)
  })

  it("saveEmbeddingConfig merges and drops empties", () => {
    saveEmbeddingConfig({ apiKey: "ek", baseURL: "https://e.test/v1", model: "em" })
    let emb = loadEmbeddingConfig()
    assert.equal(emb.apiKey, "ek")
    saveEmbeddingConfig({ apiKey: "" }) // delete key
    emb = loadEmbeddingConfig()
    assert.equal("apiKey" in emb, false)
    assert.equal(emb.baseURL, "https://e.test/v1") // other fields stay
  })
})

// ─── Legacy migration ─────────────────────────────────────────

function makeSecrets(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    get: async (k) => store.get(k) ?? undefined,
    delete: async (k) => { store.delete(k) },
    _store: store,
  }
}
function makeFlags(initial = false) {
  let flag = initial
  return {
    get: async () => flag,
    set: async () => { flag = true },
    _isSet: () => flag,
  }
}

describe("migrateCore", () => {
  it("does nothing when the flag is already set", async () => {
    writeCfg({ providers: [{ name: "a" }] })
    const flags = makeFlags(true)
    await migrateCore({ secrets: makeSecrets(), flags, legacySettings: { deepseek: "sk-x" }, clearLegacySettings: async () => {} })
    assert.equal(readCfg().providers.length, 1) // untouched
  })

  it("migrates a settings string key into the preset entry", async () => {
    const secrets = makeSecrets()
    const flags = makeFlags()
    await migrateCore({ secrets, flags, legacySettings: { deepseek: "sk-ds" }, clearLegacySettings: async () => {} })
    const cfg = readCfg()
    const ds = cfg.providers.find((p) => p.name === "deepseek")
    assert.equal(ds.apiKey, "sk-ds")
    assert.equal(ds.baseURL, PROVIDER_PRESETS.deepseek.baseURL) // created from preset
    assert(flags._isSet())
  })

  it("migrates an object entry { key, baseURL, model } for unknown names", async () => {
    await migrateCore({
      secrets: makeSecrets(),
      flags: makeFlags(),
      legacySettings: { custom: { key: "sk-c", baseURL: "https://c.test/v1", model: "cm" } },
      clearLegacySettings: async () => {},
    })
    const custom = readCfg().providers.find((p) => p.name === "custom")
    assert.equal(custom.apiKey, "sk-c")
    assert.equal(custom.baseURL, "https://c.test/v1")
    assert.equal(custom.model, "cm")
  })

  it("drops orphan keys that cannot be reconstructed", async () => {
    await migrateCore({
      secrets: makeSecrets(),
      flags: makeFlags(),
      legacySettings: { custom: { key: "sk-c" } }, // no baseURL/model, not a preset → drop
      clearLegacySettings: async () => {},
    })
    const cfg = readCfg()
    assert(!cfg.providers.some((p) => p.name === "custom"))
    assert.equal(cfg.providers.length, 0) // nothing recoverable → empty list (falls back to preset on read)
  })

  it("migrates SecretStorage keys and deletes them afterwards", async () => {
    const secrets = makeSecrets({ "thincoder.provider.kimi": "sk-kimi" })
    await migrateCore({ secrets, flags: makeFlags(), legacySettings: {}, clearLegacySettings: async () => {} })
    const kimi = readCfg().providers.find((p) => p.name === "kimi")
    assert.equal(kimi.apiKey, "sk-kimi")
    assert.equal(secrets._store.has("thincoder.provider.kimi"), false) // cleaned up
  })

  it("never overwrites an existing config.json apiKey", async () => {
    writeCfg({ providers: [{ name: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-v4-pro", apiKey: "cli-key" }] })
    await migrateCore({
      secrets: makeSecrets({ "thincoder.provider.deepseek": "secret-key" }),
      flags: makeFlags(),
      legacySettings: { deepseek: "settings-key" },
      clearLegacySettings: async () => {},
    })
    assert.equal(readCfg().providers[0].apiKey, "cli-key")
  })

  it("migrates the embedding key with defaults", async () => {
    const secrets = makeSecrets({ "thincoder.embedding.apiKey": "ek" })
    await migrateCore({ secrets, flags: makeFlags(), legacySettings: {}, clearLegacySettings: async () => {} })
    const emb = readCfg().embedding
    assert.equal(emb.apiKey, "ek")
    assert.equal(emb.baseURL, "https://api.siliconflow.cn/v1")
    assert.equal(secrets._store.has("thincoder.embedding.apiKey"), false)
  })

  it("clears the legacy settings key when migration completes", async () => {
    let cleared = false
    await migrateCore({
      secrets: makeSecrets(),
      flags: makeFlags(),
      legacySettings: { deepseek: "sk-x" },
      clearLegacySettings: async () => { cleared = true },
    })
    assert(cleared)
  })

  it("no longer migrates the removed thincoder.mcpServers setting (pre-release, dead code deleted)", async () => {
    let mcpCleared = false
    await migrateCore({
      secrets: makeSecrets(),
      flags: makeFlags(),
      legacySettings: {},
      clearLegacySettings: async () => {},
      legacyMcpServers: { fs: { command: "npx" } },  // ignored — the legacy input is gone
      clearLegacyMcp: async () => { mcpCleared = true },
    })
    const raw = readCfg()
    assert.ok(!raw.mcp?.servers || raw.mcp.servers.length === 0, "no MCP servers written from legacy settings")
    assert.equal(mcpCleared, false, "clearLegacyMcp is never called")
  })
})

// ─── MCP server CRUD (shared config.json) ────────────────────────

describe("MCP server CRUD", () => {
  it("addMcpServer stores stdio entry with env; loadMcpServers returns array", () => {
    assert.equal(addMcpServer("fs", { command: "npx", args: ["-y", "srv"], env: { A: "1" } }), null)
    const servers = loadMcpServers()
    assert.equal(servers.length, 1)
    assert.equal(servers[0].name, "fs")
    assert.deepEqual(servers[0].env, { A: "1" })
  })

  it("addMcpServer stores http/ws entries with headers", () => {
    addMcpServer("h", { url: "https://x.test/mcp", headers: { Authorization: "Bearer k" } })
    addMcpServer("w", { wsUrl: "wss://x.test/mcp" })
    const servers = loadMcpServers()
    assert.equal(servers.find((s) => s.name === "h").url, "https://x.test/mcp")
    assert.equal(servers.find((s) => s.name === "w").wsUrl, "wss://x.test/mcp")
  })

  it("addMcpServer rejects duplicates", () => {
    addMcpServer("dup", { command: "a" })
    assert.match(addMcpServer("dup", { command: "b" }), /already exists/)
  })

  it("removeMcpServer removes by name; rejects unknown", () => {
    addMcpServer("gone", { command: "x" })
    assert.equal(removeMcpServer("gone"), null)
    assert.equal(loadMcpServers().some((s) => s.name === "gone"), false)
    assert.match(removeMcpServer("gone"), /No MCP server/)
  })
})

// ─── Agent settings (batch C) ───────────────────────────────────

describe("agent settings", () => {
  it("loadAgentSettings defaults: maxTurns 100, verifyGuard off, compactThreshold auto", () => {
    const s = loadAgentSettings()
    assert.equal(s.maxTurns, 100)
    assert.equal(s.subagentTurns, 100)
    assert.equal(s.verifyGuard, false)
    assert.equal(s.compactThreshold, null)
  })

  it("saveAgentSettings persists and round-trips; empty deletes (auto)", () => {
    saveAgentSettings({ maxTurns: 50, verifyGuard: true, compactThreshold: 200000 })
    let s = loadAgentSettings()
    assert.equal(s.maxTurns, 50)
    assert.equal(s.verifyGuard, true)
    assert.equal(s.compactThreshold, 200000)
    // empty string -> auto (delete key)
    saveAgentSettings({ compactThreshold: "" })
    s = loadAgentSettings()
    assert.equal(s.compactThreshold, null)
    assert.equal(s.maxTurns, 50, "other fields untouched")
  })

  it("verifyGuard reads truthy === true (not just present)", () => {
    writeCfg({ agent: { verifyGuard: false } })
    assert.equal(loadAgentSettings().verifyGuard, false)
    writeCfg({ agent: { verifyGuard: true } })
    assert.equal(loadAgentSettings().verifyGuard, true)
  })

  it("loadAgentSettings: subagentModel/subagentModels round-trip (CLI parity)", () => {
    saveAgentSettings({ subagentModel: "deepseek:deepseek-v4-flash", subagentModels: { coder: "glm:glm-5.2", explore: "deepseek-v4-flash" } })
    const s = loadAgentSettings()
    assert.equal(s.subagentModel, "deepseek:deepseek-v4-flash")
    assert.deepEqual(s.subagentModels, { coder: "glm:glm-5.2", explore: "deepseek-v4-flash" })
    // per-type delete: removing the last key deletes the whole subagentModels key
    saveAgentSettings({ subagentModel: undefined, subagentModels: {} })
    const s2 = loadAgentSettings()
    assert.equal(s2.subagentModel, null)
    assert.deepEqual(s2.subagentModels, {}, "empty object = no type overrides")
    const raw = loadRaw()
    assert.ok(!("subagentModels" in (raw.agent ?? {})), "empty subagentModels object removed from config")
  })

  it("engineering flag round-trips through the panel patch path", () => {
    saveAgentSettingsFromPanel({ engineering: true })
    assert.equal(loadAgentSettings().engineering, true)
    saveAgentSettingsFromPanel({ engineering: false })
    assert.equal(loadAgentSettings().engineering, false)
  })

})
