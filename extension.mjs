/**
 * extension.mjs — ThinCoder VS Code Extension entry point
 * Chat panel on the right, multi-provider, multi-session with LLM-generated titles.
 */

import * as vscode from "vscode"
import { runAgent } from "./src/agent.mjs"
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { listModels } from "./src/provider.mjs"
import { specForModel } from "./src/specs.mjs"
import { closeAllMcp } from "./src/mcp.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

export function activate(context) {
  const chat = new ChatPanel(context)
  context.subscriptions.push(vscode.commands.registerCommand("thincoder.openChat", () => chat.show()))
  context.subscriptions.push(vscode.commands.registerCommand("thincoder.setup", () => { chat.show() }))
  context.subscriptions.push(vscode.commands.registerCommand("thincoder.sendMessage", async () => {
    const input = await vscode.window.showInputBox({ prompt: "What to do?", placeHolder: "e.g. Add a README" })
    if (input) { chat.show(); chat.sendMessage(input) }
  }))
  // Reopen panel if it was open when VS Code last closed
  try { if (existsSync(join(context.storageUri.fsPath, ".panel-open"))) chat.show() } catch {}
}

export function deactivate() { closeAllMcp() }

// ─── Provider presets ────────────────────────────────────────────

const PRESETS = {
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-pro", label: "DeepSeek", defaultEffort: "max" },
  kimi:     { baseURL: "https://api.moonshot.cn/v1", model: "kimi-k3", label: "Kimi (Moonshot)", defaultEffort: "max" },
  glm:      { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", label: "GLM (Zhipu)", defaultEffort: "max" },
  qwen:     { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max", label: "Qwen (Alibaba)" },
  minimax:  { baseURL: "https://api.minimax.chat/v1", model: "MiniMax-M3", label: "MiniMax", chatPath: "/text/chatcompletion_v2" },
  openai:   { baseURL: "https://api.openai.com/v1", model: "gpt-4o", label: "OpenAI" },
}

function providerNames() { return [...Object.keys(PRESETS), "custom"] }

function readProviders() {
  return vscode.workspace.getConfiguration("thincoder").get("providers") || {}
}

function getKey(name) {
  const providers = readProviders()
  const entry = providers[name]
  if (!entry) return null
  return typeof entry === "string" ? entry : entry.key || null
}

function buildProvider(name) {
  const providers = readProviders()
  const apiKey = getKey(name)
  if (!apiKey) return null

  if (name === "custom") {
    const entry = providers.custom
    if (typeof entry !== "object" || !entry.baseURL || !entry.model) return null
    return { baseURL: entry.baseURL, apiKey, model: entry.model, maxTokens: entry.maxTokens || 131072 }
  }

  const preset = PRESETS[name]
  if (!preset) return null
  const spec = specForModel(preset.model)
  return {
    baseURL: preset.baseURL, apiKey, model: preset.model,
    maxTokens: spec.maxOutput || 131072,
    thinking: spec.thinkApi === "type" ? { type: "enabled" } : null,
    reasoningEffort: preset.defaultEffort || null,
    ...(preset.chatPath ? { chatPath: preset.chatPath } : {}),
  }
}

// ─── Chat Panel ──────────────────────────────────────────────────

class ChatPanel {
  constructor(context) {
    this._context = context
    this._extensionUri = context.extensionUri
    this._panel = null
    this._abortController = null
    // Session messages stored as files under storageUri; workspaceState only holds index
    this._msgDir = join(context.storageUri.fsPath, "sessions")
    this._panelFlagPath = join(context.storageUri.fsPath, ".panel-open")
    try { mkdirSync(this._msgDir, { recursive: true }) } catch {}
  }

  // ─── Session file I/O ──────────────────────────

  _msgPath(name) {
    const safe = Buffer.from(name).toString("base64url")
    return join(this._msgDir, `${safe}.json`)
  }

  _loadMessages(name) {
    try {
      const data = readFileSync(this._msgPath(name), "utf8")
      const parsed = JSON.parse(data)
      return Array.isArray(parsed) ? parsed : (parsed.messages || [])
    } catch { return [] }
  }

  _saveMessages(name, messages) {
    try {
      mkdirSync(this._msgDir, { recursive: true })
      writeFileSync(this._msgPath(name), JSON.stringify(messages), "utf8")
    } catch (e) { console.warn("ThinCoder: failed to save messages", e.message) }
  }

  _deleteMessages(name) {
    try { unlinkSync(this._msgPath(name)) } catch {}
  }

  _renameMessages(oldName, newName) {
    try { renameSync(this._msgPath(oldName), this._msgPath(newName)) } catch {}
  }

  // ─── Session index (workspaceState) ─────────────

  get _sessionsKey() {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || "global"
    return `thincoder.sessions.${Buffer.from(ws).toString("base64").slice(0, 32)}`
  }

  _loadModelPrefs() {
    try { return this._context.workspaceState.get("thincoder.modelPrefs") || {} } catch { return {} }
  }

  _saveModelPrefs(prefs) { try { this._context.workspaceState.update("thincoder.modelPrefs", prefs) } catch {} }

  /** Returns { active, sessions: { name: { title, count, updated } } } — no messages in workspaceState */
  _loadIndex() {
    try {
      const saved = this._context.workspaceState.get(this._sessionsKey)
      // Must have `sessions` object (not old `items` format); treat anything else as corrupted
      if (saved && typeof saved === "object" && saved.active && saved.sessions) return saved
    } catch {}
    return { active: "Session 1", sessions: { "Session 1": { title: "", count: 0, updated: "" } } }
  }

  _saveIndex(s) { try { this._context.workspaceState.update(this._sessionsKey, s) } catch {} }

  _activeHistory() {
    const ix = this._loadIndex()
    if (!ix.sessions[ix.active]) {
      ix.active = Object.keys(ix.sessions)[0] || "Session 1"
      if (!ix.sessions[ix.active]) ix.sessions[ix.active] = { title: "", count: 0, updated: "" }
    }
    return this._loadMessages(ix.active)
  }

  _saveHistory(history, title) {
    const ix = this._loadIndex()
    if (!ix.sessions[ix.active]) ix.sessions[ix.active] = { title: "", count: 0, updated: "" }
    ix.sessions[ix.active].count = history.length
    ix.sessions[ix.active].updated = history.length ? history[history.length - 1].timestamp || new Date().toISOString() : ""
    if (title !== undefined) ix.sessions[ix.active].title = title
    this._saveMessages(ix.active, history)
    this._saveIndex(ix)
  }

  _pushSessions() {
    const ix = this._loadIndex()
    const list = Object.entries(ix.sessions).map(([name, entry]) => ({
      name,
      title: entry.title || name,
      count: entry.count || 0,
      active: name === ix.active,
      updated: entry.updated || "",
    })).sort((a, b) => (b.updated || "").localeCompare(a.updated || ""))
    this._panel?.webview.postMessage({ type: "sessions", sessions: list, active: ix.active })
  }

  _newSession() {
    const ix = this._loadIndex()
    let n = 1
    while (ix.sessions[`Session ${n}`]) n++
    const name = `Session ${n}`
    ix.sessions[name] = { title: "", count: 0, updated: "" }
    ix.active = name
    this._saveMessages(name, [])
    this._saveIndex(ix)
    this._pushSessions()
    this._panel?.webview.postMessage({ type: "clearMessages" })
  }

  _switchSession(name) {
    const ix = this._loadIndex()
    if (!ix.sessions[name]) return
    ix.active = name
    this._saveIndex(ix)
    this._pushSessions()
    this._panel?.webview.postMessage({ type: "clearMessages" })
    const msgs = this._loadMessages(name)
    for (const m of msgs) {
      if (m.type === "user") this._panel.webview.postMessage({ type: "userMessage", text: m.content })
      else if (m.type === "assistant") this._panel.webview.postMessage({ type: "assistantMessage", text: m.content })
    }
  }

  async _deleteSession(name) {
    const ix = this._loadIndex()
    if (Object.keys(ix.sessions).length <= 1) { vscode.window.showWarningMessage("Can't delete the last session."); return }
    const title = ix.sessions[name]?.title || name
    const ok = await vscode.window.showWarningMessage(`Delete "${title}"?`, { modal: true }, "Delete")
    if (ok !== "Delete") return
    delete ix.sessions[name]
    this._deleteMessages(name)
    if (ix.active === name) {
      ix.active = Object.keys(ix.sessions)[0]
      if (!ix.sessions[ix.active]) ix.sessions[ix.active] = { title: "", count: 0, updated: "" }
    }
    this._saveIndex(ix)
    this._pushSessions()
    this._switchSession(ix.active)
  }

  async _generateTitle() {
    const ix = this._loadIndex()
    const entry = ix.sessions[ix.active]
    if (!entry || entry.title) return
    const msgs = this._loadMessages(ix.active)
    const firstUser = msgs.find((m) => m.type === "user")
    if (!firstUser || firstUser.content.length < 10) return

    const provName = providerNames().find((n) => getKey(n))
    if (!provName) return
    const prov = buildProvider(provName)
    if (!prov) return

    try {
      const body = JSON.stringify({
        model: prov.model,
        messages: [
          { role: "system", content: "Generate a concise title (max 40 chars, no quotes) for this conversation. Reply ONLY with the title." },
          { role: "user", content: firstUser.content.slice(0, 200) },
        ],
        max_tokens: 30, stream: false,
      })
      const chatPath = prov.chatPath ?? "/chat/completions"
      const res = await fetch(`${prov.baseURL.replace(/\/+$/, "")}${chatPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${prov.apiKey}` },
        body,
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return
      const data = await res.json()
      const title = data.choices?.[0]?.message?.content?.trim().slice(0, 40)
      if (title) {
        entry.title = title
        this._saveIndex(ix)
        this._pushSessions()
      }
    } catch { /* best-effort */ }
  }

  // ─── Panel lifecycle ──────────────────────────

  show() {
    if (this._panel) { this._panel.reveal(vscode.ViewColumn.Two); return }

    this._panel = vscode.window.createWebviewPanel(
      "thincoder.chat", "ThinCoder",
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this._extensionUri] }
    )

    this._panel.onDidDispose(() => { this._panel = null })
    // Touch flag file so activate() reopens panel next session
    try { mkdirSync(this._msgDir, { recursive: true }); writeFileSync(this._panelFlagPath, "1", "utf8") } catch {}
    this._panel.webview.html = this._html()

    // Register message handler BEFORE anything that might throw
    this._panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case "userMessage":    this._chat(msg.text, msg.model, msg.reasoning, msg.provider); break
        case "abort":          this._abortController?.abort(); break
        case "saveProviderKey": this._saveProviderKey(msg.name, msg.key); break
        case "deleteProviderKey": this._deleteProviderKey(msg.name); break
        case "getProviderStatus": this._pushStatus(); break
        case "saveCustomProvider": this._saveCustomProvider(msg.config); break
        case "newSession":     this._newSession(); break
        case "switchSession":  this._switchSession(msg.name); break
        case "deleteSession":  this._deleteSession(msg.name); break
        case "getSessions":    this._pushSessions(); break
        case "selectModel":    this._saveModelPrefs({ ...this._loadModelPrefs(), model: msg.model, provider: msg.provider || "" }); break
        case "selectReasoning": this._saveModelPrefs({ ...this._loadModelPrefs(), reasoning: msg.reasoning }); break
      }
    })

    // Restore active session (best-effort; may fail if state is corrupted)
    try {
      const history = this._activeHistory()
      for (const m of history) {
        if (m.type === "user") this._panel.webview.postMessage({ type: "userMessage", text: m.content })
        else if (m.type === "assistant") this._panel.webview.postMessage({ type: "assistantMessage", text: m.content })
      }
    } catch (e) {
      console.warn("ThinCoder: failed to restore session history", e.message)
    }

    this._status()
  }

  sendMessage(text) {
    if (this._panel) { this._panel.webview.postMessage({ type: "userMessage", text }); this._chat(text) }
  }

  // ─── Settings ─────────────────────────────────

  _providerStatus() {
    const providers = readProviders()
    const status = {}
    const builtins = [...Object.keys(PRESETS), "custom"]
    for (const name of builtins) {
      const entry = providers[name]
      if (!entry) { status[name] = { configured: false }; continue }
      if (typeof entry === "string") {
        status[name] = { configured: true, masked: entry.slice(0, 4) + "…" + entry.slice(-4) }
      } else {
        status[name] = { configured: true, masked: (entry.key || "").slice(0, 4) + "…" + (entry.key || "").slice(-4), baseURL: entry.baseURL, model: entry.model }
      }
    }
    const custom = providers.custom
    const customCfg = (custom && typeof custom === "object") ? { baseURL: custom.baseURL || "", model: custom.model || "", hasKey: !!custom.key } : null
    return { providers: status, custom: customCfg }
  }

  async _saveProviderKey(name, key) {
    if (!key || !key.trim()) return
    const c = vscode.workspace.getConfiguration("thincoder")
    const providers = { ...(c.get("providers") || {}) }
    providers[name] = key.trim()
    await c.update("providers", providers, vscode.ConfigurationTarget.Global)
    this._pushStatus()
  }

  async _saveCustomProvider({ key, baseURL, model }) {
    const c = vscode.workspace.getConfiguration("thincoder")
    const providers = { ...(c.get("providers") || {}) }
    if (key && baseURL && model) {
      providers.custom = { key: key.trim(), baseURL: baseURL.trim(), model: model.trim() }
    } else {
      delete providers.custom
    }
    await c.update("providers", providers, vscode.ConfigurationTarget.Global)
    this._pushStatus()
  }

  async _deleteProviderKey(name) {
    const c = vscode.workspace.getConfiguration("thincoder")
    const providers = { ...(c.get("providers") || {}) }
    delete providers[name]
    await c.update("providers", providers, vscode.ConfigurationTarget.Global)
    this._pushStatus()
  }

  _pushStatus() {
    const status = this._providerStatus()
    const anyKey = Object.values(status.providers).some((s) => s.configured)
    this._panel?.webview.postMessage({
      type: "providerStatus",
      keyOk: anyKey,
      status,
    })
  }

  async _status() {
    this._pushStatus()
    const status = this._providerStatus()
    const anyKey = Object.values(status.providers).some((s) => s.configured)

    if (!anyKey) return

    const results = await Promise.allSettled(
      providerNames().filter((n) => status.providers[n]?.configured).map(async (name) => {
        const prov = buildProvider(name)
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
    this._panel?.webview.postMessage({ type: "models", models: allModels, prefs: this._loadModelPrefs() })
    this._pushSessions()
  }

  // ─── Chat ─────────────────────────────────────

  async _chat(text, modelOverride, reasoning, providerName) {
    if (!this._panel) { vscode.window.showErrorMessage("_chat: panel is null"); return }
    if (!providerName) providerName = providerNames().find((n) => getKey(n))
    if (!providerName) { this._panel.webview.postMessage({ type: "error", text: "No provider configured — click ⚙ to set API keys" }); return }
    let p = buildProvider(providerName)
    if (!p) { this._panel.webview.postMessage({ type: "error", text: `Failed to build provider "${providerName}" — check your API key` }); return }
    if (modelOverride) p = { ...p, model: modelOverride }
    if (reasoning === "enabled") { p = { ...p, thinking: { type: "enabled" }, reasoningEffort: null } }
    else if (reasoning && reasoning !== "off") { p = { ...p, reasoningEffort: reasoning } }
    else if (reasoning === "off") { p = { ...p, thinking: null, reasoningEffort: null } }

    const c = vscode.workspace.getConfiguration("thincoder")
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd()
    const ts = new Date().toISOString()

    const history = this._activeHistory()
    history.push({ type: "user", content: text, provider: providerName || "", model: modelOverride || p.model, timestamp: ts })
    const isFirstMessage = history.filter((m) => m.type === "user").length === 1
    this._saveHistory(history)

    this._panel.webview.postMessage({ type: "loading", loading: true })
    this._abortController?.abort()
    this._abortController = new AbortController()

    let out = ""
    try {
      await runAgent(p, cwd, text, {
        onToken: (t) => { out += t; this._panel?.webview.postMessage({ type: "token", text: t }) },
        onToolCall: (n, a) => this._panel?.webview.postMessage({ type: "toolCall", name: n, args: JSON.stringify(a, null, 2) }),
        onToolResult: (n, r) => this._panel?.webview.postMessage({ type: "toolResult", name: n, text: r.slice(0, 500) }),
        onComplete: () => {
          if (out) {
            history.push({ type: "assistant", content: out, timestamp: new Date().toISOString() })
            this._saveHistory(history)
          }
          this._panel?.webview.postMessage({ type: "complete" })
          this._pushSessions()
          if (isFirstMessage) this._generateTitle()
        },
      }, this._abortController.signal, c.get("autoApprove", false))
    } catch (e) {
      if (e.name === "AbortError") { this._panel.webview.postMessage({ type: "aborted" }) }
      else {
        const info = `${e.message || String(e)}\n\n→ Provider: ${p.baseURL}\n→ Model: ${p.model}`
        this._panel.webview.postMessage({ type: "error", text: info })
      }
    } finally { this._panel.webview.postMessage({ type: "loading", loading: false }) }
  }

  // ─── HTML ─────────────────────────────────────

  _html() {
    let html = readFileSync(join(__dirname, "webview", "index.html"), "utf8")
    html = html.replace("__CSS_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "webview", "style.css"))).toString())
    html = html.replace("__CHAT_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "webview", "chat.js"))).toString())
    return html
  }
}
