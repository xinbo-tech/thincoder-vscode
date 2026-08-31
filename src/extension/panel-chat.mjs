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
import { ensureSlot } from "./panel-session.mjs"
import { specForModel } from "../specs.mjs"
import { runAgent, ContinueError } from "../agent.mjs"
import { getMcpServers } from "./settings.mjs"
import { loadSkills } from "./skills.mjs"
import { collectEditorInjection } from "./editor-context.mjs"
import { injectAtRefs } from "./file-refs.mjs"
import { permissionGate } from "./permission-gate.mjs"
import { notifyCompletionIfUnfocused } from "./notify.mjs"
import { extractFileLinks } from "./file-links.mjs"
import { traceStop } from "./stop-trace.mjs"
import { resolveReasoningMode } from "./reasoning-mode.mjs"
import { t } from "../i18n.mjs"
import { _cwd } from "./panel-messages.mjs"

/**
 * Build the `toolPanel` postMessage payload (pure — directly testable without a
 * webview; ARCHITECTURE.md「子agent/advisor 模型显示」交付评审 #1). String chunks
 * are the legacy text form; object chunks carry kind/text/round/model. All display
 * fields the chunk carries must ride along — the bridge must not silently drop
 * fields (NF1).
 */
export function toolPanelPayload(name, chunk) {
  const kind = typeof chunk === "string" ? "text" : (chunk?.kind ?? "text")
  const text = typeof chunk === "string" ? chunk : String(chunk?.text ?? "")
  return { type: "toolPanel", name, kind, text, round: chunk?.round, model: chunk?.model }
}

/**
 * Run one chat turn: resolve provider → build callbacks → runAgent →
 * persist both lines on complete. `panel` is the ChatPanel instance.
 */
