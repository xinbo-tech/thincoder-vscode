/**
 * settings.js — settings panel, provider keys, MCP configuration.
 */
import { escHtml } from "./ui.js"
import { t } from "./i18n.js"

const PROVIDER_LABELS = {
  deepseek: "DeepSeek", kimi: "Kimi (Moonshot)", glm: "GLM (Zhipu)",
  qwen: "Qwen (Alibaba)", minimax: "MiniMax", openai: "OpenAI",
  claude: "Claude (Anthropic)", gemini: "Gemini (Google)",
  grok: "Grok (xAI)", mistral: "Mistral",
}

/** @type {{ providers?: Record<string,{configured:boolean,masked:string}>, custom?: {baseURL?:string,model?:string}, labels?: Record<string,string> }} */
let _providerStatus = {}
/** Model list getter (chat panel's ctx._models) — supplies the advisor model dropdown. */
let _getModels = null
/** @type {{ provider?: string, hasKey?: boolean }} */
let _websearchSettings = {}
/** Show preset info (read-only) or custom fields depending on the Add form's type select. */
function paTypeChanged() {
  const type = document.getElementById("pa-type")?.value
  const info = document.getElementById("pa-preset-info")
  const customFields = document.getElementById("pa-custom-fields")
  if (!info || !customFields) return
  if (type === "custom") {
    info.style.display = "none"
    customFields.style.display = "block"
  } else {
    const p = (_providerStatus.presets || []).find((x) => x.name === type)
    info.style.display = "block"
    customFields.style.display = "none"
    info.textContent = p ? `${p.model} · ${p.baseURL ?? ""}` : ""
  }
}

/** Build the advisor-model dropdown options for a given provider (inherit + known models). */
function buildAdvModelOptions(model, provider) {
  const models = (_getModels?.() || []).filter((m) => m.provider === provider)
  let opts = `<option value="">${t("settings.advisorInherit")}</option>`
  opts += models.map((m) => `<option value="${escHtml(m.id)}" ${model === m.id ? "selected" : ""}>${escHtml(m.id)}</option>`).join("")
  // Keep the current value selectable even if it's not in the known list (custom/retired model).
  if (model && !models.some((m) => m.id === model)) {
    opts += `<option value="${escHtml(model)}" selected>${escHtml(model)}</option>`
  }
  return opts
}

/** Build a subagent-model dropdown (value = "provider:model"; empty = inherit). */
function buildSubmodelOptions(current) {
  const models = _getModels?.() || []
  let opts = `<option value="">${t("settings.inherit")}</option>`
  opts += models.map((m) => {
    const v = `${m.provider}:${m.id}`
    return `<option value="${escHtml(v)}" ${current === v ? "selected" : ""}>${escHtml(v)}</option>`
  }).join("")
  // Keep a non-list value (custom model name / bare provider) selectable.
  if (current && !models.some((m) => `${m.provider}:${m.id}` === current)) {
    opts += `<option value="${escHtml(current)}" selected>${escHtml(current)}</option>`
  }
  return opts
}

/** @type {{ built?:boolean, files?:number, chunks?:number } | null} */
let _indexStatus = null
/** @type {{ maxTurns?:number, subagentTurns?:number, compactThreshold?:number|null, verifyGuard?:boolean, advisor?:object } | null} */
let _agentSettings = null
/** @type {{ name:string, value:string|null }[] | null} — detected shells (extension sends once) */
let _shellCandidates = null
/** @type {string|null} — current config.shell value */
let _shellValue = null
/** @type {{ uri?:string, web?:boolean, model?:boolean } | null} */
let _proxySettings = null

/**
 * Initialize settings panel.
 * @param {{ onClose?: Function }} deps
 */
