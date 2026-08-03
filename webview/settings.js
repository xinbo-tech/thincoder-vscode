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

/** @type {{ built?:boolean, files?:number, chunks?:number } | null} */
let _indexStatus = null
/** @type {{ maxTurns?:number, subagentTurns?:number, compactThreshold?:number|null, verifyGuard?:boolean, advisor?:object } | null} */
let _agentSettings = null
/** @type {{ uri?:string, web?:boolean, model?:boolean } | null} */
let _proxySettings = null

/**
 * Initialize settings panel.
 * @param {{ vscode: object, inputEl: HTMLElement }} deps
 */
export function initSettings({ vscode, inputEl, onClose }) {
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
    row.innerHTML = `<span class="key-label">${escHtml(label)}</span>
      <input id="input-${name}" type="password" placeholder="sk-..." style="flex:1;margin:0 8px;"
        onkeydown="if(event.key==='Enter')window._saveKey('${name}')">
      <button class="key-btn" onclick="window._saveKey('${name}')">${t("settings.save")}</button>
      <button class="key-btn" onclick="window._cancelEdit('${name}')">${t("settings.cancel")}</button>`
    setTimeout(() => document.getElementById("input-" + name)?.focus(), 50)
  }

  window._saveKey = function(name) {
    const inp = document.getElementById("input-" + name)
    const key = inp?.value?.trim()
    if (!key) return
    window._vscode.postMessage({ type: "saveProviderKey", name, key })
  }

  window._cancelEdit = function(_name) {
    buildSettings() // local re-render, no round-trip needed
  }

  window._delKey = function(name) {
    window._vscode.postMessage({ type: "deleteProviderKey", name })
  }

  // Provider management (panel-internal, posts payloads to the extension host)
  window._setActive = function(name) {
    window._vscode.postMessage({ type: "setActiveProvider", name })
  }
  window._removeProvider = function(name) {
    window._vscode.postMessage({ type: "removeProvider", name })
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
    row.innerHTML = `<span class="key-label">SiliconFlow Embedding</span>
      <input id="input-embed" type="password" placeholder="sk-..." autocomplete="off" style="flex:1;margin:0 8px;"
        onkeydown="if(event.key==='Enter')window._saveEmbedKey()">
      <button class="key-btn" onclick="window._saveEmbedKey()">${t("settings.save")}</button>
      <button class="key-btn" onclick="window._cancelEditEmbed()">${t("settings.cancel")}</button>`
    setTimeout(() => document.getElementById("input-embed")?.focus(), 50)
  }
  window._saveEmbedKey = function() {
    const val = document.getElementById("input-embed")?.value?.trim()
    if (!val) { window._cancelEditEmbed(); return }
    window._vscode.postMessage({ type: "saveEmbedKey", key: val })
  }
  window._cancelEditEmbed = function() { buildSettings() }
  window._delEmbedKey = function() { window._vscode.postMessage({ type: "deleteEmbedKey" }) }

  window._mcpServers = {}

  return { openSettings, closeSettings, renderMcpList, updateProviderStatus, updateIndexStatus, updateAgentSettings, updateProxySettings }
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
  // ─── Providers section: two-line rows, active radio, Key/− buttons, [+ Add] form ───
  html += `<h4 class="settings-section-title">${t("settings.providersSection")}</h4>`
  html += `<div id="prov-list">`
  for (const [name, s0] of Object.entries(ps)) {
    const label = _providerStatus.labels?.[name] || PROVIDER_LABELS[name] || name
    const active = !!s0.isActive
    html += `<div class="prov-row" id="prov-${escHtml(name)}">
      <div class="key-row" id="rowline-${escHtml(name)}">
        <input type="radio" name="active-provider" class="prov-radio" ${active ? "checked" : ""}
          onchange="window._setActive('${escHtml(name)}')" title="${t("settings.active")}">
        <span class="key-label">${escHtml(label)}</span>
        <span class="key-status ${s0.configured ? "ok" : ""}">${s0.configured ? s0.masked : "—"}</span>
        <button class="key-btn" onclick="window._editKey('${escHtml(name)}')">${s0.configured ? t("settings.setKey") : t("settings.addKey")}</button>
        <button class="key-btn del-key" onclick="window._removeProvider('${escHtml(name)}')" ${active ? "disabled" : ""} title="${t("settings.remove")}">−</button>
      </div>
      <div class="prov-sub">${escHtml(s0.model || "")}${s0.baseURL ? ` · ${escHtml(s0.baseURL)}` : ""}</div>
    </div>`
  }
  html += `<button id="prov-add-btn" class="key-btn" style="margin-top:6px" onclick="window._toggleAddForm(true)">${t("settings.addProvider")}</button>`
  html += `</div>`

  // [+ Add] form (hidden until toggled): preset select or custom fields
  const presets = _providerStatus.presets || []
  html += `<div id="prov-add-form" style="display:none;margin-top:8px">
    <h4 class="settings-section-title">${t("settings.addProviderTitle")}</h4>
    <div class="key-field"><label>${t("settings.presetChoice")}</label>
      <select id="pa-type" onchange="window._paTypeChanged()">
        ${presets.map((p) => `<option value="${escHtml(p.name)}">${escHtml(p.name)} — ${escHtml(p.desc)} (${escHtml(p.model)})</option>`).join("")}
        <option value="custom">${t("settings.customChoice")}</option>
      </select>
    </div>
    <div id="pa-preset-info" class="prov-sub" style="padding:2px 0"></div>
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

  // MCP section
  html += `<div class="settings-sep"></div>
    <h4 class="settings-section-title">${t("settings.mcpSection")}</h4>
    <div id="mcp-list"></div>
    <button id="mcp-add-btn" class="key-btn" style="margin-top:6px">${t("settings.mcpAdd")}</button>
    <div id="mcp-form" style="display:none;margin-top:8px">
      <div class="key-field"><label>${t("settings.mcp.name")}</label><input id="mcp-name" placeholder="my-server"></div>
      <div class="key-field"><label>${t("settings.mcp.type")}</label><select id="mcp-type"><option value="stdio">Command (stdio)</option><option value="http">HTTP</option><option value="ws">WebSocket</option></select></div>
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

    // Semantic index section
    const embedConfigured = _indexStatus?.hasEmbedder || false
    html += `<div class="settings-sep"></div>
      <h4 class="settings-section-title">${t("settings.indexSection") || "Semantic Index"}</h4>
      <div class="key-row" id="row-embed">
        <span class="key-label">SiliconFlow Embedding</span>
        <span class="key-status ${embedConfigured ? "ok" : ""}" id="status-embed">${embedConfigured ? "****" : "—"}</span>
        ${embedConfigured
          ? `<button class="key-btn" onclick="window._editEmbedKey()">${t("settings.changeKey")}</button>
             <button class="key-btn del-key" onclick="window._delEmbedKey()">✕</button>`
          : `<button class="key-btn" onclick="window._editEmbedKey()">${t("settings.addKey")}</button>`}
      </div>
      <div id="index-status" style="font-size:12px;opacity:0.7;padding:4px 0">—</div>
      <button id="index-build-btn" class="key-btn" style="margin-top:4px">${t("settings.indexBuild") || "Build Index"}</button>`

    // Agent / Advisor settings section
    const as = _agentSettings || {}
    const adv = as.advisor || {}
    html += `<div class="settings-sep"></div>
      <h4 class="settings-section-title">${t("settings.agentSection")}</h4>
      <div class="key-field"><label>${t("settings.maxTurns")}</label><input id="ag-maxturns" type="number" min="1" value="${as.maxTurns ?? 100}"></div>
      <div class="key-field"><label>${t("settings.subagentTurns")}</label><input id="ag-subturns" type="number" min="1" value="${as.subagentTurns ?? 100}"></div>
      <div class="key-field"><label>${t("settings.compactThreshold")}</label><input id="ag-compact" type="number" min="0" placeholder="auto" value="${as.compactThreshold ?? ""}"></div>
      <div class="key-row"><span class="key-label">${t("settings.verifyGuard")}</span>
        <input type="checkbox" id="ag-verifyguard" ${as.verifyGuard ? "checked" : ""}></div>
      <h4 class="settings-section-title">${t("settings.advisorSection")}</h4>
      <div class="key-row"><span class="key-label">${t("settings.advisorEnabled")}</span>
        <input type="checkbox" id="adv-enabled" ${adv.enabled ? "checked" : ""}></div>
      <div class="key-row"><span class="key-label">${t("settings.advisorGuard")}</span>
        <input type="checkbox" id="adv-guard" ${adv.guard !== false ? "checked" : ""}></div>
      <div class="key-field"><label>${t("settings.advisorProvider")}</label><input id="adv-provider" placeholder="deepseek" value="${escHtml(adv.provider || "")}"></div>
      <div class="key-field"><label>${t("settings.advisorModel")}</label><input id="adv-model" placeholder="deepseek-chat" value="${escHtml(adv.model || "")}"></div>
      <button id="ag-save-btn" class="key-btn" style="margin-top:6px">${t("settings.save")}</button>`

    // Proxy section
    const px = _proxySettings || {}
    html += `<div class="settings-sep"></div>
      <h4 class="settings-section-title">${t("settings.proxySection")}</h4>
      <div class="key-field"><label>${t("settings.proxyUri")}</label><input id="px-uri" placeholder="http://127.0.0.1:7890" value="${escHtml(px.uri || "")}"></div>
      <div class="key-row"><span class="key-label">${t("settings.proxyWeb")}</span>
        <input type="checkbox" id="px-web" ${px.web !== false ? "checked" : ""}></div>
      <div class="key-row"><span class="key-label">${t("settings.proxyModel")}</span>
        <input type="checkbox" id="px-model" ${px.model ? "checked" : ""}></div>
      <button id="px-save-btn" class="key-btn" style="margin-top:4px">${t("settings.save")}</button>
      <button id="px-test-btn" class="key-btn" style="margin-top:4px">${t("settings.proxyTest")}</button>
      <div id="px-test-result" style="font-size:12px;opacity:0.7;padding:4px 0">—</div>`

  body.innerHTML = html

  // Bind Add-provider form controls
  document.getElementById("pa-save-btn").addEventListener("click", () => window._paSave())
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
    })
  }
  const pxTest = document.getElementById("px-test-btn")
  if (pxTest) {
    pxTest.addEventListener("click", async () => {
      const result = document.getElementById("px-test-result")
      if (result) result.textContent = "Testing…"
      const uri = document.getElementById("px-uri")?.value?.trim() || undefined
      try {
        const { proxyFetch } = await import("../src/proxy.mjs")
        const res = await Promise.race([
          proxyFetch("https://www.gstatic.com/generate_204", { headers: { "User-Agent": "ThinCoder" } }, uri || null),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout after 5s")), 5000)),
        ])
        if (result) result.textContent = res.ok ? `✓ OK (HTTP ${res.status})` : `✗ HTTP ${res.status}`
      } catch (e) {
        if (result) result.textContent = `✗ ${e.message}`
      }
    })
  }
  // Bind Agent/Advisor settings save
  const agSave = document.getElementById("ag-save-btn")
  if (agSave) {
    agSave.addEventListener("click", () => {
      const get = (id) => document.getElementById(id)?.value?.trim()
      const chk = (id) => document.getElementById(id)?.checked ?? false
      const compactRaw = get("ag-compact")
      window._vscode.postMessage({
        type: "saveAgentSettings",
        settings: {
          maxTurns: get("ag-maxturns") || undefined,
          subagentTurns: get("ag-subturns") || undefined,
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
      try { config.headers = JSON.parse(document.getElementById("mcp-ws-headers").value || "{}") } catch { config.headers = {} }
    } else {
      config.url = document.getElementById("mcp-url").value.trim()
      try { config.headers = JSON.parse(document.getElementById("mcp-headers").value || "{}") } catch { config.headers = {} }
    }
    vscode.postMessage({ type: "saveMcpServer", name, config })
    document.getElementById("mcp-form").style.display = "none"
  })

  // Bind MCP cancel
  document.getElementById("mcp-cancel-btn").addEventListener("click", () => {
    document.getElementById("mcp-form").style.display = "none"
  })

  // Bind index build button
  document.getElementById("index-build-btn").addEventListener("click", () => {
    vscode.postMessage({ type: "buildIndex" })
    document.getElementById("index-status").textContent = "Building..."
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
      window._vscode.postMessage({ type: "deleteMcpServer", name: btn.dataset.name })
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
  const panel = document.getElementById("settings-panel")
  if (panel && panel.style.display !== "none") buildSettings()
}

function updateAgentSettings(settings) {
  _agentSettings = settings
  const panel = document.getElementById("settings-panel")
  if (panel && panel.style.display !== "none") buildSettings()
}

function updateProxySettings(settings) {
  _proxySettings = settings
  const panel = document.getElementById("settings-panel")
  if (panel && panel.style.display !== "none") buildSettings()
}

function updateIndexStatus(s) {
  _indexStatus = s
  renderIndexStatus()
  const panel = document.getElementById("settings-panel")
  if (panel && panel.style.display !== "none") buildSettings()
}

function renderIndexStatus() {
  const el = document.getElementById("index-status")
  if (!el) return
  const btn = document.getElementById("index-build-btn")
  if (!_indexStatus) {
    el.textContent = "No embedding API key configured."
    if (btn) btn.disabled = true
    return
  }
  if (_indexStatus.built) {
    el.textContent = `\u2713 Index built: ${_indexStatus.files} files, ${_indexStatus.chunks} chunks`
    if (btn) { btn.textContent = t("settings.indexRebuild") || "Rebuild Index"; btn.disabled = false }
  } else {
    el.textContent = "Index not built. Vector search is inactive."
    if (btn) btn.disabled = false
  }
}
