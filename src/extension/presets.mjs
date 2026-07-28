/**
 * presets.mjs — provider presets and provider-builder for the extension
 * Extracted from extension.mjs.
 */

import * as vscode from "vscode"
import { specForModel } from "../specs.mjs"

export const PRESETS = {
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-pro", label: "DeepSeek", thinking: { type: "enabled" }, defaultEffort: "max", maxTokens: 393216 },
  kimi:     { baseURL: "https://api.moonshot.cn/v1", model: "kimi-k3", label: "Kimi (Moonshot)", defaultEffort: "max", maxTokens: 131072 },
  glm:      { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", label: "GLM (Zhipu)", thinking: { type: "enabled" }, defaultEffort: "max", maxTokens: 128000 },
  qwen:     { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max", label: "Qwen (Alibaba)", maxTokens: 131072 },
  minimax:  { baseURL: "https://api.minimax.chat/v1", model: "MiniMax-M3", label: "MiniMax", chatPath: "/text/chatcompletion_v2", maxTokens: 128000 },
  openai:   { baseURL: "https://api.openai.com/v1", model: "gpt-4o", label: "OpenAI" },
  claude:   { baseURL: "https://api.anthropic.com/v1", model: "claude-sonnet-4", label: "Claude (Anthropic)", format: "anthropic", maxTokens: 8192 },
  gemini:   { baseURL: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", label: "Gemini (Google)", format: "google", maxTokens: 8192 },
}

const KEY_PREFIX = "thincoder.provider."

/** SecretStorage reference — set once by extension.mjs on activation */
let _secrets = null
/** In-memory cache: which providers have keys in SecretStorage */
const _keyCache = new Set()

/**
 * Initialize the provider key store with VS Code SecretStorage.
 * Call once during extension activation.
 */
export function initProviderKeyStore(secrets) { _secrets = secrets }

/** Check if a provider has a configured key (fast, synchronous) */
export function isProviderConfigured(name) { return _keyCache.has(name) }

/** Store an API key in SecretStorage */
export async function storeProviderKey(name, key) {
  if (!key || !key.trim() || !_secrets) return
  await _secrets.store(`${KEY_PREFIX}${name}`, key.trim())
  _keyCache.add(name)
}

/** Delete an API key from SecretStorage */
export async function removeProviderKey(name) {
  if (!_secrets) return
  try { await _secrets.delete(`${KEY_PREFIX}${name}`) } catch {}
  _keyCache.delete(name)
}

/** Pre-load key cache from SecretStorage + legacy settings.json (auto-migrate on first load) */
export async function loadProviderKeyCache() {
  if (!_secrets) return
  const providers = readProviders()
  for (const name of [...Object.keys(PRESETS), "custom"]) {
    // Check SecretStorage first
    try {
      const key = await _secrets.get(`${KEY_PREFIX}${name}`)
      if (key) { _keyCache.add(name); continue }
    } catch {}
    // Legacy: check settings.json and migrate
    const entry = providers[name]
    if (!entry) continue
    const key = typeof entry === "string" ? entry : entry.key
    if (key) {
      try { await _secrets.store(`${KEY_PREFIX}${name}`, key) } catch { continue }
      _keyCache.add(name)
      // Clean settings.json
      try {
        const c = vscode.workspace.getConfiguration("thincoder")
        const p = { ...(c.get("providers") || {}) }
        if (typeof p[name] === "string") delete p[name]
        else if (p[name]) { const { key: _, ...rest } = p[name]; p[name] = Object.keys(rest).length ? rest : undefined }
        await c.update("providers", p, vscode.ConfigurationTarget.Global)
      } catch {}
    }
  }
}

export function providerNames() { return [...Object.keys(PRESETS), "custom"] }

/** Read non-sensitive provider config from settings.json (baseURL, model) */
export function readProviders() {
  return vscode.workspace.getConfiguration("thincoder").get("providers") || {}
}

/**
 * Get API key for a provider.
 * Priority: SecretStorage → settings.json (with auto-migration)
 */
export async function getKey(name) {
  // Try SecretStorage first
  if (_secrets) {
    try {
      const key = await _secrets.get(`${KEY_PREFIX}${name}`)
      if (key) return key
    } catch { /* fall through to settings.json */ }
  }
  // Fall back to settings.json (legacy)
  const providers = readProviders()
  const entry = providers[name]
  if (!entry) return null
  const key = typeof entry === "string" ? entry : entry.key || null
  // Auto-migrate to SecretStorage
  if (key && _secrets) {
    try { await _secrets.store(`${KEY_PREFIX}${name}`, key) } catch {}
    // Remove key from settings.json to complete migration
    try {
      const c = vscode.workspace.getConfiguration("thincoder")
      const p = { ...(c.get("providers") || {}) }
      if (typeof p[name] === "string") delete p[name]
      else if (p[name]) { const { key: _, ...rest } = p[name]; p[name] = Object.keys(rest).length ? rest : undefined }
      await c.update("providers", p, vscode.ConfigurationTarget.Global)
    } catch {}
  }
  return key
}

export async function buildProvider(name) {
  const providers = readProviders()
  const apiKey = await getKey(name)
  if (!apiKey) return null

  if (name === "custom") {
    const entry = providers.custom
    if (typeof entry !== "object" || !entry.baseURL || !entry.model) return null
    return { baseURL: entry.baseURL, apiKey, model: entry.model, maxTokens: entry.maxTokens || 131072, ...(entry.responseFormat ? { responseFormat: entry.responseFormat } : {}) }
  }

  const preset = PRESETS[name]
  if (!preset) return null
  const spec = specForModel(preset.model)
  return {
    baseURL: preset.baseURL, apiKey, model: preset.model,
    maxTokens: preset.maxTokens ?? (spec.maxOutput || 131072),
    ...(preset.thinking ? { thinking: preset.thinking } : {}),
    ...(preset.defaultEffort ? { reasoningEffort: preset.defaultEffort } : {}),
    ...(preset.chatPath ? { chatPath: preset.chatPath } : {}),
    ...(preset.format ? { format: preset.format } : {}),
  }
}