export async function runPanelChat(panel, { text, modelOverride, reasoning, providerName, images }) {
  if (!panel._panel) { vscode.window.showErrorMessage("_chat: panel is null"); return }

  // 交付评审 🔴#1（2026-08-28）：turn 启动的守卫标志与槽绑定必须发生在任何 await 之前——
  // 否则启动窗口内（provider 解析 / await prevDistill，可达秒级）的会话切换会绕过守卫、
  // turnSlot 捕获切换后的槽，"内容落错槽"仍可复现。finally 统一清标志（覆盖全部提前 return）。
  // ensureSlot（而非裸读 _slot）：首次 turn 可能先于 status() 解析（面板命令直呼 _chat），
  // 裸读会把 null 冻进 distillSlot、使 onDistilled 的槽守卫恒拒绝（AC5 回归）。
  panel._turnActive = true
  const turnSlot = ensureSlot(panel)
  const distillSlot = turnSlot
  let isFirstMessage // assigned inside the try (needs the loaded lines); read after finally
  let fullHistory = [] // hoisted: the finally-block save must see them even on early-return paths
  let history = []
  try {

  // Async distillation mount point (SEND-STALL-DISTILL): the distill promise survives across
  // turns on the panel (runAgent rebuilds its agent object every call). `pending` is the
  // previous turn's in-flight distill — the next runAgent awaits it before pushing its input.
  panel._distillState ??= { pending: null }
  // One AbortController per panel lifetime — NOT recreated per turn: a rapid second message
  // must not cancel the previous turn's in-flight distill (AC6a). Only panel dispose / session
  // switch aborts it (review #1); the next turn then lazily creates a fresh one.
  if (!panel._distillController || panel._distillController.signal.aborted) {
    panel._distillController = new AbortController()
  }

  // Previous turn's async distillation must land BEFORE this turn loads the lines from disk:
  // runPanelChat rebuilds the history array per turn (activeLines → JSON.parse of the slot),
  // so awaiting inside runAgent alone would shrink the DETACHED previous array and this turn
  // would start from the stale uncompressed line (AC6a race). The runAgent-side await (N1)
  // stays for direct callers; here pending is nulled so runAgent sees a no-op.
  const prevDistill = panel._distillState.pending
  if (prevDistill) {
    panel._distillState.pending = null
    await prevDistill
  }
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
  // needsSetup tells the webview to re-open the welcome panel (even if the user
  // previously skipped it) — a send with no configured provider should land the
  // user on the configuration form, not just an error banner.
  if (!providerName) { panel._panel?.webview.postMessage({ type: "error", text: t("error.provider"), needsSetup: true }); return }
  let p
  try {
    p = await buildProvider(providerName)
  } catch (e) {
    console.error("[chat-panel] buildProvider failed:", e.message)
    panel._panel?.webview.postMessage({ type: "error", text: t("error.failedProvider", { name: providerName }), needsSetup: true })
    return
  }
  if (!p) { panel._panel?.webview.postMessage({ type: "error", text: t("error.failedProvider", { name: providerName }), needsSetup: true }); return }
  if (modelOverride) p = { ...p, model: modelOverride }
  // Reasoning selector → provider fields. "off" AND "none" (the effort enum's lowest
  // level, labeled "off" in the UI) are a true thinking toggle — previously "none"
  // fell into the effort branch and left thinking:enabled untouched, so the button
  // never actually disabled thinking. (Endpoints that force thinking server-side —
  // e.g. the Zhipu coding plan — will still emit reasoning regardless.)
  if (reasoning) p = { ...p, ...resolveReasoningMode(reasoning, p.model, specForModel) }

  const cwd = _cwd() || process.cwd()

  // Sync the live mid-turn flag from the session slot (CLI parity — autoApprove is a
  // session-level slot field, not a VS Code setting). runAgent receives a GETTER: the
  // agent loop and the permission gate re-read it every iteration, so approve-all /
  // the AUTO button take effect immediately mid-turn.
  panel._autoApprove = panel._activeData(turnSlot)?.autoApprove ?? false

  text = injectAtRefs(text, cwd)

  // Load BOTH persisted lines. fullHistory = human line (never-compacted, all real messages —
  // user/assistant text carries BOTH role+type so it feeds the LLM via role AND the UI via type).
  // history = machine line (compaction shrinks it); old sessions fall back to the human line.
  // runAgent appends this turn's real messages (user input, assistant replies, tool results) to
  // both lines via its internal pushReal — chat-panel only supplies the lines and persists them.
  const loadedLines = panel._activeLines(turnSlot)
  fullHistory = loadedLines.fullHistory
  history = loadedLines.contextHistory // activeLines 已处理机读线判定（length>0 + strip 截断 args）
  // Slot snapshot comment: turnSlot/distillSlot are captured at function entry (above, before
  // any await) — see the 交付评审 🔴#1 note at the top of this function.
  const isFirstMessageNow = fullHistory.filter((m) => (m.type ?? m.role) === "user").length === 0
  isFirstMessage = isFirstMessageNow

  // Restore the session-scoped design token AND the session-level mode flags: engineering
  // and advisor.guard are SLOT-authoritative (2026-08-29 refactor) — config.json is only a
  // CLI-compat mirror and the setup fallback. `null` = the session never set the flag,
  // setup falls back to config (legacy slots).
  const sessionData = panel._activeData(turnSlot) ?? {}
  const engState = {
    enabled: sessionData.engineering ?? null,
    advisorGuard: sessionData.advisor?.guard ?? null,
    engDesignToken: sessionData.engDesignToken ?? null,
  }

  // Persist model selection
  const prefs = { model: modelOverride || p.model, provider: providerName, reasoning: reasoning || "" }
  saveModelPrefs(panel._context.workspaceState, prefs)

  panel._panel?.webview.postMessage({ type: "loading", loading: true })
  panel._turnActive = true
  panel._setStatus("running")
  panel._abortController?.abort()
  panel._abortController = new AbortController()

  // Token stream is forwarded live to the webview; the assistant reply is persisted by runAgent's
  // pushReal into fullHistory (no separate accumulation needed here).
  // Accumulate token usage across all LLM calls in this turn (matches CLI)
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 }
  // Agent state captured at onComplete, reused by the async onDistilled save — agent.mjs calls
  // onDistilled without args, so the persisted engineering fields ride the closure.
  let lastAgentState = {}
  // Ask a question in the panel (persistent in-chat card, never auto-dismisses) — shared
  // by the `question` tool and the turn-cap "Continue?" prompt. A native notification toast
  // (showInformationMessage) auto-dismisses after a while and resolves undefined, which can
  // leave the turn silently stopped with no way to continue or cancel.
  const askInPanel = (question, options) => new Promise((resolve) => {
    const entry = { resolve }
    panel._questionQueue.push(entry)
    panel._setStatus("waiting")
    panel._panel?.webview.postMessage({ type: "question", question, options: options ?? null })
    // Stop must release the waiting turn — an unanswered question would otherwise keep the
    // loop hung on this promise forever (user presses Stop, UI stays "running").
    const onAbort = () => {
      const i = panel._questionQueue.indexOf(entry)
      if (i >= 0) panel._questionQueue.splice(i, 1)
      panel._panel?.webview.postMessage({ type: "questionCancelled" })
      resolve(null)
    }
    if (panel._abortController?.signal.aborted) onAbort()
    else panel._abortController?.signal.addEventListener("abort", onAbort, { once: true })
  })

  // Callbacks shared by the initial run and the interrupt-resume run (extracted so
  // they can't drift apart).
  const buildCallbacks = () => ({
    onToken: (tok) => { panel._panel?.webview.postMessage({ type: "token", text: tok }) },
    onReasoning: (r) => { panel._panel?.webview.postMessage({ type: "reasoning", text: r }) },
    // Machine-only sub-turn boundary (advisor/verify/pending-task guard pushback
    // + continue): the webview resets its block pointers so the next reasoning/
    // content starts fresh — covers non-thinking models too (no reasoning stream
    // to trigger the webview's heuristic).
    onSubTurnBreak: () => { panel._panel?.webview.postMessage({ type: "turnBreak" }) },
    onTaskUpdate: (tasks) => {
      const done = tasks.filter((t) => t.status === "done").length
      const inProgress = tasks.filter((t) => t.status === "in_progress").length
      const pending = tasks.filter((t) => t.status === "pending").length
      panel._panel?.webview.postMessage({ type: "taskProgress", done, inProgress, pending, total: tasks.length, items: tasks })
    },
    onPlanMode: (active) => { panel._panel?.webview.postMessage({ type: "planMode", active }); panel._setPlanMode(active).catch(() => {}) },
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
    onToolResult: (n, r, id) => {
      const text = (r || "").slice(0, 64 * 1024)
      // Verified workspace-real paths ride along so the webview can linkify them.
      const links = extractFileLinks(cwd, text)
      panel._panel?.webview.postMessage({ type: "toolResult", name: n, text, id, links })
    },
    // Live output streaming (bash etc.) — chunks append to the running tool card.
    onToolOutput: (n, chunk, id) => panel._panel?.webview.postMessage({ type: "toolOutput", name: n, text: chunk, id }),
    onToolPanel: (name, chunk) => panel._panel?.webview.postMessage(toolPanelPayload(name, chunk)),
    onComplete: (content, agentState) => {
      lastAgentState = agentState ?? {}
      panel._saveLines(fullHistory, history, { activeProvider: providerName, ...agentState }, turnSlot)
      panel._panel?.webview.postMessage({ type: "complete" })
      panel._pushSessions()
      // Native notification when the user is in another window (no-op when focused).
      notifyCompletionIfUnfocused()
    },
    // Distillation finished and the machine line was REPLACED by the compressed version — the
    // onComplete save above holds the pre-shrink line, so persist again (FR3/AC5). Slot guard:
    // a session switch since this turn started means the shrink belongs to the OLD session —
    // never write it into the new one (AC6). Silent (N3): a save failure must not surface.
    onDistilled: () => {
      if (panel._slot !== distillSlot) return
      try { panel._saveLines(fullHistory, history, { activeProvider: providerName, ...lastAgentState }, distillSlot) }
      catch (e) { console.error("[chat-panel] distill save failed:", e.message) }
    },
    onPermissionRequired: permissionGate(panel),
    onQuestion: (question, options) => askInPanel(question, options),
  })
  const runOpts = (resume) => ({ mcpServers: getMcpServers(), images, skills: loadSkills(cwd), history, fullHistory, engState, injections: [collectEditorInjection(cwd)].filter(Boolean), resume, planMode: panel._activeData(turnSlot)?.planMode ?? false, distillState: panel._distillState, distillSignal: panel._distillController?.signal, engPersist: { cwd, slot: turnSlot } })
  // Turn-cap continue loop (CLI agent-turn.mjs parity): each ContinueError offers
  // "Continue" — unlimited, resume:true keeps history, fresh budget per run. The loop
  // also folds in the Ctrl+I interrupt resume (same rebuild-controller semantics).
  // (The entry try at the top of this function owns the guard-flag finally; exceptions
  // from the loop propagate through it and up to the message handler.)
  for (let resume = false; ; resume = true) {
    try {
      traceStop("runAgent: turn starting (no pending click)", panel._stopClickTs)
      await runAgent(p, cwd, text, buildCallbacks(), panel._abortController.signal, () => panel._autoApprove, runOpts(resume))
      traceStop("runAgent: turn ended normally", panel._stopClickTs)
      break
    } catch (e) {
      traceStop(`runAgent: threw ${e?.name} — unwinding`, panel._stopClickTs)
      // Ctrl+I interrupt: the abort carries reason.interrupt — rebuild the
      // controller and RESUME the same turn (the interrupt message is already in
      // history; the model continues from there). CLI agent-turn.mjs parity.
      if (e?.name === "AbortError" && e.reason?.interrupt) {
        panel._abortController = new AbortController()
        continue
      }
      if (e instanceof ContinueError) {
        // Turn-cap exhaustion: offer to continue from the current context, NOT error
        // (CLI agent-turn.mjs parity — "Ran N turns. Continue?"). Rebuilding the
        // controller + resume re-runs the loop from the SAME history (the user message
        // is already pushed; resume=true skips re-pushing it). Unlimited continues —
        // the user can Stop at any prompt.
        const willContinue = await askInPanel(
          `Agent reached ${e.turns} turns (limit). Continue from here?`,
          ["Continue", "Stop"],
        )
        if (willContinue === "Continue") {
          panel._abortController = new AbortController()
          continue
        }
        panel._panel?.webview.postMessage({ type: "aborted" })
        break
      }
      // Persist the interrupted/errored turn: the user message and any partial output
      // were already pushed into both lines by runAgent (pushReal). Without this save,
      // an abort/error loses the whole turn from disk (CLI parity: at most half a turn lost).
      // (The finally block below also saves unconditionally — CLI agent-turn.mjs parity —
      // so this catch-block save is now redundant on this path, but harmless.)
      try {
        panel._saveLines(fullHistory, history, { activeProvider: providerName }, turnSlot)
      } catch (saveErr) {
        console.error("[chat-panel] save after abort/error failed:", saveErr.message)
      }
      if (e.name === "AbortError") {
        panel._panel?.webview.postMessage({ type: "aborted" })
      } else {
        console.error("[chat-panel] runAgent failed:", e.message, "provider:", p.baseURL, "model:", p.model)
        // Friendly surface: first line only, URLs stripped (provider errors leak
        // the baseURL into the message). Full detail + provider/model folds away.
        const rawMsg = e.message || String(e)
        const text = rawMsg.split("\n")[0].replace(/https?:\/\/[^\s,)"]+/g, "[endpoint]")
        const techInfo = [rawMsg, `→ Provider: ${p.baseURL}`, `→ Model: ${p.model}`].join("\n")
        panel._panel?.webview.postMessage({ type: "error", text, techInfo })
      }
      break
    }
  }
  } finally {
    traceStop("finally: turn complete — UI released", panel._stopClickTs)
    panel._stopClickTs = null
    panel._turnActive = false
    panel._refreshStatus()
    panel._panel?.webview.postMessage({ type: "loading", loading: false })
    // Persist on EVERY exit path (CLI agent-turn.mjs finally parity — "Save session after
    // every turn (survives crashes)"): the ContinueError→Stop `break` above skips the
    // catch-block save, which stranded the whole turn (user input + N turns of work) in
    // memory only — lost on session switch/reload.
    try {
      if (fullHistory?.length) panel._saveLines(fullHistory, history, { activeProvider: providerName }, turnSlot)
    } catch (saveErr) {
      console.error("[chat-panel] save in finally failed:", saveErr.message)
    }
  }
  // Generate session title from first message (after agent completes)
  if (isFirstMessage) await panel._generateTitle(turnSlot)
}
