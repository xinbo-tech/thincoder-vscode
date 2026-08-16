/**
 * panel-messages.mjs — ChatPanel webview message router (split out of chat-panel.mjs).
 * Every `case` dispatches to a ChatPanel method or a settings/provider helper.
 */
import * as vscode from "vscode"
import { loadLocaleStrings } from "../i18n.mjs"
import { saveModelPrefs, switchToSlot } from "./session-io.mjs"
import { handleAddProvider, handleRemoveProvider, handleSetProviderProxy, agentSettings, saveAgentSettingsFromPanel, saveProxySettingsFromPanel, testProxyConnection, shellCandidates, saveShellSettingsFromPanel, saveWebsearchKeyFromPanel, deleteWebsearchKeyFromPanel, testProviderConnection } from "./settings.mjs"
import { PRESETS } from "./presets.mjs"
import { addProviderFlow, removeProviderFlow, setKeyFlow } from "./provider-flows.mjs"
import { selectProviderModel, loadRaw, loadMcpServers } from "../config-io.mjs"
import { openDiffPreview } from "./diff-preview.mjs"
import { traceStop } from "./stop-trace.mjs"

/** Current workspace folder (or process cwd) — shared with chat-panel. */
export const _cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd()

/**
 * Handle one webview message. `panel` is the ChatPanel instance — its methods
 * (session mgmt, chat, settings push) stay in the class; this router only switches.
 */
