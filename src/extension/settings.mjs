/**
 * settings.mjs — provider settings and key management
 * Extracted from extension.mjs ChatPanel class.
 */

import * as vscode from "vscode"
import { PRESETS, providerNames, isProviderConfigured, storeProviderKey, removeProviderKey, readProviders, buildProvider } from "./presets.mjs"
import { listModels } from "../provider.mjs"
import { specForModel } from "../specs.mjs"
import { loadModelPrefs } from "./session-io.mjs"

export function providerStatus() {
  const providers = readProviders()
  const status = {}
  const builtins = [...Object.keys(PRESETS), "custom"]
  for (const name of builtins) {
    const configured = isProviderConfigured(name)
    const entry = providers[name]
    const customInfo = (entry && typeof entry === "object")
      ? { baseURL: entry.baseURL, model: entry.model } : {}
    status[name] = { configured, masked: configured ? "****" : "", ...customInfo }
  }
  const custom = providers.custom
  const customCfg = (custom && typeof custom === "object") ? { baseURL: custom.baseURL || "", model: custom.model || "", hasKey: isProviderConfigured("custom") } : null
  return { providers: status, custom: customCfg }
}

export async function saveProviderKey(name, key) {
  if (!key || !key.trim()) return
  await storeProviderKey(name, key)
}

export async function saveCustomProvider({ key, baseURL, model }) {
  const c = vscode.workspace.getConfiguration("thincoder")
  const providers = { ...(c.get("providers") || {}) }
  // Save as long as key is provided (baseURL and model are optional)
  if (key) {
    await storeProviderKey("custom", key)
    providers.custom = { baseURL: (baseURL || "").trim(), model: (model || "").trim() }
  } else {
    // Only delete if ALL fields are empty (user explicitly cleared everything)
    if (!baseURL && !model) {
      await removeProviderKey("custom")
      delete providers.custom
    }
  }
  await c.update("providers", providers, vscode.ConfigurationTarget.Global)
}

export async function deleteProviderKey(name) {
  await removeProviderKey(name)
  // Also clean up any custom provider metadata
  if (name === "custom") {
    const c = vscode.workspace.getConfiguration("thincoder")
    const providers = { ...(c.get("providers") || {}) }
    delete providers.custom
    await c.update("providers", providers, vscode.ConfigurationTarget.Global)
  }
}

export function getMcpServers() {
  const c = vscode.workspace.getConfiguration("thincoder")
  return c.get("mcpServers", {}) || {}
}

export async function saveMcpServer(name, config) {
  const c = vscode.workspace.getConfiguration("thincoder")
  const servers = { ...(c.get("mcpServers") || {}) }
  servers[name] = config
  await c.update("mcpServers", servers, vscode.ConfigurationTarget.Global)
}

export async function deleteMcpServer(name) {
  const c = vscode.workspace.getConfiguration("thincoder")
  const servers = { ...(c.get("mcpServers") || {}) }
  delete servers[name]
  await c.update("mcpServers", servers, vscode.ConfigurationTarget.Global)
}

export function pushStatus(panel) {
  const s = providerStatus()
  const anyKey = Object.values(s.providers).some((p) => p.configured)
  panel?.webview.postMessage({ type: "providerStatus", keyOk: anyKey, status: s })
}

export async function fullStatus(panel, workspaceState, pushSessionsFn) {
  pushStatus(panel)
  const s = providerStatus()
  const anyKey = Object.values(s.providers).some((p) => p.configured)
  if (!anyKey) return

  const results = await Promise.allSettled(
    providerNames().filter((n) => s.providers[n]?.configured).map(async (name) => {
      const prov = await buildProvider(name)
      if (!prov) return { name, models: [] }
      try {
        const ids = await listModels(prov)
        const presetModel = PRESETS[name]?.model || prov.model
        const list = ids.length > 0 ? ids : [presetModel]
        return { name, models: list.map((id) => {
          const spec = specForModel(id)
          const r = spec.reasoningEffortEnum || (spec.thinking ? ["enabled"] : [])
          return { id, label: id, provider: name, group: PRESETS[name]?.label || "Custom", reasoning: r }
        })}
      } catch {
        const m = PRESETS[name]?.model || prov.model
        const spec = specForModel(m)
        const r = spec.reasoningEffortEnum || (spec.thinking ? ["enabled"] : [])
        return { name, models: [{ id: m, label: m, provider: name, group: PRESETS[name]?.label || "Custom", reasoning: r }] }
      }
    })
  )
  const allModels = results.flatMap((r) => r.status === "fulfilled" ? r.value.models : [])
  panel?.webview.postMessage({ type: "models", models: allModels, prefs: loadModelPrefs(workspaceState) })
  pushSessionsFn()
}
