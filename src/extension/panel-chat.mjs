/**
 * panel-chat.mjs — ChatPanel chat turn runner (split out of chat-panel.mjs).
 * Resolves the provider, loads the dual history lines, runs the agent with
 * streaming callbacks, persists the lines on complete.
 */
import * as vscode from "vscode"
import { resolveProviders } from "../config-io.mjs"
import { ctxPercentForModel } from "../config.mjs"
import { providerNames, getKey, buildProvider } from "./presets.mjs"
import { saveModelPrefs } from "./session-io.mjs"
import { specForModel } from "../specs.mjs"
import { runAgent } from "../agent.mjs"
import { getMcpServers } from "./settings.mjs"
import { loadSkills } from "./skills.mjs"
import { collectEditorInjection } from "./editor-context.mjs"
import { injectAtRefs } from "./file-refs.mjs"
import { permissionGate } from "./permission-gate.mjs"
import { t } from "../i18n.mjs"

/**
 * Run one chat turn: resolve provider → build callbacks → runAgent →
 * persist both lines on complete. `panel` is the ChatPanel instance.
 */
export async function runPanelChat(panel, { text, modelOverride, reasoning, providerName, images }) {
  if (!panel._panel) { vscode.window.showErrorMessage("_chat: panel is null"); return }
  if (!providerName) {
    // Default provider: activeProvider first (CLI parity) — the settings-panel radio
    // sets this pointer; fall back to the first provider that has a key.
    try {
      const { activeProvider } = resolveProviders()
      if (activeProvider && await getKey(activeProvider)) providerName = activeProvider
    } catch {}
    if (!providerName) {
      for (const n of providerNames()) {
        try { if (await getKey(n)) { providerName = n; break } } catch {}
      }
    }
  }
  if (!providerName) { panel._panel.webview.postMessage({ type: "error", text: t("error.provider") }); return }
  let p
  try {
    p = await buildProvider(providerName)
  } catch (e) {
    console.error("[chat-panel] buildProvider failed:", e.message)
    panel._panel.webview.postMessage({ type: "error", text: t("error.failedProvider", { name: providerName }) })
    return
  }
  if (!p) { panel._panel.webview.postMessage({ type: "error", text: t("error.failedProvider", { name: providerName }) }); return }
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

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd()

  // Sync the live mid-turn flag from the session slot (CLI parity — autoApprove is a
  // session-level slot field, not a VS Code setting). runAgent receives a GETTER: the
  // agent loop and the permission gate re-read it every iteration, so approve-all /
  // the AUTO button take effect immediately mid-turn.
  panel._autoApprove = panel._activeData()?.autoApprove ?? false

  text = injectAtRefs(text, cwd)

  // Load BOTH persisted lines. fullHistory = human line (never-compacted, all real messages —
  // user/assistant text carries BOTH role+type so it feeds the LLM via role AND the UI via type).
  // history = machine line (compaction shrinks it); old sessions fall back to the human line.
  // runAgent appends this turn's real messages (user input, assistant replies, tool results) to
  // both lines via its internal pushReal — chat-panel only supplies the lines and persists them.
  const { fullHistory, contextHistory } = panel._activeLines()
  const history = Array.isArray(contextHistory) ? contextHistory : [...fullHistory]
  const isFirstMessage = fullHistory.filter((m) => (m.type ?? m.role) === "user").length === 0

  // Restore the session-scoped design token (persists across turns within a session; the
  // `engineering` flag and advisor convergence budget live elsewhere — the flag in config.json,
  // the budget resets per run, CLI parity).
  const sessionData = panel._activeData() ?? {}
  const engState = {
    engDesignToken: sessionData.engDesignToken ?? null,
  }

  // Persist model selection
  const prefs = { model: modelOverride || p.model, provider: providerName, reasoning: reasoning || "" }
  saveModelPrefs(panel._context.workspaceState, prefs)

  panel._panel.webview.postMessage({ type: "loading", loading: true })
  panel._turnActive = true
  panel._setStatus("running")
  panel._abortController?.abort()
  panel._abortController = new AbortController()

  // Token stream is forwarded live to the webview; the assistant reply is persisted by runAgent's
  // pushReal into fullHistory (no separate accumulation needed here).
  // Accumulate token usage across all LLM calls in this turn (matches CLI)
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 }
  try {
    await runAgent(p, cwd, text, {
      onToken: (tok) => { panel._panel?.webview.postMessage({ type: "token", text: tok }) },
      onReasoning: (r) => { panel._panel?.webview.postMessage({ type: "reasoning", text: r }) },
      onTaskUpdate: (tasks) => {
        const done = tasks.filter((t) => t.status === "done").length
        const inProgress = tasks.filter((t) => t.status === "in_progress").length
        const pending = tasks.filter((t) => t.status === "pending").length
        panel._panel?.webview.postMessage({ type: "taskProgress", done, inProgress, pending, total: tasks.length, items: tasks })
      },
      onPlanMode: (active) => panel._panel?.webview.postMessage({ type: "planMode", active }),
      onSubagent: (info) => panel._panel?.webview.postMessage({ type: "subagent", ...info }),
      onGoal: (info) => panel._panel?.webview.postMessage({ type: "goal", ...info }),
      onUsage: (u) => {
        totalUsage.prompt_tokens += u.prompt_tokens ?? 0
        totalUsage.completion_tokens += u.completion_tokens ?? 0
        totalUsage.prompt_cache_hit_tokens += u.prompt_cache_hit_tokens ?? 0
        totalUsage.prompt_cache_miss_tokens += u.prompt_cache_miss_tokens ?? 0
        const ctxPct = ctxPercentForModel(u.prompt_tokens, p.model)
        panel._panel?.webview.postMessage({ type: "usage", usage: { ...totalUsage }, ctxPct })
      },
      onToolCall: (n, a, id) => panel._panel?.webview.postMessage({ type: "toolCall", name: n, args: JSON.stringify(a, null, 2), id }),
      onToolResult: (n, r, id) => panel._panel?.webview.postMessage({ type: "toolResult", name: n, text: (r || "").slice(0, 2000), id }),
      // Advisor/verbose-tool progress: {kind, text} chunks (CLI TUI parity) —
      // the webview accumulates them per kind (think/tool/text) instead of
      // overwriting the panel on every message.
      onToolPanel: (name, chunk) => {
        const kind = typeof chunk === "string" ? "text" : (chunk?.kind ?? "text")
        const text = typeof chunk === "string" ? chunk : String(chunk?.text ?? "")
        panel._panel?.webview.postMessage({ type: "toolPanel", name, kind, text, round: chunk?.round })
      },
      onComplete: (content, agentState) => {
        // runAgent already appended the real messages to both lines via pushReal; just persist them.
        // agentState carries the engineering/advisor bookkeeping (CLI session fields:
        // engineering / engDesignToken / advisorRound).
        panel._saveLines(fullHistory, history, { activeProvider: providerName, ...agentState })
        panel._panel?.webview.postMessage({ type: "complete" })
        panel._pushSessions()
      },
      onPermissionRequired: permissionGate(panel),
      // Inline question prompts (question tool) — rendered in the panel, NOT via
      // VS Code's native QuickPick/InputBox (which pops up at the window top and
      // gets dismissed by an accidental click).
      onQuestion: (question, options) => new Promise((resolve) => {
        panel._questionQueue.push({ resolve })
        panel._setStatus("waiting")
        panel._panel?.webview.postMessage({ type: "question", question, options: options ?? null })
      }),
    }, panel._abortController.signal, () => panel._autoApprove, { mcpServers: getMcpServers(), images, skills: loadSkills(cwd), history, fullHistory, engState, injections: [collectEditorInjection(cwd)].filter(Boolean) })
  } catch (e) {
    // Persist the interrupted/errored turn: the user message and any partial output
    // were already pushed into both lines by runAgent (pushReal). Without this save,
    // an abort/error loses the whole turn from disk (CLI parity: at most half a turn lost).
    try {
      panel._saveLines(fullHistory, history, { activeProvider: providerName })
    } catch (saveErr) {
      console.error("[chat-panel] save after abort/error failed:", saveErr.message)
    }
    if (e.name === "AbortError") {
      panel._panel.webview.postMessage({ type: "aborted" })
    } else {
      console.error("[chat-panel] runAgent failed:", e.message, "provider:", p.baseURL, "model:", p.model)
      const techInfo = `→ Provider: ${p.baseURL}\n→ Model: ${p.model}`
      panel._panel.webview.postMessage({ type: "error", text: `${e.message || String(e)}`, techInfo })
    }
  } finally {
    panel._turnActive = false
    panel._refreshStatus()
    panel._panel.webview.postMessage({ type: "loading", loading: false })
  }
  // Generate session title from first message (after agent completes)
  if (isFirstMessage) await panel._generateTitle()
}
