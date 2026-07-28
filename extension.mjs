/**
 * extension.mjs — ThinCoder VS Code Extension entry point
 * Chat panel on the right, multi-provider, multi-session with LLM-generated titles.
 */

import * as vscode from "vscode"
import { runAgent } from "./src/agent.mjs"
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { closeAllMcp } from "./src/mcp.mjs"
import { providerNames, getKey, buildProvider, initProviderKeyStore, loadProviderKeyCache } from "./src/extension/presets.mjs"
import { loadMessages, saveMessages, deleteMessages, loadIndex, saveIndex, sessionsKey, loadModelPrefs, saveModelPrefs } from "./src/extension/session-io.mjs"
import { providerStatus, saveProviderKey, saveCustomProvider, deleteProviderKey, pushStatus, fullStatus } from "./src/extension/settings.mjs"
import { generateTitle } from "./src/extension/generate-title.mjs"
import { savePastedImages } from "./src/extension/image-handler.mjs"
import { injectEditorContext } from "./src/extension/editor-context.mjs"
import { specForModel } from "./src/specs.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function activate(context) {
  // Initialize SecretStorage-based key store
  initProviderKeyStore(context.secrets)
  await loadProviderKeyCache()

  const chat = new ChatPanel(context)
  // Status bar
  const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  sb.text = "$(hubot) ThinCoder"; sb.tooltip = "ThinCoder — Click to open"; sb.command = "thincoder.openChat"; sb.show()
  context.subscriptions.push(sb)
  chat._statusBar = sb

  context.subscriptions.push(vscode.commands.registerCommand("thincoder.openChat", () => chat.show()))
  context.subscriptions.push(vscode.commands.registerCommand("thincoder.setup", () => { chat.show() }))
  context.subscriptions.push(vscode.commands.registerCommand("thincoder.sendMessage", async () => {
    const input = await vscode.window.showInputBox({ prompt: "What to do?", placeHolder: "e.g. Add a README" })
    if (input) { chat.show(); chat.sendMessage(input) }
  }))
  context.subscriptions.push(vscode.commands.registerCommand("thincoder.askSelection", async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    let text = editor.document.getText(editor.selection)
    if (!text) return
    // Truncate if too long
    if (text.length > 4000) text = text.slice(0, 4000) + "\n... (truncated)"
    const file = editor.document.fileName.split(/[/\\]/).pop() || ""
    const msg = `Explain this code from ${file}:\n\`\`\`\n${text}\n\`\`\``
    chat.show()
    chat.sendMessage(msg)
  }))
  // Reopen panel if it was open when VS Code last closed
  try { if (existsSync(join(context.storageUri.fsPath, ".panel-open"))) chat.show() } catch {}
}

export function deactivate() { closeAllMcp() }

// ─── Chat Panel ──────────────────────────────────────────────────

class ChatPanel {
  constructor(context) {
    this._context = context
    this._extensionUri = context.extensionUri
    this._panel = null
    this._abortController = null
    this._permissionResolve = null
    // Session messages stored as files under storageUri; workspaceState only holds index
    this._msgDir = join(context.storageUri.fsPath, "sessions")
    this._panelFlagPath = join(context.storageUri.fsPath, ".panel-open")
    try { mkdirSync(this._msgDir, { recursive: true }) } catch {}
  }

  // ─── Session file I/O (delegated to session-io.mjs) ─────

  _loadMessages(name) { return loadMessages(this._msgDir, name) }
  _saveMessages(name, messages) { saveMessages(this._msgDir, name, messages) }
  _deleteMessages(name) { deleteMessages(this._msgDir, name) }

  // ─── Session index (workspaceState) ─────────────

  get _sessionsKey() { return sessionsKey(vscode.workspace.workspaceFolders) }

  _loadModelPrefs() { return loadModelPrefs(this._context.workspaceState) }
  _saveModelPrefs(prefs) { saveModelPrefs(this._context.workspaceState, prefs) }