export async function handlePanelMessage(panel, msg) {
  switch (msg.type) {
    case "userMessage": {
      const text = msg.text || ""
      panel._chat(text, msg.model, msg.reasoning, msg.provider, msg.images)
      break
    }
    case "selectModel": {
      const prefs = panel._loadModelPrefs()
      prefs.model = msg.model
      prefs.provider = msg.provider || ""
      saveModelPrefs(panel._context.workspaceState, prefs)
      // Persist into the shared config.json too (CLI selectModel semantics): the CLI
      // resumes this session with activeProvider/activeModel, so the selection must
      // survive the panel, not just the workspaceState prefs.
      if (msg.provider && msg.model) {
        try { selectProviderModel(msg.provider, msg.model) } catch {}
      }
      break
    }
    case "selectReasoning": {
      const prefs = panel._loadModelPrefs()
      prefs.reasoning = msg.reasoning
      saveModelPrefs(panel._context.workspaceState, prefs)
      break
    }
    case "newSession": panel._newSession(); break
    case "switchSession": {
      switchToSlot(_cwd(), msg.slot)  // persists the shared active pointer for CLI interop
      panel._slot = msg.slot          // bind this panel to the chosen slot
      await panel._loadSession()
      break
    }
    case "deleteSession": await panel._deleteSession(msg.slot); break
    case "retry": {
      const history = panel._activeHistory()
      const lastUser = [...history].reverse().find((m) => (m.type ?? m.role) === "user")
      if (lastUser) panel._chat(lastUser.content, lastUser.provider, undefined, lastUser.provider)
      break
    }
    case "abort":
      panel._stopClickTs = Date.now()
      traceStop("click received — abort() called", panel._stopClickTs)
      panel._abortController?.abort()
      break
    // Ctrl+I inject (CLI parity): abort with an interrupt reason — the agent loop
    // commits partial output, injects the message, and resumes from the same context.
    case "interrupt": panel._stopClickTs = Date.now(); traceStop("interrupt received", panel._stopClickTs); panel._abortController?.abort({ interrupt: true, message: msg.message }); break
    // Clickable file paths in tool cards — open in the editor, at the line if given.
    case "openFile": {
      try {
        const doc = await vscode.workspace.openTextDocument(msg.path)
        const ed = await vscode.window.showTextDocument(doc, { preview: true })
        if (msg.line) {
          const pos = new vscode.Position(msg.line - 1, 0)
          ed.selection = new vscode.Selection(pos, pos)
          ed.revealRange(new vscode.Range(pos, pos), 2 /* InCenter */)
        }
      } catch (e) { console.error("[openFile] failed:", e.message) }
      break
    }
    // Permission prompt: open a large diff in the editor's native diff viewer.
    case "openDiff": await openDiffPreview(msg.diff); break
    case "loadOlder": panel._loadOlder(msg.before); break
    case "questionResponse": {
      const entry = panel._questionQueue.shift()
      entry?.resolve(msg.answer ?? null)  // null → tool returns "(user cancelled)"
      panel._refreshStatus()
      break
    }
    case "setAutoApprove": await panel._setAutoApprove(!!msg.value); break
    case "atComplete": await panel._atComplete(msg.query, msg.cwd); break
    case "permissionResponse": {
      const entry = panel._permissionQueue.shift()
      if (msg.approved === "approveAll") {
        panel._permissionQueue.forEach((e) => e.resolve(true))
        panel._permissionQueue.length = 0
        await panel._setAutoApprove(true)
        panel._panel?.webview.postMessage({ type: "autoApprove", value: true })
      }
      entry?.resolve(msg.approved === "approveAll" ? true : !!msg.approved)
      panel._refreshStatus()
      break
    }
    case "settings": await panel._pushSettings(); break
    case "saveProviderKey": await panel._saveProviderKey(msg.name, msg.key); break
    case "saveCustomProvider": await panel._saveCustomProvider(msg.config); break
    case "deleteProviderKey": await panel._deleteProviderKey(msg.name); break
    case "saveMcpServer": await panel._saveMcpServer(msg.name, msg.config); panel._pushMcpStatus(); break
    case "deleteMcpServer": await panel._deleteMcpServer(msg.name); panel._pushMcpStatus(); break
    case "addProvider":
      // Payload form (settings panel [+ Add] form): persist directly.
      // No payload (model dropdown shortcut): interactive QuickPick flow.
      if (msg.preset || msg.custom) {
        const err = handleAddProvider({ preset: msg.preset, custom: msg.custom, key: msg.key })
        if (err) {
          panel._panel?.webview.postMessage({ type: "providerError", text: err })
          panel._pushSettings()
          break
        }
        panel._pushSettings()
        // Verify the connection right away — a typo'd baseURL or a bad key must
        // not fail silently. Surfaced as the settings error banner.
        const baseURL = msg.custom?.baseURL || PRESETS[msg.preset]?.baseURL
        if (baseURL) {
          const test = await testProviderConnection({ baseURL, apiKey: msg.key })
          if (!test.ok) {
            panel._panel?.webview.postMessage({ type: "providerError", text: `Saved, but connection check failed: ${test.error} — check the baseURL / API key.` })
          }
        }
      } else {
        await addProviderFlow(() => panel._pushSettings())
      }
      break
    case "removeProvider":
      if (msg.name) {
        const err = handleRemoveProvider(msg.name)
        if (err) panel._panel?.webview.postMessage({ type: "providerError", text: err })
        panel._pushSettings()
      } else {
        await removeProviderFlow(() => panel._pushSettings())
      }
      break
    case "setProviderProxy": {
      handleSetProviderProxy(msg.name, msg.proxy === true)
      panel._pushSettingsLight()
      break
    }
    case "setKey": await setKeyFlow(() => panel._pushSettings()); break
    case "saveEmbeddingConfig": await panel._saveEmbeddingConfig(msg.config); break
    case "saveEmbedKey": await panel._saveEmbeddingConfig({ apiKey: msg.key }); break
    case "deleteEmbedKey": await panel._saveEmbeddingConfig({ apiKey: "" }); break
    case "saveWebsearchKey": saveWebsearchKeyFromPanel(msg.key); panel._pushSettingsLight(); break
    case "deleteWebsearchKey": deleteWebsearchKeyFromPanel(); panel._pushSettingsLight(); break
    case "testProvider": {
      const r = await testProviderConnection({ baseURL: msg.baseURL, apiKey: msg.apiKey })
      panel._panel?.webview.postMessage({ type: "testProviderResult", ...r })
      break
    }
    case "buildIndex": await panel._buildIndex(); break
    case "getMcpStatus": panel._pushMcpStatus(); break
    case "mcpTools": {
      // Probe/expand: connect (idempotent — reuses the live connection) and return the
      // tool list for the settings panel's per-server expander.
      try {
        const { mcpConnect } = await import("../mcp.mjs")
        const servers = loadMcpServers()
        const cfg = servers.find((x) => x.name === msg.name)
        if (!cfg) throw new Error(`no MCP server named "${msg.name}"`)
        const r = await mcpConnect(cfg)
        panel._panel?.webview.postMessage({ type: "mcpTools", name: msg.name, tools: r.tools })
      } catch (e) {
        panel._panel?.webview.postMessage({ type: "mcpTools", name: msg.name, error: e?.message ?? String(e) })
      }
      break
    }
    case "saveAgentSettings": {
      saveAgentSettingsFromPanel(msg.settings ?? {})
      panel._pushSettingsLight()
      break
    }
    case "getAgentSettings": panel._panel?.webview.postMessage({ type: "agentSettings", settings: agentSettings() }); break
    case "webviewReady": {
      // The webview finished loading — now it's safe to push initial state.
      // resolveWebviewView pushed i18n right after setting webview.html, which
      // races the async load and is DROPPED on Reload Window (labels showed raw
      // keys like "msg.user"). Re-push here, plus the settings the toolbar needs.
      panel._panel?.webview.postMessage({ type: "i18n", strings: loadLocaleStrings(vscode.env.language) })
      panel._panel?.webview.postMessage({ type: "agentSettings", settings: agentSettings() })
      break
    }
    case "setAdvisorEnabled": {
      saveAgentSettingsFromPanel({ advisor: { enabled: !!msg.value } })
      panel._pushSettingsLight()
      break
    }
    case "setEngineeringEnabled": {
      saveAgentSettingsFromPanel({ engineering: !!msg.value })
      panel._pushSettingsLight()
      break
    }
    case "setPlanMode": {
      await panel._setPlanMode(!!msg.value)
      break
    }
    case "getShellCandidates": panel._panel?.webview.postMessage({ type: "shellCandidates", candidates: shellCandidates(), current: loadRaw().shell ?? null }); break
    case "saveShellSettings": {
      saveShellSettingsFromPanel(msg.value)
      panel._pushSettingsLight()
      break
    }
    case "saveProxySettings": {
      saveProxySettingsFromPanel(msg.settings ?? {})
      panel._pushSettingsLight()
      break
    }
    case "testProxy": {
      const result = await testProxyConnection(msg.uri)
      panel._panel?.webview.postMessage({ type: "proxyTestResult", result })
      break
    }
  }
}
