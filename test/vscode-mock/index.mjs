/**
 * Local mock of the "vscode" module — used ONLY by node --test runs.
 * The real module is provided by the VS Code extension host at runtime.
 * Everything here is a safe no-op default; tests import it but do not
 * assert on its behavior (keep it that way — assert on your logic, not
 * on the mock).
 */

export const workspace = {
  workspaceFolders: [],
  getConfiguration: () => ({ get: () => undefined }),
  fs: {
    readFile: async () => new Uint8Array(0),
    writeFile: async () => {},
    stat: async () => ({ type: 1 }),
  },
  onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
}

export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  withProgress: async (_opts, task) => task({ report: () => {} }, { isCancellationRequested: false }),
  createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  activeTextEditor: undefined,
  onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
  createWebviewPanel: () => ({
    webview: { html: "", onDidReceiveMessage: () => ({ dispose: () => {} }), postMessage: async () => true },
    onDidDispose: () => ({ dispose: () => {} }),
    reveal: () => {},
    dispose: () => {},
  }),
}

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => undefined,
}

export const env = {
  clipboard: { readText: async () => "", writeText: async () => {} },
  machineId: "mock-machine",
  uiKind: 1,
}

export class Uri {
  constructor(scheme, path) {
    this.scheme = scheme
    this.path = path
    this.fsPath = path
  }
  static file(p) { return new Uri("file", p) }
  static parse(s) { const u = new URL(s); return new Uri(u.protocol.slice(0, -1), u.pathname) }
  toString() { return `${this.scheme}://${this.path}` }
  with() { return this }
}

export class CancellationTokenSource {
  constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } }
  cancel() { this.token.isCancellationRequested = true }
  dispose() {}
}

export class EventEmitter {
  constructor() { this.listeners = [] }
  fire(e) { for (const l of this.listeners) l(e) }
  event(listener) { this.listeners.push(listener); return { dispose: () => {} } }
}

export class Progress { report() {} }

export const ProgressLocation = { Notification: 1, Window: 2, Task: 3 }

export const ViewColumn = { Active: -1, Beside: -2, One: 1 }

export const ThemeIcon = class {
  constructor(id) { this.id = id }
}

export const l10n = { t: (s) => s }

export const workspaceState = { get: () => undefined, update: async () => {} }
export const globalState = { get: () => undefined, update: async () => {} }

export const languages = { createDiagnosticCollection: () => ({ dispose: () => {} }) }

export const ExtensionMode = { Production: 1, Development: 2, Test: 3 }

export const version = "1.85.0-mock"
