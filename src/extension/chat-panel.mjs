/**
 * chat-panel.mjs — ChatPanel class: webview panel, message routing, session management.
 * Extracted from extension.mjs to keep the entry point lean.
 */
import * as vscode from "vscode"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { runAgent } from "../agent.mjs"
import { closeAllMcp } from "../mcp.mjs"
import { providerNames, getKey, buildProvider, initProviderKeyStore, loadProviderKeyCache } from "./presets.mjs"
import { listSlots, loadSlot, saveSessionToSlot, newSlot, switchToSlot, deleteSlotAndUpdate, setSlotTitle, activeSlot, loadModelPrefs, saveModelPrefs } from "./session-io.mjs"
import { providerStatus, saveProviderKey, saveCustomProvider, deleteProviderKey, pushStatus, fullStatus, getMcpServers, saveMcpServer, deleteMcpServer } from "./settings.mjs"
import { generateTitle } from "./generate-title.mjs"
import { injectEditorContext } from "./editor-context.mjs"
import { specForModel } from "../specs.mjs"
import { t, loadLocaleStrings } from "../i18n.mjs"
import { loadSkills } from "./skills.mjs"
import { injectAtRefs } from "./file-refs.mjs"
import { createEmbedder } from "../embedding.mjs"
import { getEmbedder, setVSCodeEmbedder, resetEmbedder } from "../embed-config.mjs"
import { buildIndex, needsRebuild, loadIndex as loadVectorIndex } from "../indexer.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Workspace cwd used to key sessions (shared with the CLI — same cwd hash → same session files). */
const _cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd()

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
      (async () => {
      switch (msg.type) {
        case "userMessage": {
          const text = msg.text || ""
          this._chat(text, msg.model, msg.reasoning, msg.provider, msg.images)
          break
        }
        case "selectModel": {
          const prefs = this._loadModelPrefs()
          prefs.model = msg.model
          prefs.provider = msg.provider || ""
          saveModelPrefs(this._context.workspaceState, prefs)
          break
        }
        case "selectReasoning": {
          const prefs = this._loadModelPrefs()
          prefs.reasoning = msg.reasoning
          saveModelPrefs(this._context.workspaceState, prefs)
          break
        }
        case "newSession": this._newSession(); break
        case "switchSession": {
          switchToSlot(_cwd(), msg.slot)  // persists the shared active pointer for CLI interop
          this._slot = msg.slot           // bind this panel to the chosen slot
          await this._loadSession()
          break
        }
        case "deleteSession": await this._deleteSession(msg.slot); break
        case "retry": {
          const history = this._activeHistory()
          const lastUser = [...history].reverse().find((m) => (m.type ?? m.role) === "user")
          if (lastUser) this._chat(lastUser.content, lastUser.provider, undefined, lastUser.provider)
          break
        }
        case "abort": this._abortController?.abort(); break
        case "setAutoApprove": await this._setAutoApprove(!!msg.value); break
        case "atComplete": await this._atComplete(msg.query, msg.cwd); break
        case "permissionResponse": {
          const entry = this._permissionQueue.shift()
          if (msg.approved === "approveAll") {
            this._permissionQueue.forEach((e) => e.resolve(true))
            this._permissionQueue.length = 0
            await this._setAutoApprove(true)
            this._panel?.webview.postMessage({ type: "autoApprove", value: true })
          }
          entry?.resolve(msg.approved === "approveAll" ? true : !!msg.approved)
          break
        }
        case "settings": await this._pushSettings(); break
        case "saveProviderKey": await this._saveProviderKey(msg.name, msg.key); break
        case "saveCustomProvider": await this._saveCustomProvider(msg.config); break
        case "deleteProviderKey": await this._deleteProviderKey(msg.name); break
        case "saveMcpServer": await this._saveMcpServer(msg.name, msg.config); break
        case "deleteMcpServer": await this._deleteMcpServer(msg.name); break
        case "saveEmbeddingConfig": await this._saveEmbeddingConfig(msg.config); break
        case "saveEmbedKey": await this._saveEmbeddingConfig({ apiKey: msg.key }); break
        case "deleteEmbedKey": await this._saveEmbeddingConfig({ apiKey: "" }); break
        case "buildIndex": await this._buildIndex(); break
        case "getMcpStatus": this._pushMcpStatus(); break
      }
      })()  // end async IIFE
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
    saveSessionToSlot(cwd, slot, {
      version: 2, cwd, updatedAt: Date.now(),
      title: existing.title ?? "",
      activeProvider: extra.activeProvider ?? existing.activeProvider ?? "",
      history: fullHistory, contextHistory,
      display: existing.display ?? [], tasks: extra.tasks ?? existing.tasks ?? [],
      planMode: existing.planMode ?? false, goal: existing.goal ?? null,
      autoApprove: existing.autoApprove ?? false, advisor: existing.advisor ?? null,
      pendingReminders: existing.pendingReminders ?? [], sessionStart: existing.sessionStart ?? null,
    })
  }

  _loadModelPrefs() {
    return loadModelPrefs(this._context.workspaceState)
  }

  _loadSession() {
    const history = this._activeHistory()
    this._panel?.webview.postMessage({ type: "clearMessages" })
    for (const m of history) {
      // Real messages carry role (LLM line); UI-only ones may carry type. Derive the UI kind from either.
      const kind = m.type ?? m.role
      if (kind === "user" && typeof m.content === "string") this._panel?.webview.postMessage({ type: "userMessage", text: m.content, timestamp: m.timestamp })
      else if (kind === "assistant" && typeof m.content === "string") this._panel?.webview.postMessage({ type: "assistantMessage", text: m.content, timestamp: m.timestamp })
      // tool calls/results and multimodal parts are not re-rendered from history (they stream live via callbacks)
    }
    this._pushSessions()
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
      active: s.isActive,
    }))
    this._panel?.webview.postMessage({ type: "sessions", sessions, active: this._ensureSlot() })
  }

  _pushMcpStatus() {
    this._panel?.webview.postMessage({ type: "mcpStatus", servers: getMcpServers(this._context.workspaceState) })
  }

  // ─── Settings ─────────────────────────────────

  _providerStatus() { return providerStatus() }
  async _saveProviderKey(name, key) { await saveProviderKey(name, key); this._pushStatus() }
  async _saveCustomProvider(config) { await saveCustomProvider(config); this._pushStatus() }
  async _deleteProviderKey(name) { await deleteProviderKey(name); this._pushStatus() }
  async _saveMcpServer(name, config) { await saveMcpServer(name, config); this._pushMcpStatus() }
  async _deleteMcpServer(name) { await deleteMcpServer(name); this._pushMcpStatus() }
  async _setAutoApprove(value) {
    const c = vscode.workspace.getConfiguration("thincoder")
    await c.update("autoApprove", value, vscode.ConfigurationTarget.Global)
  }

  _pushStatus() {
    pushStatus(this._panel)
  }

  _pushSettings() {
    fullStatus(this._panel)
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
      const dir = join(base, query.startsWith("@") ? query.slice(1).split("/").slice(0, -1).join("/") : "")
      const searchBase = existsSync(dir) ? dir : base
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
    initProviderKeyStore(this._context.secrets)
    await loadProviderKeyCache()
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
    // Try VSCode SecretStorage
    if (this._context.secrets) {
      try {
        const key = await this._context.secrets.get("thincoder.embedding.apiKey")
        if (key) {
          const emb = createEmbedder({ baseURL: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", apiKey: key })
          setVSCodeEmbedder({ baseURL: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", apiKey: key })
          return emb
        }
      } catch {}
    }
    return getEmbedder()
  }

  async _saveEmbeddingConfig({ apiKey }) {
    if (apiKey) {
      try { await this._context.secrets.store("thincoder.embedding.apiKey", apiKey) } catch {}
      resetEmbedder()
      setVSCodeEmbedder({ baseURL: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", apiKey })
    } else {
      // Delete key — clear SecretStorage and reset embedder
      try { await this._context.secrets.delete("thincoder.embedding.apiKey") } catch {}
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
    if (!this._panel) { vscode.window.showErrorMessage("_chat: panel is null"); return }
    if (!providerName) {
      for (const n of providerNames()) {
        try { if (await getKey(n)) { providerName = n; break } } catch {}
      }
    }
    if (!providerName) { this._panel.webview.postMessage({ type: "error", text: t("error.provider") }); return }
    let p
    try {
      p = await buildProvider(providerName)
    } catch (e) {
      console.error("[chat-panel] buildProvider failed:", e.message)
      this._panel.webview.postMessage({ type: "error", text: t("error.failedProvider", { name: providerName }) })
      return
    }
    if (!p) { this._panel.webview.postMessage({ type: "error", text: t("error.failedProvider", { name: providerName }) }); return }
    if (modelOverride) p = { ...p, model: modelOverride }
    if (reasoning === "enabled") {
      const spec = specForModel(p.model)
      const thinkVal = spec.thinkEnabledValue || "enabled"
      p = { ...p, thinking: { type: thinkVal }, ...(spec.thinkApi === "effort" ? { reasoningEffort: null } : {}) }
    } else if (reasoning && reasoning !== "off") {
      p = { ...p, reasoningEffort: reasoning }
    } else if (reasoning === "off") {
      p = { ...p, thinking: null, reasoningEffort: null }
    }

    const c = vscode.workspace.getConfiguration("thincoder")
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd()

    text = injectEditorContext(text, cwd)
    text = injectAtRefs(text, cwd)

    // Load BOTH persisted lines. fullHistory = human line (never-compacted, all real messages —
    // user/assistant text carries BOTH role+type so it feeds the LLM via role AND the UI via type).
    // history = machine line (compaction shrinks it); old sessions fall back to the human line.
    // runAgent appends this turn's real messages (user input, assistant replies, tool results) to
    // both lines via its internal pushReal — chat-panel only supplies the lines and persists them.
    const { fullHistory, contextHistory } = this._activeLines()
    const history = Array.isArray(contextHistory) ? contextHistory : [...fullHistory]
    const isFirstMessage = fullHistory.filter((m) => (m.type ?? m.role) === "user").length === 0

    // Persist model selection
    const prefs = { model: modelOverride || p.model, provider: providerName, reasoning: reasoning || "" }
    saveModelPrefs(this._context.workspaceState, prefs)

    this._panel.webview.postMessage({ type: "loading", loading: true })
    this._abortController?.abort()
    this._abortController = new AbortController()

    // Token stream is forwarded live to the webview; the assistant reply is persisted by runAgent's
    // pushReal into fullHistory (no separate accumulation needed here).
    // Accumulate token usage across all LLM calls in this turn (matches CLI)
    const totalUsage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 }
    try {
      await runAgent(p, cwd, text, {
        onToken: (t) => { this._panel?.webview.postMessage({ type: "token", text: t }) },
        onReasoning: (r) => { this._panel?.webview.postMessage({ type: "reasoning", text: r }) },
        onTaskUpdate: (tasks) => {
          const done = tasks.filter((t) => t.status === "done").length
          const inProgress = tasks.filter((t) => t.status === "in_progress").length
          const pending = tasks.filter((t) => t.status === "pending").length
          this._panel?.webview.postMessage({ type: "taskProgress", done, inProgress, pending, total: tasks.length, items: tasks })
        },
        onPlanMode: (active) => this._panel?.webview.postMessage({ type: "planMode", active }),
        onSubagent: (info) => this._panel?.webview.postMessage({ type: "subagent", ...info }),
        onGoal: (info) => this._panel?.webview.postMessage({ type: "goal", ...info }),
        onUsage: (u) => {
          totalUsage.prompt_tokens += u.prompt_tokens ?? 0
          totalUsage.completion_tokens += u.completion_tokens ?? 0
          totalUsage.prompt_cache_hit_tokens += u.prompt_cache_hit_tokens ?? 0
          totalUsage.prompt_cache_miss_tokens += u.prompt_cache_miss_tokens ?? 0
          const ctxWin = specForModel(p.model)?.contextWindow ?? 128000
          const ctxPct = u.prompt_tokens ? Math.round((u.prompt_tokens / ctxWin) * 100) : null
          this._panel?.webview.postMessage({ type: "usage", usage: { ...totalUsage }, ctxPct })
        },
        onToolCall: (n, a, id) => this._panel?.webview.postMessage({ type: "toolCall", name: n, args: JSON.stringify(a, null, 2), id }),
        onToolResult: (n, r, id) => this._panel?.webview.postMessage({ type: "toolResult", name: n, text: (r || "").slice(0, 2000), id }),
        onToolPanel: (name, text) => this._panel?.webview.postMessage({ type: "toolPanel", name, text }),
        onComplete: () => {
          // runAgent already appended the real messages to both lines via pushReal; just persist them.
          this._saveLines(fullHistory, history, { activeProvider: providerName })
          this._panel?.webview.postMessage({ type: "complete" })
          this._pushSessions()
        },
        onPermissionRequired: c.get("autoApprove", false) ? undefined : (toolName, args, diffInfo) =>
          new Promise((resolve) => {
            this._permissionQueue.push({ resolve, toolName })
            this._panel?.webview.postMessage({ type: "permissionRequest", tool: toolName, args: JSON.stringify(args, null, 2), diff: diffInfo })
          }),
      }, this._abortController.signal, c.get("autoApprove", false), { mcpServers: c.get("mcpServers", {}), images, skills: loadSkills(cwd), history, fullHistory })
    } catch (e) {
      if (e.name === "AbortError") {
        this._panel.webview.postMessage({ type: "aborted" })
      } else {
        console.error("[chat-panel] runAgent failed:", e.message, "provider:", p.baseURL, "model:", p.model)
        const techInfo = `→ Provider: ${p.baseURL}\n→ Model: ${p.model}`
        this._panel.webview.postMessage({ type: "error", text: `${e.message || String(e)}`, techInfo })
      }
    } finally {
      this._panel.webview.postMessage({ type: "loading", loading: false })
    }
    // Generate session title from first message (after agent completes)
    if (isFirstMessage) await this._generateTitle()
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