export function initSettings({ onClose, getModels }) {
  _getModels = getModels
  document.getElementById("settings-btn").addEventListener("click", openSettings)
  document.getElementById("settings-close").addEventListener("click", () => {
    closeSettings()
    if (onClose) onClose()
  })

  // Expose to inline onclick handlers
  window._editKey = function(name) {
    const row = document.getElementById("rowline-" + name)
    if (!row) return
    const label = _providerStatus.labels?.[name] || PROVIDER_LABELS[name] || name
    row.innerHTML = `<span class="prov-name">${escHtml(label)}</span>
      <input id="input-${name}" type="password" placeholder="sk-..." style="flex:1;margin:0 8px;"
        onkeydown="if(event.key==='Enter')window._saveKey('${name}')">
      <button class="key-btn" onclick="window._saveKey('${name}', this)">${t("settings.save")}</button>
      <button class="key-btn" onclick="window._cancelEdit('${name}')">${t("settings.cancel")}</button>`
    setTimeout(() => document.getElementById("input-" + name)?.focus(), 50)
  }

  window._saveKey = function(name, btn) {
    const inp = document.getElementById("input-" + name)
    const key = inp?.value?.trim()
    if (!key) return
    window._vscode.postMessage({ type: "saveProviderKey", name, key })
    flashSaved(btn)
  }

  window._cancelEdit = function(_name) {
    buildSettings() // local re-render, no round-trip needed
  }

  window._delKey = function(name, btn) {
    window._confirmDelete(btn, () => window._vscode.postMessage({ type: "deleteProviderKey", name }))
  }

  // Provider management (panel-internal, posts payloads to the extension host)
  window._setProviderProxy = function(name, proxy) {
    window._vscode.postMessage({ type: "setProviderProxy", name, proxy })
  }
  window._removeProvider = function(name, btn) {
    window._confirmDelete(btn, () => window._vscode.postMessage({ type: "removeProvider", name }))
  }
  window._toggleAddForm = function(show) {
    const form = document.getElementById("prov-add-form")
    const list = document.getElementById("prov-list")
    if (!form || !list) return
    form.style.display = show ? "block" : "none"
    list.style.display = show ? "none" : "block"
    if (show) {
      const typeSel = document.getElementById("pa-type")
      if (typeSel) typeSel.value = typeSel.options[0]?.value ?? "custom"
      paTypeChanged()
      document.getElementById("pa-key") && (document.getElementById("pa-key").value = "")
    }
  }
  window._paTypeChanged = paTypeChanged
  // Advisor provider change → rebuild the model dropdown for that provider.
  window._advProviderChanged = function() {
    const p = document.getElementById("adv-provider")?.value ?? ""
    const sel = document.getElementById("adv-model")
    if (sel) sel.innerHTML = buildAdvModelOptions("", p)
  }
  window._paSave = function() {
    const type = document.getElementById("pa-type")?.value
    const key = document.getElementById("pa-key")?.value?.trim() || undefined
    if (type === "custom") {
      const custom = {
        name: document.getElementById("pa-name")?.value?.trim(),
        baseURL: document.getElementById("pa-url")?.value?.trim(),
        model: document.getElementById("pa-model")?.value?.trim(),
        format: document.getElementById("pa-format")?.value,
      }
      window._vscode.postMessage({ type: "addProvider", custom, key })
    } else {
      window._vscode.postMessage({ type: "addProvider", preset: type, key })
    }
    window._toggleAddForm(false)
  }

  // Embedding key row — same pattern as provider keys
  window._editEmbedKey = function() {
    const row = document.getElementById("row-embed")
    row.innerHTML = `<span class="key-label">${t("settings.embeddingLabel")}</span>
      <input id="input-embed" type="password" placeholder="sk-..." autocomplete="off" style="flex:1;margin:0 8px;"
        onkeydown="if(event.key==='Enter')window._saveEmbedKey()">
      <button class="key-btn" onclick="window._saveEmbedKey(this)">${t("settings.save")}</button>
      <button class="key-btn" onclick="window._cancelEditEmbed()">${t("settings.cancel")}</button>`
    setTimeout(() => document.getElementById("input-embed")?.focus(), 50)
  }
  window._saveEmbedKey = function(btn) {
    const val = document.getElementById("input-embed")?.value?.trim()
    if (!val) { window._cancelEditEmbed(); return }
    window._vscode.postMessage({ type: "saveEmbedKey", key: val })
    flashSaved(btn)
  }
  window._cancelEditEmbed = function() { buildSettings() }
  window._delEmbedKey = function(btn) {
    window._confirmDelete(btn, () => window._vscode.postMessage({ type: "deleteEmbedKey" }))
  }

  // Web search key (Tavily) — same row pattern as provider/embedding keys
  window._editWebsearchKey = function() {
    const row = document.getElementById("row-websearch")
    row.innerHTML = `<span class="key-label">${t("settings.websearchLabel")}</span>
      <input id="input-websearch" type="password" placeholder="tvly-..." autocomplete="off" style="flex:1;margin:0 8px;"
        onkeydown="if(event.key==='Enter')window._saveWebsearchKey()">
      <button class="key-btn" onclick="window._saveWebsearchKey(this)">${t("settings.save")}</button>
      <button class="key-btn" onclick="window._cancelEditWebsearch()">${t("settings.cancel")}</button>`
    setTimeout(() => document.getElementById("input-websearch")?.focus(), 50)
  }
  window._saveWebsearchKey = function(btn) {
    const val = document.getElementById("input-websearch")?.value?.trim()
    if (!val) { window._cancelEditWebsearch(); return }
    window._vscode.postMessage({ type: "saveWebsearchKey", key: val })
    flashSaved(btn)
  }
  window._cancelEditWebsearch = function() { buildSettings() }
  window._delWebsearchKey = function(btn) {
    window._confirmDelete(btn, () => window._vscode.postMessage({ type: "deleteWebsearchKey" }))
  }

  window._mcpServers = {}
  // Request detected shells once (extension caches the detection — CLI /shell parity)
  window._vscode.postMessage({ type: "getShellCandidates" })

  // Two-step delete confirmation: first click arms, second click (within 2.5s) executes.
  window._confirmDelete = function(btn, action) {
    if (btn.dataset.confirming === "1") { action(); return }
    btn.dataset.confirming = "1"
    const orig = btn.textContent
    btn.textContent = t("settings.confirmDelete")
    btn.classList.add("confirming")
    setTimeout(() => {
      if (btn.dataset.confirming !== "1") return
      btn.dataset.confirming = ""
      btn.textContent = orig
      btn.classList.remove("confirming")
    }, 2500)
  }

  return { openSettings, closeSettings, renderMcpList, updateProviderStatus, updateIndexStatus, updateAgentSettings, updateWebsearchSettings, updateShellCandidates, updateProxySettings, updateProxyTestResult, showSettingsError }
}