  _loadIndex() { return loadIndex(this._context.workspaceState, this._sessionsKey) }
  _saveIndex(s) { saveIndex(this._context.workspaceState, this._sessionsKey, s) }

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
    await generateTitle(() => this._loadIndex(), (ix) => this._saveIndex(ix), (n) => this._loadMessages(n), () => this._pushSessions(), this._loadIndex().active)
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
        case "userMessage":    this._chat(msg.text, msg.model, msg.reasoning, msg.provider, msg.images); break
        case "abort":          this._abortController?.abort(); break
        case "saveProviderKey": this._saveProviderKey(msg.name, msg.key); break
        case "deleteProviderKey": this._deleteProviderKey(msg.name); break
        case "getProviderStatus": this._pushStatus(); break
        case "saveCustomProvider": this._saveCustomProvider(msg.config); break
        case "newSession":     this._newSession(); break
        case "switchSession":  this._switchSession(msg.name); break
        case "deleteSession":  this._deleteSession(msg.name); break
        case "getSessions":    this._pushSessions(); break
        case "selectModel":
          this._saveModelPrefs({ ...this._loadModelPrefs(), model: msg.model, provider: msg.provider || "" })
          if (this._statusBar) this._statusBar.text = `$(hubot) ${msg.model}`
          break
        case "selectReasoning": this._saveModelPrefs({ ...this._loadModelPrefs(), reasoning: msg.reasoning }); break
        case "permissionResponse":
          if (this._permissionResolve) {
            this._permissionResolve(msg.approved === true || msg.approved === "approveAll")
            this._permissionResolve = null
          }
          break
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

  _providerStatus() { return providerStatus() }
  async _saveProviderKey(name, key) { await saveProviderKey(name, key); this._pushStatus() }
  async _saveCustomProvider(config) { await saveCustomProvider(config); this._pushStatus() }
  async _deleteProviderKey(name) { await deleteProviderKey(name); this._pushStatus() }
  _pushStatus() { pushStatus(this._panel) }
  async _status() {
    await loadProviderKeyCache() // ensure cache is fresh (extension may already be running)
    await fullStatus(this._panel, this._context.workspaceState, () => this._pushSessions())
    const prefs = this._loadModelPrefs()
    if (prefs.model && this._statusBar) this._statusBar.text = `$(hubot) ${prefs.model}`
  }

  // ─── Chat ─────────────────────────────────────

  async _chat(text, modelOverride, reasoning, providerName, images) {
    if (!this._panel) { vscode.window.showErrorMessage("_chat: panel is null"); return }
    if (!providerName) {
      for (const n of providerNames()) { if (await getKey(n)) { providerName = n; break } }
    }
    if (!providerName) { this._panel.webview.postMessage({ type: "error", text: "No provider configured — click ⚙ to set API keys" }); return }
    let p = await buildProvider(providerName)
    if (!p) { this._panel.webview.postMessage({ type: "error", text: `Failed to build provider "${providerName}" — check your API key` }); return }
    if (modelOverride) p = { ...p, model: modelOverride }
    if (reasoning === "enabled") {
      const spec = specForModel(p.model)
      const thinkVal = spec.thinkEnabledValue || "enabled"
      p = { ...p, thinking: { type: thinkVal }, ...(spec.thinkApi === "effort" ? { reasoningEffort: null } : {}) }
    }
    else if (reasoning && reasoning !== "off") { p = { ...p, reasoningEffort: reasoning } }
    else if (reasoning === "off") { p = { ...p, thinking: null, reasoningEffort: null } }

    const c = vscode.workspace.getConfiguration("thincoder")
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd()
    const ts = new Date().toISOString()

    // Handle pasted images
    text = savePastedImages(images, cwd, text)

    // Inject active editor context
    text = injectEditorContext(text, cwd)

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
        onReasoning: (r) => { this._panel?.webview.postMessage({ type: "reasoning", text: r }) },
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
        onPermissionRequired: c.get("autoApprove", false) ? undefined : (toolName, args) =>
          new Promise((resolve) => {
            this._permissionResolve = resolve
            this._panel?.webview.postMessage({ type: "permissionRequest", tool: toolName, args: JSON.stringify(args, null, 2) })
          }),
      }, this._abortController.signal, c.get("autoApprove", false), { mcpServers: c.get("mcpServers", {}) })
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
    const csp = this._panel.webview.cspSource
    html = html.replace("__CSP__",
      `default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp}; img-src ${csp} https: data:; font-src ${csp}; connect-src ${csp};`)
    html = html.replace("__CSS_BASE_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "webview", "base.css"))).toString())
    html = html.replace("__CSS_CHAT_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "webview", "chat.css"))).toString())
    html = html.replace("__CSS_CONTROLS_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "webview", "controls.css"))).toString())
    html = html.replace("__CSS_SESSION_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "webview", "session.css"))).toString())
    html = html.replace("__CSS_SETTINGS_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "webview", "settings.css"))).toString())
    html = html.replace("__CHAT_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "webview", "chat.js"))).toString())
    return html
  }
}
