/**
 * settings.mjs — provider settings and key management
 * Backed by the shared ~/.thincoder/config.json (see src/config-io.mjs).
 * MCP server config stays in VS Code settings (extension-local concern).
 */

import { PRESETS, providerNames, isProviderConfigured, storeProviderKey, removeProviderKey, buildProvider, providerLabel, readProviders } from "./presets.mjs"
import { persistRaw, resolveProviders, loadMcpServers, addMcpServer, removeMcpServer, loadAgentSettings, saveAgentSettings } from "../config-io.mjs"
import { addProviderEntry, removeProviderEntry, setActiveProviderEntry } from "./provider-flows.mjs"
import { mcpConnectedNames } from "../mcp.mjs"
import { listModels } from "../provider.mjs"
import { specForModel } from "../specs.mjs"
import { loadModelPrefs } from "./session-io.mjs"

/**
 * Status snapshot for the settings panel. Shape consumed by webview/settings.js:
 * { providers: { name: { configured, masked, baseURL, model, isActive } }, custom, labels,
 *   presets: [{ name, desc, model }] (not yet added), activeProvider }.
 * Providers are dynamic (config.json providers[]), so labels travel with the payload.
 */
export function providerStatus() {
  const providers = readProviders()
  let activeProvider = ""
  try { ({ activeProvider } = resolveProviders()) } catch { /* config unreadable */ }
  const status = {}
  const labels = {}
  for (const name of providerNames()) {
    const configured = isProviderConfigured(name)
    const entry = providers[name] || {}
    status[name] = {
      configured, masked: configured ? "****" : "",
      baseURL: entry.baseURL, model: entry.model,
      isActive: name === activeProvider,
    }
    labels[name] = providerLabel(name)
  }
  // Presets not yet added — the panel's [+ Add] form offers these (CLI addProviderFlow parity)
  const existing = new Set(providerNames())
  const presets = Object.entries(PRESETS)
    .filter(([name]) => !existing.has(name))
    .map(([name, p]) => ({ name, desc: p.desc, model: p.model, baseURL: p.baseURL }))
  const custom = providers.custom && typeof providers.custom === "object"
    ? { baseURL: providers.custom.baseURL || "", model: providers.custom.model || "", hasKey: isProviderConfigured("custom") }
    : null
  return { providers: status, custom, labels, presets, activeProvider }
}

// ─── Panel message handlers (pure persistence, error string or null) ───

export function handleAddProvider(payload) { return addProviderEntry(payload) }
export function handleRemoveProvider(name) { return removeProviderEntry(name) }
export function handleSetActiveProvider(name) { return setActiveProviderEntry(name) }

/** Agent/Advisor settings snapshot for the panel (from shared config.json). */
export function agentSettings() {
  const s = loadAgentSettings()
  return {
    maxTurns: s.maxTurns,
    subagentTurns: s.subagentTurns,
    compactThreshold: s.compactThreshold, // null = auto
    verifyGuard: s.verifyGuard,
    advisor: s.advisor ?? { enabled: false },
  }
}

/** Persist agent settings from the panel. payload: { maxTurns?, subagentTurns?, compactThreshold?, verifyGuard?, advisor? } */
export function saveAgentSettingsFromPanel(payload) {
  const patch = {}
  if (payload.maxTurns != null) patch.maxTurns = Number(payload.maxTurns) || undefined
  if (payload.subagentTurns != null) patch.subagentTurns = Number(payload.subagentTurns) || undefined
  if (payload.compactThreshold !== undefined) patch.compactThreshold = payload.compactThreshold === "" ? undefined : (Number(payload.compactThreshold) || undefined)
  if (payload.verifyGuard !== undefined) patch.verifyGuard = !!payload.verifyGuard
  if (payload.advisor !== undefined) {
    persistRaw((raw) => {
      raw.agent = raw.agent && typeof raw.agent === "object" ? raw.agent : {}
      raw.agent.advisor = {
        ...(raw.agent.advisor ?? {}),
        enabled: !!payload.advisor.enabled,
        guard: payload.advisor.guard !== undefined ? !!payload.advisor.guard : (raw.agent.advisor?.guard ?? true),
        ...(payload.advisor.provider ? { provider: payload.advisor.provider } : {}),
        ...(payload.advisor.model ? { model: payload.advisor.model } : {}),
      }
    })
    return
  }
  saveAgentSettings(patch)
}

export async function saveProviderKey(name, key) {
  if (!key || !key.trim()) return
  await storeProviderKey(name, key)
}

/** Save a custom provider entry (provider named "custom" in config.json). */
export async function saveCustomProvider({ key, baseURL, model }) {
  const url = (baseURL || "").trim().replace(/\/+$/, "")
  const mdl = (model || "").trim()
  persistRaw((raw) => {
    raw.providers = Array.isArray(raw.providers) ? raw.providers : []
    let entry = raw.providers.find((p) => p?.name === "custom")
    if (key) {
      if (!entry) { entry = { name: "custom" }; raw.providers.push(entry) }
      entry.apiKey = key.trim()
      if (url) entry.baseURL = url
      if (mdl) entry.model = mdl
    } else if (!url && !mdl && entry) {
      // All fields empty → user cleared everything: drop the entry
      raw.providers = raw.providers.filter((p) => p?.name !== "custom")
    }
  })
}

export async function deleteProviderKey(name) {
  await removeProviderKey(name)
  // A bare "custom" entry with no baseURL/model is useless — drop it entirely
  if (name === "custom") {
    persistRaw((raw) => {
      const entry = Array.isArray(raw.providers) ? raw.providers.find((p) => p?.name === "custom") : null
      if (entry && !entry.baseURL && !entry.model && !entry.apiKey) {
        raw.providers = raw.providers.filter((p) => p?.name !== "custom")
      }
    })
  }
}

export function getMcpServers() {
  return loadMcpServers()
}

/** Add/update an MCP server in the shared config.json. Returns error string or null (duplicate rejection). */
export function saveMcpServer(name, config) {
  return addMcpServer(name, config)
}

export function deleteMcpServer(name) {
  return removeMcpServer(name)
}

/** Connected-server names for status display (●/○ + tool counts). */
export function connectedMcpServers() {
  return mcpConnectedNames()
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
          return { id, label: id, provider: name, group: providerLabel(name), reasoning: r }
        })}
      } catch {
        const m = PRESETS[name]?.model || prov.model
        const spec = specForModel(m)
        const r = spec.reasoningEffortEnum || (spec.thinking ? ["enabled"] : [])
        return { name, models: [{ id: m, label: m, provider: name, group: providerLabel(name), reasoning: r }] }
      }
    })
  )
  const allModels = results.flatMap((r) => r.status === "fulfilled" ? r.value.models : [])
  panel?.webview.postMessage({ type: "models", models: allModels, prefs: loadModelPrefs(workspaceState) })
  pushSessionsFn?.()
}