/** Brief "✓" flash on a save button — the only save feedback the panel has. */
function flashSaved(btn) {
  if (!btn) return
  const orig = btn.textContent
  btn.textContent = "✓"
  btn.classList.add("btn-saved")
  setTimeout(() => {
    btn.textContent = orig
    btn.classList.remove("btn-saved")
  }, 1200)
}

/** Mark an input as invalid briefly (e.g. malformed JSON headers). */
function markInputError(el, ms = 2500) {
  if (!el) return
  el.classList.add("input-error")
  setTimeout(() => el.classList.remove("input-error"), ms)
}

/** Error banner at the top of the settings panel (extension-side failures). */
export function showSettingsError(text) {
  const panel = document.getElementById("settings-panel")
  const body = document.getElementById("settings-body")
  if (!panel || !body || panel.style.display === "none") return
  document.getElementById("settings-error-banner")?.remove()
  const el = document.createElement("div")
  el.id = "settings-error-banner"
  el.className = "settings-error-banner"
  el.textContent = text
  body.prepend(el)
  setTimeout(() => el.remove(), 6000)
}

/**
 * A full rebuild wipes any in-progress form (add-provider / add-MCP) and steals
 * focus from the field the user is typing in. Status pushes must not do that —
 * skip the rebuild while a form is open or an input has focus.
 */
function panelHasActiveForm() {
  const panel = document.getElementById("settings-panel")
  if (!panel || panel.style.display === "none") return false
  if (document.getElementById("mcp-form")?.style.display !== "none") return true
  if (document.getElementById("prov-add-form")?.style.display !== "none") return true
  return !!panel.querySelector("input:focus, select:focus, textarea:focus")
}

function rebuildIfIdle() {
  if (!panelHasActiveForm()) buildSettings()
}

function openSettings() {
  const panel = document.getElementById("settings-panel")
  panel.style.display = "flex"
  panel.setAttribute("aria-hidden", "false")
  buildSettings()
  setTimeout(() => {
    const firstBtn = panel.querySelector("button, input")
    if (firstBtn) firstBtn.focus()
  }, 50)
}

function closeSettings() {
  const panel = document.getElementById("settings-panel")
  panel.style.display = "none"
  panel.setAttribute("aria-hidden", "true")
  // inputEl.focus() — caller should handle this via the returned closeSettings
}

