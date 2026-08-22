/**
 * panel-index.mjs — ChatPanel semantic-index + embedder management (split out of
 * chat-panel.mjs), plus the @-file completer. Every function takes the ChatPanel
 * instance as `panel`.
 */
import * as vscode from "vscode"
import { getEmbedder as getSharedEmbedder, setVSCodeEmbedder, resetEmbedder } from "../embed-config.mjs"
import { loadEmbeddingConfig, saveEmbeddingConfig as saveEmbeddingConfigToFile } from "../config-io.mjs"
import { buildIndex as runBuildIndex, needsRebuild, loadIndex as loadVectorIndex } from "../indexer.mjs"
import { _cwd } from "./panel-messages.mjs"

export function pushIndexStatus(panel) {
    const cwd = _cwd()
    if (!cwd) return
    const embedder = getEmbedder()
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
    panel._panel?.webview.postMessage({ type: "indexStatus", status, hasEmbedder: !!embedder })
  }

export async function atComplete(panel, query, cwd) {
    try {
      const base = cwd || _cwd() || process.cwd()
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
      panel._panel?.webview.postMessage({ type: "atResults", matches })
    } catch (e) {
      console.error("[chat-panel] atComplete failed:", e.message)
      panel._panel?.webview.postMessage({ type: "atResults", matches: [] })
    }
  }

export function getEmbedder(_panel) {
    return getSharedEmbedder()
  }

export async function resolveEmbedder(_panel) {
    // Embedding key now lives in the shared config.json (CLI parity); legacy SecretStorage
    // entries were migrated into it by migrateLegacySettings.
    const emb = loadEmbeddingConfig()
    if (emb?.apiKey && emb.baseURL && emb.model) {
      setVSCodeEmbedder(emb)
      return getSharedEmbedder()
    }
    return getSharedEmbedder()
  }

export async function saveEmbeddingConfig(panel, { apiKey }) {
    if (apiKey) {
      saveEmbeddingConfigToFile({
        apiKey,
        baseURL: "https://api.siliconflow.cn/v1",
        model: "BAAI/bge-m3",
      })
      resetEmbedder()
      setVSCodeEmbedder({ baseURL: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", apiKey })
    } else {
      // Delete key — remove from shared config.json and reset the cached embedder
      saveEmbeddingConfigToFile({ apiKey: "" })
      resetEmbedder()
    }
    panel._pushSettings()
  }

export async function maybePromptIndex(panel) {
    const cwd = _cwd()
    if (!cwd) return
    const embedder = getEmbedder()
    if (!embedder) return

    try {
      const { needed } = needsRebuild(cwd)
      if (!needed) return
    } catch { return }

    const answer = await vscode.window.showInformationMessage(
      "Vector search index not built. Build now? (~30s for small projects, longer for large ones)",
      "Build", "Later"
    )
    if (answer === "Build") buildIndex(panel)
  }

export async function buildIndex(panel) {
    const cwd = _cwd()
    if (!cwd) {
      vscode.window.showErrorMessage("No workspace folder open.")
      return
    }
    const embedder = await resolveEmbedder()
    if (!embedder) {
      vscode.window.showErrorMessage("No embedding API key configured. Configure embedding.apiKey in ~/.thincoder/config.json")
      return
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Building search index...",
      cancellable: true,
    }, async (progress, token) => {
      try {
        const result = await runBuildIndex(cwd, embedder, {
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
    // The panel set "Building…" + disabled the button — refresh its index status
    // so the UI recovers without reopening the panel.
    pushIndexStatus(panel)
  }
