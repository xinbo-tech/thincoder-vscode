/**
 * panel-messages.mjs — ChatPanel webview message router (split out of chat-panel.mjs).
 * Every `case` dispatches to a ChatPanel method or a settings/provider helper.
 */
import * as vscode from "vscode"
import { loadLocaleStrings } from "../i18n.mjs"
import { saveModelPrefs, switchToSlot } from "./session-io.mjs"
import { handleAddProvider, handleRemoveProvider, handleSetProviderProxy, agentSettings, saveAgentSettingsFromPanel, saveProxySettingsFromPanel, testProxyConnection, shellCandidates, saveShellSettingsFromPanel } from "./settings.mjs"
import { addProviderFlow, removeProviderFlow, setKeyFlow } from "./provider-flows.mjs"
import { selectProviderModel, loadRaw } from "../config-io.mjs"

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
    case "abort": panel._abortController?.abort(); break
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
        if (err) panel._panel?.webview.postMessage({ type: "providerError", text: err })
        panel._pushSettings()
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
      panel._pushSettings()
      break
    }
    case "setKey": await setKeyFlow(() => panel._pushSettings()); break
    case "saveEmbeddingConfig": await panel._saveEmbeddingConfig(msg.config); break
    case "saveEmbedKey": await panel._saveEmbeddingConfig({ apiKey: msg.key }); break
    case "deleteEmbedKey": await panel._saveEmbeddingConfig({ apiKey: "" }); break
    case "buildIndex": await panel._buildIndex(); break
    case "getMcpStatus": panel._pushMcpStatus(); break
    case "saveAgentSettings": {
      saveAgentSettingsFromPanel(msg.settings ?? {})
      panel._pushSettings()
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
      panel._pushSettings()
      break
    }
    case "setEngineeringEnabled": {
      saveAgentSettingsFromPanel({ engineering: !!msg.value })
      panel._pushSettings()
      break
    }
    case "getShellCandidates": panel._panel?.webview.postMessage({ type: "shellCandidates", candidates: shellCandidates(), current: loadRaw().shell ?? null }); break
    case "saveShellSettings": {
      saveShellSettingsFromPanel(msg.value)
      panel._pushSettings()
      break
    }
    case "saveProxySettings": {
      saveProxySettingsFromPanel(msg.settings ?? {})
      panel._pushSettings()
      break
    }
    case "testProxy": {
      const result = await testProxyConnection(msg.uri)
      panel._panel?.webview.postMessage({ type: "proxyTestResult", result })
      break
    }
  }
}