function buildSettings() {
  const body = document.getElementById("settings-body")
  const ps = _providerStatus.providers || {}
  const vscode = window._vscode

  let html = ""

  // ─── Providers card ───
  html += `<section class="settings-card"><h4 class="settings-card-title">${t("settings.providersSection")}</h4><div class="settings-card-body">`
  html += `<div id="prov-list">`
  for (const [name, s0] of Object.entries(ps)) {
    const label = _providerStatus.labels?.[name] || PROVIDER_LABELS[name] || name
    const active = !!s0.isActive
    const configured = !!s0.configured
    html += `<div class="prov-row" id="prov-${escHtml(name)}">
      <div class="prov-main" id="rowline-${escHtml(name)}">
        <span class="prov-dot ${configured ? "ok" : ""}"></span>
        <span class="prov-name">${escHtml(label)}</span>
        <span class="key-status ${configured ? "ok" : ""}">${configured ? escHtml(s0.masked) : t("settings.notConfigured")}</span>
        <span class="prov-actions">
          <button class="key-btn" onclick="window._editKey('${escHtml(name)}')">${configured ? t("settings.setKey") : t("settings.addKey")}</button>
          <button class="key-btn del-key" onclick="window._removeProvider('${escHtml(name)}', this)" ${active ? "disabled" : ""} title="${t("settings.remove")}">−</button>
        </span>
      </div>
      <div class="prov-sub">
        <span class="prov-model">${escHtml(s0.model || "")}${s0.baseURL ? ` · ${escHtml(s0.baseURL)}` : ""}</span>
        <label class="switch" title="${t("settings.proxyRowTitle")}"><input type="checkbox" ${s0.proxy ? "checked" : ""} onchange="window._setProviderProxy('${escHtml(name)}', this.checked)"> ${t("settings.proxyRow")}</label>
      </div>
    </div>`
  }
  html += `<button id="prov-add-btn" class="key-btn" onclick="window._toggleAddForm(true)">${t("settings.addProvider")}</button>`
  html += `</div>`

  // [+ Add] form (hidden until toggled): preset select or custom fields
  const presets = _providerStatus.presets || []
  html += `<div id="prov-add-form" style="display:none">
    <div class="settings-subtitle">${t("settings.addProviderTitle")}</div>
    <div class="key-field"><label>${t("settings.presetChoice")}</label>
      <select id="pa-type" onchange="window._paTypeChanged()">
        ${presets.map((p) => `<option value="${escHtml(p.name)}">${escHtml(p.name)} — ${escHtml(p.desc)} (${escHtml(p.model)})</option>`).join("")}
        <option value="custom">${t("settings.customChoice")}</option>
      </select>
    </div>
    <div id="pa-preset-info" class="prov-model" style="padding:2px 0"></div>
    <div id="pa-custom-fields" style="display:none">
      <div class="key-field"><label>${t("settings.providerName")}</label><input id="pa-name" placeholder="my-provider"></div>
      <div class="key-field"><label>${t("settings.baseUrl")}</label><input id="pa-url" placeholder="https://api.example.com/v1"></div>
      <div class="key-field"><label>${t("settings.model")}</label><input id="pa-model" placeholder="model-name"></div>
      <div class="key-field"><label>${t("settings.format")}</label>
        <select id="pa-format"><option value="openai">openai (default)</option><option value="anthropic">anthropic</option><option value="google">google</option></select>
      </div>
    </div>
    <div class="key-field"><label>${t("settings.keyOptional")}</label><input id="pa-key" type="password" placeholder="sk-..."></div>
    <button id="pa-save-btn" class="key-btn">${t("settings.save")}</button>
    <button id="pa-cancel-btn" class="key-btn">${t("settings.cancel")}</button>
  </div>`
  html += `</div></section>`

  // ─── MCP card ───
  html += `<section class="settings-card"><h4 class="settings-card-title">${t("settings.mcpSection")}</h4><div class="settings-card-body">`
  html += `<div id="mcp-list"></div>`
  html += `<button id="mcp-add-btn" class="key-btn">${t("settings.mcpAdd")}</button>`
  html += `<div id="mcp-form" style="display:none">
    <div class="key-field"><label>${t("settings.mcp.name")}</label><input id="mcp-name" placeholder="my-server"></div>
    <div class="key-field"><label>${t("settings.mcp.type")}</label><select id="mcp-type"><option value="stdio">${t("settings.mcpStdio")}</option><option value="http">${t("settings.mcpHttp")}</option><option value="ws">${t("settings.mcpWs")}</option></select></div>
    <div id="mcp-stdio-fields">
      <div class="key-field"><label>${t("settings.mcp.command")}</label><input id="mcp-command" placeholder="npx"></div>
      <div class="key-field"><label>${t("settings.mcp.args")}</label><input id="mcp-args" placeholder="-y @modelcontextprotocol/server-filesystem /path"></div>
      <div class="key-field"><label>${t("settings.mcp.env")}</label><input id="mcp-env" placeholder="KEY=value KEY2=value2 (space-separated)"></div>
    </div>
    <div id="mcp-http-fields" style="display:none">
      <div class="key-field"><label>${t("settings.mcp.url")}</label><input id="mcp-url" placeholder="https://example.com/mcp"></div>
      <div class="key-field"><label>${t("settings.mcp.headers")}</label><input id="mcp-headers" placeholder='{"Authorization":"Bearer xxx"}'></div>
    </div>
    <div id="mcp-ws-fields" style="display:none">
      <div class="key-field"><label>${t("settings.mcp.wsUrl")}</label><input id="mcp-ws-url" placeholder="wss://example.com/mcp"></div>
      <div class="key-field"><label>${t("settings.mcp.headers")}</label><input id="mcp-ws-headers" placeholder='{"Authorization":"Bearer xxx"}'></div>
    </div>
    <button id="mcp-save-btn" class="key-btn">${t("settings.save")}</button>
    <button id="mcp-cancel-btn" class="key-btn">${t("settings.cancel")}</button>
  </div>`
  html += `</div></section>`

  // ─── Semantic index card ───
  const embedConfigured = _indexStatus?.hasEmbedder || false
  html += `<section class="settings-card"><h4 class="settings-card-title">${t("settings.indexSection") || "Semantic Index"}</h4><div class="settings-card-body">`
  html += `<div class="key-row" id="row-embed">
    <span class="key-label">${t("settings.embeddingLabel")}</span>
    <span class="key-status ${embedConfigured ? "ok" : ""}" id="status-embed">${embedConfigured ? "****" : "—"}</span>
    ${embedConfigured
      ? `<button class="key-btn" onclick="window._editEmbedKey()">${t("settings.changeKey")}</button>
         <button class="key-btn del-key" onclick="window._delEmbedKey(this)">✕</button>`
      : `<button class="key-btn" onclick="window._editEmbedKey()">${t("settings.addKey")}</button>`}
  </div>
  <div id="index-status" style="font-size:12px;opacity:0.7;padding:4px 0">—</div>
  <button id="index-build-btn" class="key-btn">${t("settings.indexBuild") || "Build Index"}</button>`
  html += `</div></section>`

  // ─── Agent / Advisor card ───
  const as = _agentSettings || {}
  const adv = as.advisor || {}
  html += `<section class="settings-card"><h4 class="settings-card-title">${t("settings.agentSection")}</h4><div class="settings-card-body">`
  html += `<div class="key-field"><label title="${t("settings.maxTurnsHelp")}">${t("settings.maxTurns")}</label><input id="ag-maxturns" type="number" min="1" value="${as.maxTurns ?? 100}"></div>`
  html += `<div class="key-field"><label title="${t("settings.subagentTurnsHelp")}">${t("settings.subagentTurns")}</label><input id="ag-subturns" type="number" min="1" value="${as.subagentTurns ?? 100}"></div>`
  html += `<div class="settings-subtitle">${t("settings.submodelSection")}</div>`
  html += `<div class="key-field"><label title="${t("settings.submodelHelp")}">${t("settings.submodelGlobal")}</label><select id="ag-submodel-global">${buildSubmodelOptions(as.subagentModel || "")}</select></div>`
  html += `${["explore", "plan", "coder", "eng-coder"].map((role) => `
    <div class="key-field"><label title="${t("settings.submodelHelp")}">${role}</label><select id="ag-submodel-${role}">${buildSubmodelOptions(as.subagentModels?.[role] || "")}</select></div>`).join("")}`
  html += `<div class="key-field"><label title="${t("settings.compactThresholdHelp")}">${t("settings.compactThreshold")}</label><input id="ag-compact" type="number" min="0" placeholder="auto" value="${as.compactThreshold ?? ""}"></div>`
  html += `<label class="switch" title="${t("settings.verifyGuardHelp")}"><input type="checkbox" id="ag-verifyguard" ${as.verifyGuard ? "checked" : ""}> ${t("settings.verifyGuard")}</label>`
  html += `<div class="settings-subtitle">${t("settings.advisorSection")}</div>`
  html += `<label class="switch" title="${t("settings.advisorEnabledHelp")}"><input type="checkbox" id="adv-enabled" ${adv.enabled ? "checked" : ""}> ${t("settings.advisorEnabled")}</label>`
  html += `<label class="switch" title="${t("settings.advisorGuardHelp")}"><input type="checkbox" id="adv-guard" ${adv.guard !== false ? "checked" : ""}> ${t("settings.advisorGuard")}</label>`
  // Provider = configured providers dropdown; model = that provider's known models.
  const configuredNames = Object.entries(ps).filter(([, v]) => v.configured).map(([n]) => n)
  const advProvider = adv.provider || ""
  const provOpts = `<option value="">${t("settings.advisorInherit")}</option>` +
    configuredNames.map((n) => `<option value="${escHtml(n)}" ${advProvider === n ? "selected" : ""}>${escHtml(_providerStatus.labels?.[n] || PROVIDER_LABELS[n] || n)}</option>`).join("")
  html += `<div class="key-field"><label title="${t("settings.advisorProviderHelp")}">${t("settings.advisorProvider")}</label><select id="adv-provider" onchange="window._advProviderChanged()">${provOpts}</select></div>`
  html += `<div class="key-field"><label title="${t("settings.advisorModelHelp")}">${t("settings.advisorModel")}</label><select id="adv-model">${buildAdvModelOptions(adv.model, advProvider)}</select></div>`
  html += `<button id="ag-save-btn" class="key-btn">${t("settings.save")}</button>`
  html += `</div></section>`

  // ─── Proxy card ───
  const px = _proxySettings || {}
  html += `<section class="settings-card"><h4 class="settings-card-title">${t("settings.proxySection")}</h4><div class="settings-card-body">`
  html += `<div class="key-field"><label title="${t("settings.proxyUriHelp")}">${t("settings.proxyUri")}</label><input id="px-uri" placeholder="http://127.0.0.1:7890" value="${escHtml(px.uri || "")}"></div>`
  html += `<label class="switch" title="${t("settings.proxyWebHelp")}"><input type="checkbox" id="px-web" ${px.web !== false ? "checked" : ""}> ${t("settings.proxyWeb")}</label>`
  html += `<label class="switch" title="${t("settings.proxyModelHelp")}"><input type="checkbox" id="px-model" ${px.model ? "checked" : ""}> ${t("settings.proxyModel")}</label>`
  html += `<div><button id="px-save-btn" class="key-btn">${t("settings.save")}</button> <button id="px-test-btn" class="key-btn">${t("settings.proxyTest")}</button></div>`
  html += `<div id="px-test-result" style="font-size:12px;opacity:0.7;padding:4px 0">—</div>`
  html += `</div></section>`

  // ─── Shell card ───
  html += `<section class="settings-card"><h4 class="settings-card-title">${t("settings.shellSection")}</h4><div class="settings-card-body">`
  html += `${(() => {
    const cands = _shellCandidates || []
    const shellIsCustom = _shellValue !== null && !cands.some((c) => (c.value ?? null) === _shellValue)
    return `
    <div class="key-field"><label title="${t("settings.shellHelp")}">${t("settings.shellSelect")}</label><select id="sh-select">
      ${cands.map((c) => `<option value="${escHtml(c.value || "")}" ${!shellIsCustom && (c.value ?? null) === _shellValue ? "selected" : ""}>${escHtml(c.name)}</option>`).join("")}
      <option value="__custom__" ${shellIsCustom ? "selected" : ""}>${t("settings.shellCustom")}</option>
    </select></div>
    <div class="key-field"><label>${t("settings.shellPath")}</label><input id="sh-custom" placeholder="C:\\Program Files\\Git\\bin\\bash.exe" value="${shellIsCustom ? escHtml(_shellValue || "") : ""}" ${shellIsCustom ? "" : "disabled"}></div>
    <button id="sh-save-btn" class="key-btn">${t("settings.save")}</button>`
  })()}`
  html += `</div></section>`

  // ─── Web search card (Tavily structured search) ───
  const ws = _websearchSettings || {}
  html += `<section class="settings-card"><h4 class="settings-card-title">${t("settings.websearchSection")}</h4><div class="settings-card-body">`
  html += `<div class="key-row" id="row-websearch">
    <span class="key-label">${t("settings.websearchLabel")}</span>
    <span class="key-status ${ws.hasKey ? "ok" : ""}" id="status-websearch">${ws.hasKey ? "****" : "—"}</span>
    ${ws.hasKey
      ? `<button class="key-btn" onclick="window._editWebsearchKey()">${t("settings.changeKey")}</button>
         <button class="key-btn del-key" onclick="window._delWebsearchKey(this)">✕</button>`
      : `<button class="key-btn" onclick="window._editWebsearchKey()">${t("settings.addKey")}</button>`}
  </div>
  <div style="font-size:11px;opacity:0.55;padding:2px 0">${t("settings.websearchHelp")}</div>`
  html += `</div></section>`

  body.innerHTML = html

  // Bind Add-provider form controls
  document.getElementById("pa-save-btn").addEventListener("click", () => { window._paSave(); flashSaved(document.getElementById("pa-save-btn")) })
  document.getElementById("pa-cancel-btn").addEventListener("click", () => window._toggleAddForm(false))
  paTypeChanged()

  // Bind Proxy settings save + test
  const pxSave = document.getElementById("px-save-btn")
  if (pxSave) {
    pxSave.addEventListener("click", () => {
      const uri = document.getElementById("px-uri")?.value?.trim() ?? ""
      const web = document.getElementById("px-web")?.checked ?? false
      const model = document.getElementById("px-model")?.checked ?? false
      window._vscode.postMessage({ type: "saveProxySettings", settings: { uri, web, model } })
      flashSaved(pxSave)
    })
  }
  const pxTest = document.getElementById("px-test-btn")
  if (pxTest) {
    pxTest.addEventListener("click", () => {
      const result = document.getElementById("px-test-result")
      if (result) result.textContent = t("settings.proxyTestRunning")
      const uri = document.getElementById("px-uri")?.value?.trim() || ""
      // Test runs in the extension host (Node) — the webview cannot import Node modules.
      window._vscode.postMessage({ type: "testProxy", uri })
    })
  }
  // Bind Agent/Advisor settings save
  const agSave = document.getElementById("ag-save-btn")
  if (agSave) {
    agSave.addEventListener("click", () => {
      const get = (id) => document.getElementById(id)?.value?.trim()
      const chk = (id) => document.getElementById(id)?.checked ?? false
      const compactRaw = get("ag-compact")
      const subModels = {}
      for (const role of ["explore", "plan", "coder", "eng-coder"]) {
        const v = get(`ag-submodel-${role}`)
        if (v) subModels[role] = v
      }
      window._vscode.postMessage({
        type: "saveAgentSettings",
        settings: {
          maxTurns: get("ag-maxturns") || undefined,
          subagentTurns: get("ag-subturns") || undefined,
          subagentModel: get("ag-submodel-global") || undefined,
          subagentModels: subModels,
          compactThreshold: compactRaw === "" ? "" : (compactRaw || undefined),
          verifyGuard: chk("ag-verifyguard"),
          advisor: {
            enabled: chk("adv-enabled"),
            guard: chk("adv-guard"),
            provider: get("adv-provider") || undefined,
            model: get("adv-model") || undefined,
          },
        },
      })
      flashSaved(agSave)
    })
  }

  // Bind Shell save: select (default/candidate/custom) + custom path input
  const shSave = document.getElementById("sh-save-btn")
  if (shSave) {
    // Custom path input enables only when the dropdown is on "Custom path…"
    const shSelect = document.getElementById("sh-select")
    const shCustom = document.getElementById("sh-custom")
    const syncShCustom = () => {
      const isCustom = shSelect?.value === "__custom__"
      if (shCustom) {
        shCustom.disabled = !isCustom
        if (!isCustom) shCustom.value = ""
      }
    }
    if (shSelect) shSelect.addEventListener("change", syncShCustom)
    shSave.addEventListener("click", () => {
      const sel = shSelect?.value ?? ""
      const custom = shCustom?.value?.trim() ?? ""
      const value = sel === "__custom__" ? custom : sel
      window._vscode.postMessage({ type: "saveShellSettings", value })
      flashSaved(shSave)
    })
  }

  // Bind MCP type toggle
  document.getElementById("mcp-type").addEventListener("change", (e) => {
    document.getElementById("mcp-stdio-fields").style.display = e.target.value === "stdio" ? "" : "none"
    document.getElementById("mcp-http-fields").style.display = e.target.value === "http" ? "" : "none"
    document.getElementById("mcp-ws-fields").style.display = e.target.value === "ws" ? "" : "none"
  })

  // Bind MCP add
  document.getElementById("mcp-add-btn").addEventListener("click", () => {
    document.getElementById("mcp-form").style.display = "block"
    document.getElementById("mcp-name").value = ""
    document.getElementById("mcp-command").value = ""
    document.getElementById("mcp-args").value = ""
    document.getElementById("mcp-env").value = ""
    document.getElementById("mcp-url").value = ""
    document.getElementById("mcp-headers").value = ""
    document.getElementById("mcp-ws-url").value = ""
    document.getElementById("mcp-ws-headers").value = ""
    document.getElementById("mcp-type").value = "stdio"
    document.getElementById("mcp-stdio-fields").style.display = ""
    document.getElementById("mcp-http-fields").style.display = "none"
    document.getElementById("mcp-ws-fields").style.display = "none"
  })

  // Bind MCP save
  document.getElementById("mcp-save-btn").addEventListener("click", () => {
    const name = document.getElementById("mcp-name").value.trim()
    if (!name) return
    const type = document.getElementById("mcp-type").value
    const config = {}
    if (type === "stdio") {
      config.command = document.getElementById("mcp-command").value.trim()
      const argsStr = document.getElementById("mcp-args").value.trim()
      config.args = argsStr ? argsStr.split(/\s+/).map((s) => s.trim()).filter(Boolean) : []
      const envStr = document.getElementById("mcp-env").value.trim()
      if (envStr) {
        config.env = {}
        for (const pair of envStr.split(/\s+/)) {
          const eq = pair.indexOf("=")
          if (eq > 0) config.env[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/^["']|["']$/g, "")
        }
      }
    } else if (type === "ws") {
      config.wsUrl = document.getElementById("mcp-ws-url").value.trim()
      const headersEl = document.getElementById("mcp-ws-headers")
      try { config.headers = JSON.parse(headersEl.value || "{}") }
      catch { config.headers = {}; markInputError(headersEl) }
    } else {
      config.url = document.getElementById("mcp-url").value.trim()
      const headersEl = document.getElementById("mcp-headers")
      try { config.headers = JSON.parse(headersEl.value || "{}") }
      catch { config.headers = {}; markInputError(headersEl) }
    }
    vscode.postMessage({ type: "saveMcpServer", name, config })
    flashSaved(document.getElementById("mcp-save-btn"))
    document.getElementById("mcp-form").style.display = "none"
  })

  // Bind MCP cancel
  document.getElementById("mcp-cancel-btn").addEventListener("click", () => {
    document.getElementById("mcp-form").style.display = "none"
  })

  // Bind index build button
  document.getElementById("index-build-btn").addEventListener("click", () => {
    vscode.postMessage({ type: "buildIndex" })
    document.getElementById("index-status").textContent = t("settings.indexBuilding")
    document.getElementById("index-build-btn").disabled = true
  })

  // Render index status if we have it
  if (_indexStatus) renderIndexStatus()

  // Render MCP server list
  renderMcpList()

  // Request MCP status
  vscode.postMessage({ type: "getMcpStatus" })
}

function renderMcpList() {
  const list = document.getElementById("mcp-list")
  if (!list) return
  const servers = window._mcpServers // array of { name, desc, connected, toolCount }
  if (!Array.isArray(servers) || servers.length === 0) {
    list.innerHTML = `<div style="font-size:12px;opacity:0.5;padding:4px 0">${t("settings.mcp.noServers")}</div>`
    return
  }
  list.innerHTML = servers.map((s) => {
    const mark = s.connected ? "●" : "○"
    const markColor = s.connected ? "color:var(--accent)" : "opacity:0.4"
    const type = s.desc.startsWith("ws:") || s.desc.startsWith("wss:") ? "ws" : s.desc.startsWith("http") ? "http" : "stdio"
    const count = s.connected && s.toolCount ? ` · ${s.toolCount} tools` : ""
    return `<div class="key-row" style="font-size:12px">
      <span style="${markColor};width:14px">${mark}</span>
      <span class="key-label">${escHtml(s.name)}</span>
      <span style="opacity:0.5;flex:1;margin:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(s.desc)}${count}</span>
      <span style="font-size:10px;opacity:0.4;margin-right:8px">${type}</span>
      <button class="key-btn mcp-reconnect-btn" data-name="${escHtml(s.name)}">${t("settings.mcp.reconnect")}</button>
      <button class="key-btn del-key mcp-del-btn" data-name="${escHtml(s.name)}">✕</button>
    </div>`
  }).join("")
  list.querySelectorAll(".mcp-del-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      window._confirmDelete(btn, () => window._vscode.postMessage({ type: "deleteMcpServer", name: btn.dataset.name }))
    })
  })
  list.querySelectorAll(".mcp-reconnect-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      window._vscode.postMessage({ type: "reconnectMcp", name: btn.dataset.name })
    })
  })
}

