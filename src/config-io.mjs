/**
 * config-io.mjs — shared config file I/O (VS Code side)
 * Same file, same structure, same semantics as the CLI (`thincoder/src/config.mjs`):
 * providers[] + activeProvider (+ optional activeModel runtime override), apiKey per
 * provider with env-var fallback. Preset table mirrors CLI PROVIDER_PRESETS verbatim.
 *
 * Pure Node — no `vscode` import — so unit tests can run outside the extension host.
 * The VS Code-specific one-time migration (settings + SecretStorage → config.json)
 * lives in extension/migrate-settings.mjs.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const configDir = join(homedir(), ".thincoder")
export const configPath = join(configDir, "config.json")

/** Test seam: override the config file location (used by unit tests to sandbox I/O). */
let _pathOverride = null
export function _setConfigPathForTest(p) { _pathOverride = p }
export function _configPath() { return _pathOverride ?? configPath }

// ─── Presets (mirror CLI PROVIDER_PRESETS — CLI is the authority; keep in sync) ───
export const PROVIDER_PRESETS = {
  deepseek: { baseURL: "https://api.deepseek.com", model: "deepseek-v4-pro", thinking: { type: "enabled" }, reasoningEffort: "max", maxTokens: 393216, desc: "DeepSeek" },
  kimi:     { baseURL: "https://api.moonshot.cn/v1", model: "kimi-k3", thinking: null, reasoningEffort: "max", maxTokens: 131072, desc: "Kimi / Moonshot" },
  "kimi-code": { baseURL: "https://api.kimi.com/coding/v1", model: "k3", thinking: null, reasoningEffort: "max", maxTokens: 131072, desc: "Kimi For Coding (platform.kimi.com — sk-kimi- keys; NOT interchangeable with Moonshot)" },
  glm:      { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", thinking: { type: "enabled" }, reasoningEffort: "max", maxTokens: 128000, desc: "Zhipu GLM" },
  "glm-code": { baseURL: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-5.2", thinking: { type: "enabled" }, reasoningEffort: "max", maxTokens: 128000, desc: "Zhipu GLM Coding Plan (coding endpoint — same key as GLM; server-forced thinking)" },
  qwen:     { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max", reasoningEffort: "high", maxTokens: 131072, desc: "Qwen / Alibaba" },
  qwenplan: { baseURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max", reasoningEffort: "high", maxTokens: 131072, desc: "Qwen Token Plan (百炼套餐)" },
  minimax:  { baseURL: "https://api.minimaxi.com/v1", model: "MiniMax-M3", thinking: { type: "adaptive" }, maxTokens: 128000, chatPath: "/text/chatcompletion_v2", desc: "MiniMax" },
  openai:   { baseURL: "https://api.openai.com/v1", model: "gpt-4o", desc: "OpenAI" },
  claude:   { baseURL: "https://api.anthropic.com/v1", model: "claude-sonnet-4", format: "anthropic", maxTokens: 8192, desc: "Claude (Anthropic)" },
  gemini:   { baseURL: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", format: "google", maxTokens: 8192, desc: "Gemini (Google)" },
  grok:     { baseURL: "https://api.x.ai/v1", model: "grok-4.5", maxTokens: 65536, desc: "Grok (xAI)" },
  mistral:  { baseURL: "https://api.mistral.ai/v1", model: "mistral-large", maxTokens: 32768, desc: "Mistral" },
  volcengine: { baseURL: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-pro-32k", maxTokens: 32768, desc: "Volcengine Ark (豆包)" },
  hunyuan:  { baseURL: "https://api.hunyuan.cloud.tencent.com/v1", model: "hunyuan-pro", maxTokens: 32768, desc: "Hunyuan (腾讯混元)" },
  siliconflow: { baseURL: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3", maxTokens: 32768, desc: "SiliconFlow (硅基流动)" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4", maxTokens: 32768, desc: "OpenRouter" },
  groq:     { baseURL: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", maxTokens: 32768, desc: "Groq" },
}

/** Build the stored provider entry from a preset — CLI addProviderFlow: strip the display field, keep the rest. */
export function presetToEntry(name) {
  const preset = PROVIDER_PRESETS[name]
  if (!preset) return null
  const { desc: _, ...entry } = preset
  return { name, ...entry }
}

// ─── Raw read / write (CLI persistRaw / saveConfig semantics) ───

/** Read the raw config object ({} when missing). Throws on invalid JSON — same as CLI loadConfig. */
export function loadRaw() {
  const path = _configPath()
  if (!existsSync(path)) return {}
  let raw
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`Config file is not valid JSON, check or delete it: ${path}\n  ${error.message}`, { cause: error })
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return raw
}

/** Write the raw config object. Injects $schema, 0600 perms, trailing newline — same as CLI saveConfig. */
export function saveRaw(raw) {
  const path = _configPath()
  mkdirSync(dirname(path), { recursive: true })
  raw.$schema = "https://thincoder.dev/schemas/config.json"
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* best-effort on Windows */ }
}

/** Read → mutate → write (mirrors CLI tui persistRaw). */
export function persistRaw(mutate) {
  const raw = loadRaw()
  mutate(raw)
  saveRaw(raw)
}

// ─── Providers resolution (CLI loadConfig subset) ───

/**
 * Find provider by name. Throws when the name is set but missing — a typo in activeProvider
 * silently falling to the first provider would use the wrong key on the wrong endpoint (CLI parity).
 */
export function findProvider(providers, name) {
  if (name) {
    const found = providers.find((p) => p.name === name)
    if (found) return found
    const available = providers.map((p) => p.name).join(", ") || "(empty)"
    throw new Error(`activeProvider "${name}" not in providers list (available: ${available}); check ${configPath}`)
  }
  return providers[0]
}

/** Normalize proxy config to { uri, web, model } or undefined — same as CLI normalizeProxy. */
export function normalizeProxy(proxy) {
  if (typeof proxy === "string") return proxy ? { uri: proxy, web: true, model: false } : undefined
  if (!proxy || typeof proxy !== "object" || Array.isArray(proxy)) return undefined
  const uri = proxy.uri || proxy.url || ""
  if (typeof uri !== "string" || !uri) return undefined
  return { uri, web: proxy.web !== false, model: proxy.model === true }
}

/**
 * Resolve providers list + active name from disk. Empty/missing providers fall back to the
 * deepseek preset entry (CLI DEFAULTS); baseURL trailing slashes normalized. Env overrides:
 * THINCODER_ACTIVE_PROVIDER (active pointer) — resolved here so every read path sees them.
 * Returns { providers, activeProvider }.
 */
export function resolveProviders() {
  const raw = loadRaw()
  const providers = Array.isArray(raw.providers) && raw.providers.length
    ? raw.providers.filter((p) => p && typeof p === "object" && p.name)
    : [presetToEntry("deepseek")]
  for (const p of providers) {
    if (typeof p.baseURL === "string") p.baseURL = p.baseURL.replace(/\/+$/, "")
  }
  const activeProvider = process.env.THINCODER_ACTIVE_PROVIDER || raw.activeProvider || providers[0]?.name
  return { providers, activeProvider }
}

/**
 * API key for a provider entry (CLI loadConfig fallback order):
 * provider.apiKey → THINCODER_API_KEY → provider-specific env var (deepseek/openai only).
 */
export function resolveKey(entry, activeName) {
  if (entry?.apiKey?.trim()) return entry.apiKey.trim()
  if (process.env.THINCODER_API_KEY) return process.env.THINCODER_API_KEY
  const envMap = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }
  const keyVar = envMap[activeName ?? entry?.name]
  if (keyVar && process.env[keyVar]) return process.env[keyVar]
  return null
}

/**
 * Runtime model — CLI loadConfig: activeModel = THINCODER_ACTIVE_MODEL || config.activeModel,
 * applied AFTER THINCODER_MODEL overrides provider.model. Effective priority:
 * THINCODER_ACTIVE_MODEL > config activeModel > THINCODER_MODEL > provider.model.
 */
export function resolveModel(entry, rawActiveModel) {
  const activeModel = process.env.THINCODER_ACTIVE_MODEL || rawActiveModel
  return activeModel || process.env.THINCODER_MODEL || entry.model
}

/**
 * Build the runtime provider object for LLM calls from config.json.
 * null when the provider has no resolvable API key. Throws on unknown name (findProvider parity).
 */
export function providerFromConfig(name) {
  const { providers, activeProvider } = resolveProviders()
  const target = name ? findProvider(providers, name) : findProvider(providers, activeProvider)
  if (!target) return null
  const apiKey = resolveKey(target, target.name)
  if (!apiKey) return null
  const raw = loadRaw()
  const provider = {
    ...target,
    apiKey,
    model: resolveModel(target, raw.activeModel),
  }
  // Env overrides for the resolved provider (CLI loadConfig runtime overrides)
  if (process.env.THINCODER_BASE_URL) provider.baseURL = process.env.THINCODER_BASE_URL.replace(/\/+$/, "")
  if (provider.baseURL) provider.baseURL = provider.baseURL.replace(/\/+$/, "")

  // Proxy: per-provider `proxy: true` AND global config.proxy.model === true (CLI injectProxy parity).
  // Default model requests go direct — proxy.model is opt-in.
  const proxyCfg = normalizeProxy(raw.proxy)
  if (target.proxy === true && proxyCfg?.uri && proxyCfg.model === true) {
    provider.proxyUri = proxyCfg.uri
  }
  return provider
}

/** Set a provider's key in config.json (CLI setProviderKey semantics — whole providers[] rewritten). */
export function setProviderKey(name, key) {
  persistRaw((raw) => {
    raw.providers = Array.isArray(raw.providers) ? raw.providers : []
    const entry = raw.providers.find((p) => p?.name === name)
    if (entry) entry.apiKey = key
  })
}

/** Remove a provider's key (keep the provider entry). */
export function removeProviderKeyFromConfig(name) {
  persistRaw((raw) => {
    const entry = Array.isArray(raw.providers) ? raw.providers.find((p) => p?.name === name) : null
    if (entry) delete entry.apiKey
  })
}

/**
 * Persist a model selection (CLI selectModel semantics): provider.model becomes the selected
 * model; activeModel records the override only when it differs from the provider default
 * (null → omit, so the CLI resume sees the same pointer).
 */
export function selectProviderModel(name, model) {
  persistRaw((raw) => {
    raw.providers = Array.isArray(raw.providers) ? raw.providers : []
    const entry = raw.providers.find((p) => p?.name === name)
    if (!entry) return
    // CLI selectModel: activeModel records the override only when it differs from the
    // provider default. Compare BEFORE overwriting entry.model.
    raw.activeModel = model !== entry.model ? model : null
    if (raw.activeModel == null) delete raw.activeModel
    entry.model = model
    raw.activeProvider = name
  })
}

/** List provider names present in config.json ([] when none). */
export function providerNamesInConfig() {
  try {
    return resolveProviders().providers.map((p) => p.name)
  } catch {
    return []
  }
}

/** Agent runtime settings from config.json (CLI agent.* defaults: maxTurns 100, subagentTurns 100). */
export function loadAgentSettings() {
  const a = loadRaw().agent
  return {
    maxTurns: a?.maxTurns ?? 100,
    subagentTurns: a?.subagentTurns ?? 100,
    subagentModel: a?.subagentModel ?? null, // default subagent model override (CLI parity)
    subagentModels: a?.subagentModels ?? {}, // per-type overrides: explore/plan/coder/eng-coder (CLI parity)
    compactThreshold: a?.compactThreshold ?? null, // null = auto (from model context)
    verifyGuard: a?.verifyGuard ?? false,
      engineering: a?.engineering ?? false, // engineering mode flag (VS Code: config-level; the eng tool persists here)
    advisor: a?.advisor ?? { enabled: false },
    consultModels: Array.isArray(a?.consultModels) ? a.consultModels : [],
  }
}

/** Persist agent.* settings (merge; undefined/empty deletes the key — compactThreshold '' = auto).
 *  Empty subagentModels object deletes the whole key (no leftover "subagentModels": {} in config). */
export function saveAgentSettings(patch) {
  persistRaw((raw) => {
    raw.agent = raw.agent && typeof raw.agent === "object" ? raw.agent : {}
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (v === undefined || v === null || v === "") delete raw.agent[k]
      else if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) delete raw.agent[k]
      else raw.agent[k] = v
    }
  })
}

/** Panel persistence: build the agent.* patch from a webview payload (CLI-parity field names).
 *  Single write channel — all fields (incl. advisor) go through one saveAgentSettings(patch);
 *  an early return for advisor would silently discard non-advisor fields (reported bug).
 *  Pure function of payload + current config; lives here (no vscode dependency) so it is testable. */
export function saveAgentSettingsFromPanel(payload) {
  const patch = {}
  if (payload.maxTurns != null) patch.maxTurns = Number(payload.maxTurns) || undefined
  if (payload.subagentTurns != null) patch.subagentTurns = Number(payload.subagentTurns) || undefined
  // "in payload" guards let explicit undefined (cleared field) flow through as deletion
  if ("subagentModel" in payload) patch.subagentModel = payload.subagentModel || undefined
  if ("subagentModels" in payload) {
    // Per-type overrides: only non-empty values kept; empty object deletes the whole key
    const m = {}
    for (const [role, v] of Object.entries(payload.subagentModels ?? {})) {
      if (v && typeof v === "string" && v.trim()) m[role] = v.trim()
    }
    patch.subagentModels = Object.keys(m).length > 0 ? m : undefined
  }
  if (payload.compactThreshold !== undefined) patch.compactThreshold = payload.compactThreshold === "" ? undefined : (Number(payload.compactThreshold) || undefined)
  if (payload.verifyGuard !== undefined) patch.verifyGuard = !!payload.verifyGuard
    if (payload.engineering !== undefined) patch.engineering = !!payload.engineering
  // Consultation models (CONSULTATION.md): array of {provider, model}, ≤5, validated.
  if (payload.consultModels !== undefined) {
    const arr = Array.isArray(payload.consultModels) ? payload.consultModels : []
    const clean = arr
      .filter((m) => m && typeof m.provider === "string" && m.provider.trim() && typeof m.model === "string" && m.model.trim())
      .slice(0, 5)
      .map((m) => ({
        provider: m.provider.trim(),
        model: m.model.trim(),
        ...(typeof m.effort === "string" && m.effort.trim() ? { effort: m.effort.trim() } : { effort: null }),
      }))
    patch.consultModels = clean.length > 0 ? clean : undefined
  }
  if (payload.advisor !== undefined) {
    // Merge with existing advisor values; "in" guards allow clearing provider/model
    const adv = payload.advisor ?? {}
    const current = loadAgentSettings().advisor ?? {}
    patch.advisor = {
      enabled: !!adv.enabled,
      guard: adv.guard !== undefined ? !!adv.guard : (current.guard ?? true),
      ...(typeof adv.effort === "string" && adv.effort.trim() ? { effort: adv.effort.trim() } : {}),
      ...("provider" in adv ? (adv.provider ? { provider: adv.provider } : undefined) : {}),
      ...("model" in adv ? (adv.model ? { model: adv.model } : undefined) : {}),
    }
  }
  saveAgentSettings(patch)
}

// ─── Shell candidates (platform-aware, cached once per session — CLI /shell parity) ───

let _shellCandidatesCache = null

/** Detect available shells for this platform. Cached: shell availability does not
 *  change during a session, and spawnSync on every panel open would freeze the UI. */
export function shellCandidates() {
  if (_shellCandidatesCache !== null) return _shellCandidatesCache
  const win = process.platform === "win32"
  const commandExists = (cmd) => {
    try {
      // 'command -v' is a POSIX shell builtin; sh -c runs it (Windows uses `where`)
      const r = spawnSync(win ? "where" : "sh", win ? [cmd] : ["-c", `command -v ${cmd}`], { encoding: "utf8", timeout: 3000 })
      return r.status === 0 && r.stdout.trim().length > 0
    } catch { return false }
  }
  const GIT_BASH_PATHS = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Git\\bin\\bash.exe`,
  ]
  const candidates = []
  // System default always first
  candidates.push({ name: "System default", value: null, detect: () => true })
  if (win) {
    candidates.push({ name: "PowerShell (pwsh)", value: "pwsh", detect: () => commandExists("pwsh") })
    candidates.push({ name: "Windows PowerShell (powershell)", value: "powershell", detect: () => commandExists("powershell") })
    const gb = GIT_BASH_PATHS.find((p) => existsSync(p))
    if (gb) candidates.push({ name: `Git Bash (${gb})`, value: gb, detect: () => true })
    candidates.push({ name: "WSL bash (wsl)", value: "wsl", detect: () => commandExists("wsl") })
  } else {
    for (const sh of ["bash", "zsh", "fish"]) {
      candidates.push({ name: sh, value: sh, detect: () => commandExists(sh) })
    }
  }
  _shellCandidatesCache = candidates.filter((c) => c.detect())
  return _shellCandidatesCache
}

/** Persist shell setting from the panel. value: string path/command, '' or null = system default. */
export function saveShellSettingsFromPanel(value) {
  const v = typeof value === "string" ? value.trim() : ""
  persistRaw((raw) => {
    if (!v) delete raw.shell
    else raw.shell = v
  })
}

// ─── MCP servers (shared config.json mcp.servers[] — CLI parity) ───

/** Load MCP server configs: array of { name, command?, args?, env?, url?, wsUrl?, headers? }. */
export function loadMcpServers() {
  const raw = loadRaw()
  const servers = raw.mcp?.servers
  return Array.isArray(servers) ? servers.filter((s) => s && typeof s === "object" && s.name) : []
}

/** Add an MCP server entry. Rejects duplicates (CLI /mcp parity). Returns error string or null. */
export function addMcpServer(name, config) {
  const servers = loadMcpServers()
  if (servers.some((s) => s.name === name)) return `MCP server "${name}" already exists`
  const entry = { name }
  if (config.url) { entry.url = config.url; if (config.headers) entry.headers = config.headers }
  else if (config.wsUrl) { entry.wsUrl = config.wsUrl; if (config.headers) entry.headers = config.headers }
  else { entry.command = config.command; if (config.args) entry.args = config.args; if (config.env) entry.env = config.env }
  persistRaw((raw) => {
    raw.mcp = raw.mcp && typeof raw.mcp === "object" ? raw.mcp : {}
    raw.mcp.servers = Array.isArray(raw.mcp.servers) ? raw.mcp.servers : []
    raw.mcp.servers.push(entry)
  })
  return null
}

/** Remove an MCP server entry by name. Returns error string or null. */
export function removeMcpServer(name) {
  const servers = loadMcpServers()
  if (!servers.some((s) => s.name === name)) return `No MCP server named "${name}"`
  persistRaw((raw) => {
    raw.mcp = raw.mcp && typeof raw.mcp === "object" ? raw.mcp : {}
    raw.mcp.servers = (raw.mcp.servers ?? []).filter((s) => s?.name !== name)
  })
  return null
}

/** Embedding config from config.json (CLI: config.embedding { baseURL, model, apiKey }). */
export function loadEmbeddingConfig() {
  const emb = loadRaw().embedding
  return emb && typeof emb === "object" ? emb : null
}

/** Persist embedding fields into config.json (merge, drop empties). */
export function saveEmbeddingConfig(patch) {
  persistRaw((raw) => {
    const emb = raw.embedding && typeof raw.embedding === "object" ? raw.embedding : {}
    for (const [k, v] of Object.entries(patch || {})) {
      if (v == null || v === "") delete emb[k]
      else emb[k] = v
    }
    if (Object.keys(emb).length) raw.embedding = emb
    else delete raw.embedding
  })
}

// ─── Legacy migration core (pure — VS Code glue lives in extension/migrate-settings.mjs) ───

const EMBEDDING_DEFAULTS = { baseURL: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3" }

/**
 * One-time migration of legacy VS Code key stores into config.json. Pure function:
 *   deps.secrets       — { get(key), delete(key) } (async, may throw)
 *   deps.flags         — { get(): Promise<boolean>, set(): Promise<void> } (one-shot guard)
 *   deps.legacySettings — the old `thincoder.providers` settings value (object or undefined)
 *   deps.clearLegacySettings — async fn that deletes the legacy settings key
 *
 * Never overwrites an apiKey already present in config.json (the CLI may have written it first).
 * Builtin preset names missing from providers[] are created from PROVIDER_PRESETS; unknown
 * names are only created when baseURL/model metadata is recoverable.
 */
export async function migrateCore(deps) {
  const { secrets, flags, legacySettings, clearLegacySettings } = deps
  if (await flags.get()) return

  const raw = loadRaw()
  const providers = Array.isArray(raw.providers) ? raw.providers : []
  raw.providers = providers
  const byName = new Map(providers.filter((p) => p && typeof p === "object" && p.name).map((p) => [p.name, p]))

  const legacyMeta = {}
  for (const [name, entry] of Object.entries(legacySettings || {})) {
    if (entry && typeof entry === "object") legacyMeta[name] = entry
  }

  function applyKey(name, key) {
    if (!key) return
    let entry = byName.get(name)
    if (!entry) {
      if (PROVIDER_PRESETS[name]) {
        entry = presetToEntry(name)
      } else {
        const meta = legacyMeta[name]
        if (!meta?.baseURL || !meta?.model) return // orphan key, no way to reconstruct
        entry = { name, baseURL: meta.baseURL, model: meta.model }
      }
      entry.apiKey = key
      providers.push(entry)
      byName.set(name, entry)
      return
    }
    if (!entry.apiKey) entry.apiKey = key // never clobber an existing key
  }

  // SecretStorage keys first, then settings.json keys (both are legacy; config.json wins)
  const legacyNames = [...Object.keys(PROVIDER_PRESETS), "custom"]
  for (const name of legacyNames) {
    try { applyKey(name, await secrets.get(`thincoder.provider.${name}`)) } catch { /* ignore */ }
  }
  for (const [name, entry] of Object.entries(legacySettings || {})) {
    applyKey(name, typeof entry === "string" ? entry : entry?.key)
  }

  // Embedding key (legacy SecretStorage → config.embedding)
  try {
    const embKey = await secrets.get("thincoder.embedding.apiKey")
    if (embKey) {
      const emb = raw.embedding && typeof raw.embedding === "object" ? raw.embedding : {}
      if (!emb.apiKey) emb.apiKey = embKey
      if (!emb.baseURL) emb.baseURL = EMBEDDING_DEFAULTS.baseURL
      if (!emb.model) emb.model = EMBEDDING_DEFAULTS.model
      raw.embedding = emb
    }
  } catch { /* ignore */ }

  // Legacy MCP servers were removed together with the `thincoder.mcpServers`
  // setting itself (pre-release, no migration — see package.json history).

  saveRaw(raw)

  // Clean up legacy stores so nothing reads them again
  for (const name of legacyNames) {
    try { await secrets.delete(`thincoder.provider.${name}`) } catch { /* ignore */ }
  }
  try { await secrets.delete("thincoder.embedding.apiKey") } catch { /* ignore */ }
  try { await clearLegacySettings() } catch { /* ignore */ }
  await flags.set()
}
