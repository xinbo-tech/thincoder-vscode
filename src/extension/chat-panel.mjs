/**
 * chat-panel.mjs — ChatPanel class: webview panel, message routing, session management.
 * Extracted from extension.mjs to keep the entry point lean.
 */
import * as vscode from "vscode"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { closeAllMcp, mcpConnectedToolCounts, mcpConnect, mcpDisconnectByName } from "../mcp.mjs"
import { listSlots, loadSlot, saveSessionToSlot, newSlot, deleteSlotAndUpdate, setSlotTitle, activeSlot, loadModelPrefs } from "./session-io.mjs"
import { providerStatus, saveProviderKey, saveCustomProvider, deleteProviderKey, pushStatus, fullStatus, getMcpServers, saveMcpServer, deleteMcpServer, connectedMcpServers, agentSettings, proxySettings, shellCandidates } from "./settings.mjs"
import { migrateLegacySettings } from "./migrate-settings.mjs"
import { generateTitle } from "./generate-title.mjs"
import { loadLocaleStrings } from "../i18n.mjs"
import { getEmbedder, setVSCodeEmbedder, resetEmbedder } from "../embed-config.mjs"
import { handlePanelMessage, _cwd } from "./panel-messages.mjs"
import { runPanelChat } from "./panel-chat.mjs"
import { stripEditorInjection } from "./editor-context.mjs"
import { loadEmbeddingConfig, saveEmbeddingConfig, loadRaw } from "../config-io.mjs"
import { buildIndex, needsRebuild, loadIndex as loadVectorIndex } from "../indexer.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

export class ChatPanel {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this._context = context
    this._panel = null

