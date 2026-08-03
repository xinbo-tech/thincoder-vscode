/**
 * provider-flows.mjs — provider add/remove/key flows (CLI addProviderFlow / removeProviderFlow / setKeyFlow)
 * Webview has no TUI picker, so the extension host's QuickPick/InputBox stand in for
 * showPicker/askQuestion; persistence semantics are identical to the CLI (config.json providers[]).
 */

import * as vscode from "vscode"
import { PROVIDER_PRESETS, presetToEntry, resolveProviders, persistRaw, setProviderKey } from "../config-io.mjs"

/** Add a provider: pick an unused preset (auto-filled from PROVIDER_PRESETS) or configure custom manually. */
export async function addProviderFlow(refresh) {
  let providers
  try {
    ({ providers } = resolveProviders())
  } catch (e) {
    vscode.window.showErrorMessage(e.message)
    return
  }
  const existing = new Set(providers.map((p) => p.name))

  const items = Object.entries(PROVIDER_PRESETS)
    .filter(([name]) => !existing.has(name))
    .map(([name, p]) => ({ label: name, description: p.desc, detail: p.model, kind: "preset", name }))
  items.push({ label: "Custom (manual config)", description: "enter baseURL/model/format", kind: "custom" })

  const sel = await vscode.window.showQuickPick(items, {
    placeHolder: "Add provider — select a preset",
    matchOnDescription: true, matchOnDetail: true,
  })
  if (!sel) return

  if (sel.kind === "custom") {
    const name = (await vscode.window.showInputBox({
      prompt: "Provider name",
      validateInput: (v) => {
        const n = (v || "").trim()
        if (!n) return "Name is required"
        if (existing.has(n) || PROVIDER_PRESETS[n]) return "Name already in use"
        return null
      },
    }))?.trim()
    if (!name) return
    const baseURL = (await vscode.window.showInputBox({
      prompt: `Base URL for ${name}`,
      placeHolder: "https://api.example.com/v1",
    }))?.trim().replace(/\/+$/, "")
    if (!baseURL) return
    const model = (await vscode.window.showInputBox({ prompt: `Model name for ${name}` }))?.trim()
    if (!model) return
    const format = await vscode.window.showQuickPick(
      [
        { label: "openai", description: "(default)" },
        { label: "anthropic", description: "Messages API" },
        { label: "google", description: "streamGenerateContent" },
      ],
      { placeHolder: "API format" },
    )
    if (!format) return
    const entry = { name, baseURL, model }
    if (format.label !== "openai") entry.format = format.label
    persistRaw((raw) => { (raw.providers ??= []).push(entry) })
    const key = await vscode.window.showInputBox({ prompt: `API key for ${name} (leave empty to skip)`, password: true })
    if (key?.trim()) setProviderKey(name, key.trim())
    await refresh?.()
    return
  }

  // Preset: create the entry from the preset (desc stripped, everything else kept) then ask for a key
  const entry = presetToEntry(sel.name)
  persistRaw((raw) => { (raw.providers ??= []).push(entry) })
  const key = await vscode.window.showInputBox({ prompt: `API key for ${sel.name} (leave empty to skip)`, password: true })
  if (key?.trim()) setProviderKey(sel.name, key.trim())
  await refresh?.()
}

/** Remove a provider (the active one is protected, CLI parity). */
export async function removeProviderFlow(refresh) {
  let providers, activeProvider
  try {
    ({ providers, activeProvider } = resolveProviders())
  } catch (e) {
    vscode.window.showErrorMessage(e.message)
    return
  }
  const candidates = providers.filter((p) => p.name !== activeProvider)
  if (candidates.length === 0) {
    vscode.window.showInformationMessage("No removable providers — the active provider is kept.")
    return
  }
  const sel = await vscode.window.showQuickPick(
    candidates.map((p) => ({ label: p.name, description: p.model })),
    { placeHolder: "Remove provider" },
  )
  if (!sel) return
  persistRaw((raw) => { raw.providers = (raw.providers ?? []).filter((p) => p?.name !== sel.label) })
  await refresh?.()
}

/** Set / replace an API key for a configured provider. */
export async function setKeyFlow(refresh) {
  let providers
  try {
    ({ providers } = resolveProviders())
  } catch (e) {
    vscode.window.showErrorMessage(e.message)
    return
  }
  if (providers.length === 0) return
  const sel = await vscode.window.showQuickPick(
    providers.map((p) => ({ label: p.name, description: p.apiKey ? "(has key)" : "(no key)" })),
    { placeHolder: "Set API key for provider" },
  )
  if (!sel) return
  const key = await vscode.window.showInputBox({ prompt: `API key for ${sel.label}`, password: true })
  if (key?.trim()) {
    setProviderKey(sel.label, key.trim())
    await refresh?.()
  }
}
