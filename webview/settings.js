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

/** @type {{ providers?: Record<string,{configured:boolean,masked:string}>, custom?: {baseURL?:string,model?:string} }} */
let _providerStatus = {}
/** @type {{ built?:boolean, files?:number, chunks?:number } | null} */
let _indexStatus = null

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
  document.getElementById("settings-body").addEventListener("change", (e) => {
    const id = e.target.id
    if (id !== "s-custom-key" && id !== "s-custom-url" && id !== "s-custom-model") return
    const key = document.getElementById("s-custom-key")?.value
    const url = document.getElementById("s-custom-url")?.value
    const model = document.getElementById("s-custom-model")?.value
    if (key || url || model) {
      vscode.postMessage({ type: "saveCustomProvider", config: { key, baseURL: url, model } })
    }
  })

  // Expose to inline onclick handlers
  window._editKey = function(name) {
    const row = document.getElementById("row-" + name)
    row.innerHTML = `<span class="key-label">${PROVIDER_LABELS[name]}</span>
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

  return { openSettings, closeSettings, renderMcpList, updateProviderStatus, updateIndexStatus }
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
  const custom = _providerStatus.custom || null
  const vscode = window._vscode

  let html = ""
  for (const [name, label] of Object.entries(PROVIDER_LABELS)) {
    const s = ps[name] || {}
    html += `<div class="key-row" id="row-${name}">
      <span class="key-label">${label}</span>
      <span class="key-status ${s.configured ? "ok" : ""}" id="status-${name}">${s.configured ? s.masked : "—"}</span>
      ${s.configured
        ? `<button class="key-btn" onclick="window._editKey('${name}')">${t("settings.changeKey")}</button>
           <button class="key-btn del-key" onclick="window._delKey('${name}')">✕</button>`
        : `<button class="key-btn" onclick="window._editKey('${name}')">${t("settings.addKey")}</button>`}
    </div>`
  }

  html += `<div class="settings-sep"></div>
    <h4 class="settings-section-title">${t("settings.customSection")}</h4>
    <div class="key-field"><label>${t("settings.apiKey")}</label><input id="s-custom-key" type="password" placeholder="sk-..."></div>
    <div class="key-field"><label>${t("settings.baseUrl")}</label><input id="s-custom-url" placeholder="https://api.example.com/v1" value="${escHtml(custom?.baseURL || "")}"></div>
    <div class="key-field"><label>${t("settings.model")}</label><input id="s-custom-model" placeholder="model-name" value="${escHtml(custom?.model || "")}"></div>`

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
        <div class="key-field"><label>${t("settings.mcp.args")}</label><input id="mcp-args" placeholder="-y,@modelcontextprotocol/server-filesystem,/path"></div>
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

  body.innerHTML = html

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
      config.args = argsStr ? argsStr.split(",").map((s) => s.trim()) : []
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
  const servers = window._mcpServers
  const names = Object.keys(servers)
  if (names.length === 0) {
    list.innerHTML = `<div style="font-size:12px;opacity:0.5;padding:4px 0">${t("settings.mcp.noServers")}</div>`
    return
  }
  list.innerHTML = names.map((n) => {
    const s = servers[n]
    const type = s.command ? "stdio" : (s.wsUrl ? "ws" : "http")
    const detail = type === "stdio" ? `${s.command} ${(s.args||[]).join(" ")}` : (s.wsUrl || s.url)
    return `<div class="key-row" style="font-size:12px">
      <span class="key-label">${escHtml(n)}</span>
      <span style="opacity:0.5;flex:1;margin:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(detail)}</span>
      <span style="font-size:10px;opacity:0.4;margin-right:8px">${type}</span>
      <button class="key-btn del-key mcp-del-btn" data-name="${escHtml(n)}">✕</button>
    </div>`
  }).join("")
  list.querySelectorAll(".mcp-del-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.name
      window._vscode.postMessage({ type: "deleteMcpServer", name })
    })
  })
}

function updateProviderStatus(status) {
  _providerStatus = status
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