    this._abortController = null
    this._permissionQueue = []
    this._statusBar = null
    // The slot number this panel is bound to. Set once when a session is opened/created,
    // then used for ALL reads and writes — we never re-read the shared manifest's active
    // pointer mid-conversation (it can be changed by a concurrently running CLI).
    this._slot = null
  }

  /**
   * The slot number this panel is bound to. On first use, resolve it once from the
   * persisted active pointer (or create a slot), then keep it fixed for the panel's life.
   */
  _ensureSlot() {
    if (this._slot == null) {
      const cwd = _cwd()
      this._slot = activeSlot(cwd)
    }
    return this._slot
  }

  // ─── WebviewViewProvider ─────────────────────────

  /**
   * Called by VS Code when the sidebar view becomes visible.
   * Sets up the webview HTML, message listener, and initial state.
   * @param {vscode.WebviewView} webviewView
   * @param {vscode.WebviewViewResolveContext} _context
   * @param {vscode.CancellationToken} _token
   */
  resolveWebviewView(webviewView, _context, _token) {
    this._panel = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      retainContextWhenHidden: true,
    }

    webviewView.onDidDispose(() => {
      this._panel = null
      this._abortController?.abort()
      closeAllMcp()
    })

    webviewView.webview.html = this._html()
    webviewView.webview.postMessage({ type: "i18n", strings: loadLocaleStrings(vscode.env.language) })

    webviewView.webview.onDidReceiveMessage((msg) => {
      handlePanelMessage(this, msg).catch((e) => console.error("[chat-panel] message handler:", e.message))
    })

    this._status()
  }

  sendMessage(text) {
    if (this._panel) {
      this._panel.webview.postMessage({ type: "userMessage", text })
      this._chat(text)
    } else {
      vscode.window.showWarningMessage("ThinCoder panel is not ready yet — please wait a moment and try again.")
    }
  }

  dispose() {
    closeAllMcp()
    this._abortController?.abort()
    this._panel?.dispose()
  }

  // ─── Session ───────────────────────────────────

  /** Current session's slot data (full session object) or null. Uses the bound slot. */
  _activeData() {
    return loadSlot(_cwd(), this._ensureSlot())
  }

  /** Human line (history) of the active session. */
  _activeHistory() {
    return this._activeData()?.history ?? []
  }

  /** Load both persisted lines for the active session: human (history) + machine (contextHistory). */
  _activeLines() {
    const data = this._activeData()
    const history = data?.history ?? []
    const contextHistory = Array.isArray(data?.contextHistory) ? data.contextHistory : [...history]
    return { fullHistory: history, contextHistory }
  }

  /** Persist both lines to the active slot + update manifest metadata. */
  _saveLines(fullHistory, contextHistory, extra = {}) {
    const cwd = _cwd()
    const slot = this._ensureSlot()
    const existing = loadSlot(cwd, slot) ?? {}
    // Field-roundtrip contract (CLI docs/design/ARCHITECTURE.md): slot files are full-overwrite
    // writes, so any field we drop here is lost permanently. Spread ...existing so fields the
    // extension doesn't know about (activeModel, engineering, engDesignToken, ...) round-trip
    // intact, then override only what the extension actually owns.
    // Transient machine-only messages (editor-context injections) are dropped on persist
    // (CLI saveSession parity) — they are re-injected fresh on the next turn.
    const keepReal = (m) => !m.transient
    saveSessionToSlot(cwd, slot, {
      ...existing,
      version: 2, cwd, updatedAt: Date.now(),
      title: existing.title ?? "",
      activeProvider: extra.activeProvider ?? existing.activeProvider ?? "",
      history: fullHistory.filter(keepReal), contextHistory: contextHistory.filter(keepReal),
      display: existing.display ?? [], tasks: extra.tasks ?? existing.tasks ?? [],
      planMode: existing.planMode ?? false, goal: existing.goal ?? null,
      autoApprove: existing.autoApprove ?? false, advisor: existing.advisor ?? null,
      // Engineering state persisted by runAgent (agentState): design token survives turns;
      // the engineering flag mirrors config.json so the CLI side round-trips it too.
      engineering: extra.engineering ?? existing.engineering ?? false,
      engDesignToken: extra.engDesignToken ?? existing.engDesignToken ?? null,
      pendingReminders: existing.pendingReminders ?? [], sessionStart: existing.sessionStart ?? null,
    })
  }

  _loadModelPrefs() {
    return loadModelPrefs(this._context.workspaceState)
  }

  _loadSession() {
    const history = this._activeHistory()
    this._panel?.webview.postMessage({ type: "clearMessages" })
    history.forEach((m, idx) => {
      // Real messages carry role (LLM line); UI-only ones may carry type. Derive the UI kind from either.
      const kind = m.type ?? m.role
      if (kind === "user" && typeof m.content === "string") this._panel?.webview.postMessage({ type: "userMessage", text: stripEditorInjection(m.content), timestamp: m.timestamp, idx })
      else if (kind === "assistant" && typeof m.content === "string") this._panel?.webview.postMessage({ type: "assistantMessage", text: m.content, timestamp: m.timestamp, idx })
      else if (kind === "tool" && typeof m.content === "string") {
        // Tool results ARE in the human line (pushReal); render as collapsed cards.
        this._panel?.webview.postMessage({ type: "toolHistory", name: m.name ?? "tool", text: m.content.slice(0, 2000), idx })
      }
    })
    this._pushSessions()
  }

  /**
   * Edit a historical user message: load its text into the input box and truncate
   * the session after it (message + everything after is removed from disk). The user
   * then edits and resends — a clean "rewrite from here" semantic.
   */
  async _editMessage(idx) {
    const history = this._activeHistory()
    const m = history[idx]
    if (!m || (m.type ?? m.role) !== "user" || typeof m.content !== "string") return
    this._truncateSession(idx)
    this._panel?.webview.postMessage({ type: "loadDraft", text: stripEditorInjection(m.content) })
  }

  /** Delete a historical message (and everything after it) from disk + re-render. */
  async _deleteMessage(idx) {
    const history = this._activeHistory()
    if (!history[idx]) return
    this._truncateSession(idx)
  }

  /** Persist the truncated lines (machine line reseeded from the human line — user explicitly rewrote history). */
  _truncateSession(idx) {
    const history = this._activeHistory()
    const lines = history.slice(0, idx)
    this._saveLines(lines, lines, {})
    this._loadSession()
  }

  async _newSession() {
    // Allocate a fresh slot, bind this panel to it, then load its (empty) content.
    this._slot = newSlot(_cwd())
    this._loadSession()
  }

  async _deleteSession(slot) {
    if (typeof slot !== "number" || slot < 1) return
    const slots = listSlots(_cwd())
    if (slots.length <= 1) return  // Keep at least one session
    const newActive = deleteSlotAndUpdate(_cwd(), slot)
    // If we deleted the slot this panel was bound to, rebind to the survivor.
    if (slot === this._slot) this._slot = newActive
    this._loadSession()
  }

  async _generateTitle() {
    try {
      const cwd = _cwd()
      const slot = this._ensureSlot()
      const data = loadSlot(cwd, slot)
      if (!data || data.title) return  // Already titled
      const firstUser = (data.history ?? []).find((m) => (m.type ?? m.role) === "user")
      if (!firstUser) return
      // Provider comes from persisted session data (written by _saveLines on each turn),
      // not the message (runAgent never stamps provider/model onto history entries).
      const title = await generateTitle(firstUser.content, data.activeProvider || undefined)
      if (title) {
        setSlotTitle(cwd, slot, title)
        this._pushSessions()
      }
    } catch (e) {
      console.error("[chat-panel] generateTitle failed:", e.message)
    }
  }

  _pushSessions() {
    const cwd = _cwd()
    // Same label fallback chain as CLI /session: title → firstMessage quote → "(empty)"
    const truncate = (s, n) => s.length <= n ? s : s.slice(0, n - 1) + "…"
    const sessions = listSlots(cwd).map((s) => ({
      slot: s.slot,
      title: s.title || (s.firstMessage ? `"${truncate(s.firstMessage, 40)}"` : "(empty)"),
      count: s.messageCount,
      updated: s.updatedAt,
      provider: s.activeProvider ?? null,
      active: s.isActive,
    }))
    this._panel?.webview.postMessage({ type: "sessions", sessions, active: this._ensureSlot() })
  }

  _pushMcpStatus() {
    const servers = getMcpServers() // array of { name, command?, args?, env?, url?, wsUrl?, headers? }
    const connected = connectedMcpServers()
    const toolCounts = mcpConnectedToolCounts()
    const status = servers.map((s) => ({
      name: s.name,
      desc: s.wsUrl ? s.wsUrl : s.url ? s.url : `${s.command} ${(s.args ?? []).join(" ")}`,
      connected: connected.includes(s.name),
      toolCount: toolCounts[s.name] ?? 0,
    }))
    this._panel?.webview.postMessage({ type: "mcpStatus", servers: status })
  }

  // ─── Settings ─────────────────────────────────

  _providerStatus() { return providerStatus() }
  async _saveProviderKey(name, key) { await saveProviderKey(name, key); this._pushStatus() }
  async _saveCustomProvider(config) { await saveCustomProvider(config); this._pushStatus() }
  async _deleteProviderKey(name) { await deleteProviderKey(name); this._pushStatus() }
  _saveMcpServer(name, config) { return saveMcpServer(name, config) }
  _deleteMcpServer(name) { return deleteMcpServer(name) }

  /** Reconnect an MCP server: disconnect + reconnect (settings panel [Reconnect]). */
  async _reconnectMcp(name) {
    const servers = getMcpServers()
    const srv = servers.find((s) => s.name === name)
    if (!srv) { this._panel?.webview.postMessage({ type: "providerError", text: `No MCP server named "${name}"` }); return }
    try {
      mcpDisconnectByName(name)
      const client = await mcpConnect({
        name: srv.name,
        command: srv.command, args: srv.args, env: srv.env,
        url: srv.url, wsUrl: srv.wsUrl, headers: srv.headers,
      })
      this._panel?.webview.postMessage({ type: "mcpReconnected", name, tools: client.tools.length })
    } catch (e) {
      this._panel?.webview.postMessage({ type: "providerError", text: `MCP reconnect ${name} failed: ${e.message}` })
    }
    this._pushMcpStatus()
  }
  async _setAutoApprove(value) {
    const c = vscode.workspace.getConfiguration("thincoder")
    await c.update("autoApprove", value, vscode.ConfigurationTarget.Global)
  }

  _pushStatus() {
    pushStatus(this._panel)
  }

  _pushSettings() {
    fullStatus(this._panel)
    this._panel?.webview.postMessage({ type: "agentSettings", settings: agentSettings() })
    this._panel?.webview.postMessage({ type: "proxySettings", settings: proxySettings() })
    this._panel?.webview.postMessage({ type: "shellCandidates", candidates: shellCandidates(), current: loadRaw().shell ?? null })
    this._pushMcpStatus()
    this._pushIndexStatus()
  }

  _pushIndexStatus() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
    if (!cwd) return
    const embedder = this._getEmbedder()
    let status = null
    if (embedder) {
      try {
        const idx = loadVectorIndex(cwd)
        if (idx) {
          const files = Object.keys(idx.manifest.files).length
          const chunks = Object.values(idx.manifest.files).reduce((sum, f) => sum + f.chunks.length, 0)
          status = { built: true, files, chunks }
        } else {
          status = { built: false }
        }
      } catch { status = { built: false } }
    }
    this._panel?.webview.postMessage({ type: "indexStatus", status, hasEmbedder: !!embedder })
  }

  async _atComplete(query, cwd) {
    try {
      const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
      const base = cwd || wsFolder || process.cwd()
      const pattern = query.startsWith("@") ? query.slice(1) : query
      const uris = await vscode.workspace.findFiles(
        `**/${pattern}*`,
        "**/node_modules/**,**/.git/**,**/dist/**",
        20,
      )
      const matches = uris.slice(0, 20).map((u) => {
        const abs = u.fsPath
        const rel = abs.slice(base.length + 1).replace(/\\/g, "/")
        const parts = rel.split("/")
        return { name: parts[parts.length - 1], path: rel }
      })
      this._panel?.webview.postMessage({ type: "atResults", matches })
    } catch (e) {
      console.error("[chat-panel] atComplete failed:", e.message)
      this._panel?.webview.postMessage({ type: "atResults", matches: [] })
    }
  }

  async _status() {
    // Ensure at least one session slot exists (shared format with the CLI)
    const cwd = _cwd()
    const slots = listSlots(cwd)
    // Resolve this panel's slot once: reuse the persisted active session, or create the first one.
    this._slot = slots.length === 0 ? newSlot(cwd) : activeSlot(cwd)
    this._pushSessions()
    this._loadSession()
    // One-time migration of legacy key stores (SecretStorage + thincoder.providers settings)
    // into the shared ~/.thincoder/config.json. Flag-guarded, safe to call on every open.
    await migrateLegacySettings(this._context)
    await fullStatus(this._panel, this._context.workspaceState, () => this._pushSessions())
    this._pushMcpStatus()
    const prefs = this._loadModelPrefs()
    if (prefs.model && this._statusBar) this._statusBar.text = `$(hubot) ${prefs.model}`

    // Auto-check: prompt to build vector index if available but missing
    this._maybePromptIndex()
  }

  // ─── Index ─────────────────────────────────────

  _getEmbedder() {
    return getEmbedder()
  }

  async _resolveEmbedder() {
    // Embedding key now lives in the shared config.json (CLI parity); legacy SecretStorage
    // entries were migrated into it by migrateLegacySettings.
    const emb = loadEmbeddingConfig()
    if (emb?.apiKey && emb.baseURL && emb.model) {
      setVSCodeEmbedder(emb)
      return getEmbedder()
    }
    return getEmbedder()
  }

  async _saveEmbeddingConfig({ apiKey }) {
    if (apiKey) {
      saveEmbeddingConfig({
        apiKey,
        baseURL: "https://api.siliconflow.cn/v1",
        model: "BAAI/bge-m3",
      })
      resetEmbedder()
      setVSCodeEmbedder({ baseURL: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", apiKey })
    } else {
      // Delete key — remove from shared config.json and reset the cached embedder
      saveEmbeddingConfig({ apiKey: "" })
      resetEmbedder()
    }
    this._pushSettings()
  }

  async _maybePromptIndex() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
    if (!cwd) return
    const embedder = this._getEmbedder()
    if (!embedder) return

    try {
      const { needed } = needsRebuild(cwd)
      if (!needed) return
    } catch { return }

    const answer = await vscode.window.showInformationMessage(
      "Vector search index not built. Build now? (~30s for small projects, longer for large ones)",
      "Build", "Later"
    )
    if (answer === "Build") this._buildIndex()
  }

  async _buildIndex() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
    if (!cwd) {
      vscode.window.showErrorMessage("No workspace folder open.")
      return
    }
    const embedder = await this._resolveEmbedder()
    if (!embedder) {
      vscode.window.showErrorMessage("No embedding API key configured. Set SILICONFLOW_API_KEY environment variable or configure embedding in ~/.thincoder/config.json")
      return
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Building search index...",
      cancellable: true,
    }, async (progress, token) => {
      try {
        const result = await buildIndex(cwd, embedder, {
          onProgress: (p) => {
            if (p.phase === "embed") {
              progress.report({ message: `Embedding chunks ${p.done}/${p.total}`, increment: 0 })
            } else if (p.phase === "done") {
              progress.report({ message: "Done", increment: 100 })
            }
          },
        })
        vscode.window.showInformationMessage(
          `Index built: ${result.files} files, ${result.chunks} chunks. Semantic search is now active.`
        )
      } catch (e) {
        if (e.name === "AbortError" || token.isCancellationRequested) {
          vscode.window.showWarningMessage("Index build cancelled.")
        } else {
          vscode.window.showErrorMessage(`Index build failed: ${e.message}`)
        }
      }
    })
  }

  // ─── Chat ─────────────────────────────────────

  async _chat(text, modelOverride, reasoning, providerName, images) {
    await runPanelChat(this, { text, modelOverride, reasoning, providerName, images })
  }

  // ─── HTML ─────────────────────────────────────

  _html() {
    let html = readFileSync(join(__dirname, "..", "..", "webview", "index.html"), "utf8")
    const csp = this._panel.webview.cspSource
    html = html.replace("__CSP__",
      `default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp} 'unsafe-inline'; img-src ${csp} https: data:; font-src ${csp}; connect-src ${csp};`)
    html = html.replace("__CSS_BASE_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "..", "..", "webview", "base.css"))).toString())
    html = html.replace("__CSS_CHAT_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "..", "..", "webview", "chat.css"))).toString())
    html = html.replace("__CSS_CONTROLS_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "..", "..", "webview", "controls.css"))).toString())
    html = html.replace("__CSS_SESSION_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "..", "..", "webview", "session.css"))).toString())
    html = html.replace("__CSS_SETTINGS_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "..", "..", "webview", "settings.css"))).toString())
    html = html.replace("__CHAT_URI__", this._panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, "..", "..", "webview", "chat.js"))).toString())
    return html
  }
}
