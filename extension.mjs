/**
 * extension.mjs — ThinCoder VS Code Extension entry point
 * Registers ChatPanel as a WebviewViewProvider (sidebar on the right).
 */
import * as vscode from "vscode"
import { ChatPanel } from "./src/extension/chat-panel.mjs"
import { closeAllMcp } from "./src/mcp.mjs"
import { initLocale } from "./src/i18n.mjs"

/** @type {ChatPanel} */
let _panel

export async function activate(context) {
  console.warn("[thincoder] activate starting, globalStorageUri =", context.globalStorageUri?.fsPath)
  initLocale(vscode.env.language)
  _panel = new ChatPanel(context)

  // Status bar item
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.command = "thincoder.openChat"
  statusBar.text = "$(hubot) ThinCoder"
  statusBar.tooltip = "Focus ThinCoder Chat"
  statusBar.show()
  _panel._statusBar = statusBar
  context.subscriptions.push(statusBar)

  // Register sidebar webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("thincoder.chat", _panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  // Auto-show sidebar on first activation
  vscode.commands.executeCommand("workbench.view.extension.thincoder")

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("thincoder.openChat", () => {
      // Focus the ThinCoder view container (sidebar)
      vscode.commands.executeCommand("workbench.view.extension.thincoder")
    }),
    vscode.commands.registerCommand("thincoder.sendMessage", () => {
      vscode.commands.executeCommand("workbench.view.extension.thincoder")
      vscode.window.showInputBox({ placeHolder: "Ask ThinCoder..." }).then((text) => {
        if (text) _panel.sendMessage(text)
      })
    }),
    vscode.commands.registerCommand("thincoder.setup", () => {
      vscode.commands.executeCommand("workbench.view.extension.thincoder")
      _panel._pushSettings()
    }),
    vscode.commands.registerCommand("thincoder.askSelection", () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      const selection = editor.document.getText(editor.selection)
      if (!selection) return
      vscode.commands.executeCommand("workbench.view.extension.thincoder")
      _panel.sendMessage(selection)
    }),
    vscode.commands.registerCommand("thincoder.buildIndex", () => _panel._buildIndex()),
  )
}

export function deactivate() {
  closeAllMcp()
  _panel?.dispose()
}