function updateProviderStatus(status) {
  _providerStatus = status
  rebuildIfIdle()
}

function updateAgentSettings(settings) {
  _agentSettings = settings
  rebuildIfIdle()
}

function updateWebsearchSettings(settings) {
  _websearchSettings = settings || {}
  rebuildIfIdle()
}

function updateShellCandidates(payload) {
  _shellCandidates = payload?.candidates || []
  _shellValue = payload?.current ?? null
  rebuildIfIdle()
}

function updateProxySettings(settings) {
  _proxySettings = settings
  rebuildIfIdle()
}

function updateProxyTestResult(result) {
  const el = document.getElementById("px-test-result")
  if (!el) return
  if (result?.ok) el.textContent = `✓ OK (HTTP ${result.status})`
  else if (result?.status) el.textContent = `✗ HTTP ${result.status}`
  else el.textContent = `✗ ${result?.error || "unknown error"}`
}

function updateIndexStatus(s) {
  _indexStatus = s
  renderIndexStatus()
  rebuildIfIdle()
}

function renderIndexStatus() {
  const el = document.getElementById("index-status")
  if (!el) return
  const btn = document.getElementById("index-build-btn")
  if (!_indexStatus) {
    el.textContent = t("settings.indexNoKey")
    if (btn) btn.disabled = true
    return
  }
  if (_indexStatus.built) {
    el.textContent = t("settings.indexBuilt", { files: _indexStatus.files, chunks: _indexStatus.chunks })
    if (btn) { btn.textContent = t("settings.indexRebuild") || "Rebuild Index"; btn.disabled = false }
  } else {
    el.textContent = t("settings.indexNotBuilt")
    if (btn) btn.disabled = false
  }
}
