/**
 * webview-env.mjs — shared happy-dom test harness for webview modules.
 *
 * The webview (chat.js/settings.js/ui.js) is otherwise untestable: it reads
 * global document/window at call time. This registers happy-dom, injects the
 * English locale, and stubs window._vscode so the modules run under node --test.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { setStrings } from "../../webview/i18n.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Register happy-dom globals + locale + vscode stub. Call once per test file. */
export function setupWebview() {
  GlobalRegistrator.register()

  const en = JSON.parse(readFileSync(join(__dirname, "../../locales/en.json"), "utf8"))
  setStrings(en)

  // Stub the VS Code webview bridge — tests capture messages via capturedPosts.
  const capturedPosts = []
  window._vscode = { postMessage: (msg) => capturedPosts.push(msg) }

  return {
    capturedPosts,
    cleanup() {
      try { GlobalRegistrator.unregister() } catch { /* already unregistered — no-op */ }
    },
  }
}

/** Minimal DOM fixture matching index.html's settings-panel structure. */
export function installSettingsFixture() {
  document.body.innerHTML = `
    <button id="settings-btn"></button>
    <button id="settings-close"></button>
    <div id="settings-panel" style="display:none">
      <div class="panel-header"><button id="settings-close"></button></div>
      <div class="panel-body" id="settings-body"></div>
    </div>
  `
}
