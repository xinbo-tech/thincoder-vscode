/**
 * panel-session.mjs — ChatPanel session persistence + history paging (split out of
 * chat-panel.mjs). Every function takes the ChatPanel instance as `panel` and
 * mutates panel._slot / panel._autoApprove exactly like the former methods did.
 */
import { loadSlot, saveSessionToSlot, newSlot, deleteSlotAndUpdate, setSlotTitle, activeSlot, loadModelPrefs as loadStoredModelPrefs, historyWindow, listSlots, slimForDisplay, isLegacyTransient, stripTruncatedToolArgs } from "./session-io.mjs"
import { fullStatus } from "./settings.mjs"
import { migrateLegacySettings } from "./migrate-settings.mjs"
import { stripEditorInjection } from "./editor-context.mjs"
import { generateTitle as generateSessionTitle } from "./generate-title.mjs"
import { _cwd } from "./panel-messages.mjs"
import * as vscode from "vscode"

  /**
   * The slot number this panel is bound to. On first use, resolve it once from the
   * persisted active pointer (or create a slot), then keep it fixed for the panel's life.
   */
export function ensureSlot(panel) {
    if (panel._slot == null) {
      const cwd = _cwd()
      panel._slot = activeSlot(cwd)
    }
    return panel._slot
  }

  /** Current session's slot data (full session object) or null. Uses the bound slot. */
export function activeData(panel, slotOverride) {
    return loadSlot(_cwd(), slotOverride ?? ensureSlot(panel))
  }

  /** Human line (history) of the active session. */
export function activeHistory(panel) {
    return activeData(panel)?.history ?? []
  }

  /** Load both persisted lines for the active session: human (history) + machine (contextHistory). */
export function activeLines(panel, slotOverride) {
    const data = activeData(panel, slotOverride)
    const history = data?.history ?? []
    // 2026-09-01 会诊 deepseek/kimi/qwen 🟡：机读线判定与 CLI 对齐——`length > 0` 才当
    // 机读线（`contextHistory: []` 是"无机读线"而非空机器线——空机器线会静默丢全部
    // 上下文）；回退播种剥离截断 tool args（CLI F6 镜像）——旧文件恢复后把 `…` 半截
    // arguments 原样发向网关会 400（unexpected end of hex escape）。
    const ch = data?.contextHistory
    const contextHistory = (Array.isArray(ch) && ch.length > 0) ? ch : history.map(stripTruncatedToolArgs)
    return { fullHistory: history, contextHistory, sessionStart: data?.sessionStart ?? null }
  }

  /** Persist both lines to the active slot + update manifest metadata.
 *  `slotOverride`（会话切换竞态修复，2026-08-28）: 保存目标显式绑定 turn 启动时的 slot——
 *  缺省回退 ensureSlot(panel)（当前活跃）。此前每次取当前 slot，运行中切换会话后
 *  onComplete/abort 的保存会把 A 会话整轮内容写进 B 槽（GitHub #2 "输出写错会话文件"）。 */
export function saveLines(panel, fullHistory, contextHistory, extra = {}, slotOverride) {
    const cwd = _cwd()
    const slot = slotOverride ?? ensureSlot(panel)
    const existing = loadSlot(cwd, slot) ?? {}
    // Field-roundtrip contract (CLI docs/design/ARCHITECTURE.md): slot files are full-overwrite
    // writes, so any field we drop here is lost permanently. Spread ...existing so fields the
    // extension doesn't know about (activeModel, engineering, engDesignToken, ...) round-trip
    // intact, then override only what the extension actually owns.
    // Human line drops transient machine-only injections (editor context, time reminder);
    // the MACHINE line keeps them — reloading the slot must rebuild a byte-identical
    // machine line or provider prefix caches miss (CLI parity, 2026-08-16 cache-hit fix).
    const keepReal = (m) => !m.transient && !isLegacyTransient(m)
    const keepMachine = (m) => !isLegacyTransient(m)
    // advisor.guard is session-level (2026-08-29): agentState carries the LIVE guard off the
    // run's agent config, merged over the existing advisor object (provider/model/thinking are
    // config-scoped but round-trip through the slot untouched; a legacy null upgrades to an
    // object). When the run didn't speak (abort/finally saves carry no agentState), the field
    // is preserved verbatim — a session that never expressed a guard preference keeps `null`
    // and reads keep falling back to config.json.
    const existingAdvisor = typeof existing.advisor === "object" && existing.advisor !== null ? existing.advisor : {}
    const advisorOut = extra.advisorGuard !== undefined ? { ...existingAdvisor, guard: extra.advisorGuard } : (existing.advisor ?? null)
    saveSessionToSlot(cwd, slot, {
      ...existing,
      version: 2, cwd, updatedAt: Date.now(),
      title: existing.title ?? "",
      activeProvider: extra.activeProvider ?? existing.activeProvider ?? "",
      // Human line is slimmed for storage (CLI parity — session-io.slimForDisplay):
      // the never-compacted human line carried the bulk of session-file size
      // (tool args JSON / full tool results / base64 images); the machine line
      // below keeps everything byte-identical for the provider.
      history: fullHistory.filter(keepReal).map(slimForDisplay), contextHistory: contextHistory.filter(keepMachine),
      // display (the CLI's old WYSIWYG render snapshot) is DEPRECATED — the CLI no
      // longer reads or writes it (restore always rebuilds from history, lazily).
      // Clear it defensively so OLD CLI builds still fall back to history instead
      // of resuming from a stale snapshot missing every VS Code-added message.
      display: [], tasks: extra.tasks ?? existing.tasks ?? [],
      planMode: existing.planMode ?? false, goal: existing.goal ?? null,
      autoApprove: existing.autoApprove ?? false,
      advisor: advisorOut,
      // Engineering state persisted by runAgent (agentState): design token survives turns;
      // the engineering flag is slot-authoritative (2026-08-29) — config.json is the mirror.
      // `!== undefined` (not ??): a legacy slot with NO engineering field must stay field-less
      // when the run didn't speak (abort/finally saves) — hard-writing `false` here would pin
      // the session off and kill the config.json fallback (compat contract, see tests).
      engineering: extra.engineering !== undefined ? extra.engineering : existing.engineering,
      // Key-presence write (v2 2026-08-25): ?? treated an explicit null (eng(exit) cleared the
      // token) as "missing" and revived the stale slot value on the next save — a revived token
      // re-opened the parent write gate. An explicit key always wins; absent key keeps the slot.
      engDesignToken: "engDesignToken" in extra ? extra.engDesignToken : (existing.engDesignToken ?? null),
      // Key-presence write (same v2 semantics as engDesignToken): a save carrying no
      // engDesignTokens (abort/finally) keeps the slot value; an explicit null (eng exit/re-enter
      // cleared the Map, or the run had no slots) pins the field null — restore sets NO Map.
      engDesignTokens: "engDesignTokens" in extra ? extra.engDesignTokens : (existing.engDesignTokens ?? null),
      pendingReminders: existing.pendingReminders ?? [], sessionStart: existing.sessionStart ?? new Date().toISOString(),
      // 2026-09-01 会诊 kimi/qwen 🔴：sessionStart 是 F2 覆盖防护的会话身份——VS Code
      // 此前从不赋值（恒 null）→ diskStart 恒 null → F2 轮转条件永不触发（纯 VS Code
      // 会话无覆盖防护）；更糟：CLI 加载 VS Code 槽时 setup 的 `??=` 打上 CLI 自己的
      // start → 跨端保存必轮转对方现场（F2 自伤，"先占者赢"）。现在 null 时赋一次
      // （与 CLI agent/setup.mjs `_sessionStart ??=` 同语义——同会话两端打点一致，F2 放行）。
      activeModel: extra.activeModel ?? existing.activeModel ?? null,
    })
  }

export function loadModelPrefs(panel) {
    return loadStoredModelPrefs(panel._context.workspaceState)
  }

export function loadSession(panel) {
    // Session switch (webview newSession/loadSession/deleteSession, project switch, panel open):
    // abort any in-flight async distillation from the previous turn — its history arrays belong
    // to the OLD session (SEND-STALL-DISTILL review #1; onDistilled's slot check is defense in
    // depth). The next turn lazily creates a fresh controller.
    panel._distillController?.abort()
    const history = activeHistory(panel)
    // AUTO state is session-level (CLI parity) — sync the panel flag and the webview
    // toolbar button to the slot's autoApprove field on every session load/switch.
    panel._autoApprove = activeData(panel)?.autoApprove ?? false
    panel._panel?.webview.postMessage({ type: "autoApprove", value: panel._autoApprove })
    // Plan mode is also session-level — sync the toolbar button + status badge on load/switch.
    panel._panel?.webview.postMessage({ type: "planMode", active: activeData(panel)?.planMode ?? false })
    panel._panel?.webview.postMessage({ type: "clearMessages" })
    // Lazy history: only the LAST page is sent on load; older pages arrive via
    // loadOlder (webview scroll-back). idx values are global history indexes.
    const { messages, hasOlder } = historyWindow(history, null)
    sendHistoryPage(panel, messages, hasOlder, false)
    pushSessions(panel)
  }

  /** Older-history page for the webview's scroll-back lazy loading. */
export function loadOlder(panel, before) {
    const history = activeHistory(panel)
    const { messages, hasOlder } = historyWindow(history, typeof before === "number" ? before : null)
    sendHistoryPage(panel, messages, hasOlder, true)
  }

export function sendHistoryPage(panel, messages, hasOlder, older) {
    // Machine-only editor-context injections must never surface in the UI (parity
    // with the per-message strip in the old eager loader).
    const clean = messages.map((m) => {
      if (m.kind === "user") return { ...m, text: stripEditorInjection(m.text) }
      if (m.kind === "tool") return { ...m, text: m.text.slice(0, 64 * 1024) }
      return m
    })
    panel._panel?.webview.postMessage({ type: "historyPage", messages: clean, hasOlder, older })
  }

export async function newSession(panel) {
    // 会话切换竞态守卫（GitHub #2/#5，2026-08-28）：运行中禁止新建——与 applyProjectSwitch
    // 同模式（_turnActive → warning → return）。运行中放行会让旧 turn 的 stream/complete
    // 灌进新会话视图、内容落错槽。
    if (panel._turnActive) {
      vscode.window.showWarningMessage("ThinCoder: a task is running — stop it before creating a new session.")
      return
    }
    // Allocate a fresh slot, bind this panel to it, then load its (empty) content.
    panel._slot = newSlot(_cwd())
    loadSession(panel)
  }

export async function deleteSession(panel, slot) {
    // 会话切换竞态守卫（GitHub #2/#5，2026-08-28）：运行中禁止删除——运行 turn 可能正写
    // 该槽（saveLines turnSlot 绑定），删除会产生半写/误删。
    if (panel._turnActive) {
      vscode.window.showWarningMessage("ThinCoder: a task is running — stop it before deleting a session.")
      return
    }
    if (typeof slot !== "number" || slot < 1) return
    const slots = listSlots(_cwd())
    if (slots.length <= 1) return  // Keep at least one session
    const newActive = deleteSlotAndUpdate(_cwd(), slot)
    // If we deleted the slot this panel was bound to, rebind to the survivor.
    // 2026-09-01 CLI 同步：deleteSlotAndUpdate 置空 active（不替面板选"最小剩余号"——
    // 可能指向另一活进程的槽）；_slot = null → 下次保存经 ensureSlot 重新认领。
    if (slot === panel._slot) panel._slot = newActive
    loadSession(panel)
  }

export async function generateTitle(panel, slotOverride) {
    try {
      const cwd = _cwd()
      // slotOverride（会话切换竞态修复，2026-08-28）：turn 启动时捕获的槽——标题属于产生
      // 首条消息的那个会话，切走后不得给新会话改名。
      const slot = slotOverride ?? ensureSlot(panel)
      const data = loadSlot(cwd, slot)
      if (!data || data.title) return  // Already titled
      const firstUser = (data.history ?? []).find((m) => (m.type ?? m.role) === "user")
      if (!firstUser) return
      // Provider comes from persisted session data (written by _saveLines on each turn),
      // not the message (runAgent never stamps provider/model onto history entries).
      const title = await generateSessionTitle(firstUser.content, data.activeProvider || undefined)
      if (title) {
        setSlotTitle(cwd, slot, title)
        pushSessions(panel)
      }
    } catch (e) {
      console.error("[chat-panel] generateTitle failed:", e.message)
    }
  }

export function pushSessions(panel) {
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
    panel._panel?.webview.postMessage({ type: "sessions", sessions, active: ensureSlot(panel) })
  }

export async function status(panel) {
    // Ensure at least one session slot exists (shared format with the CLI)
    const cwd = _cwd()
    const slots = listSlots(cwd)
    // Resolve this panel's slot once: reuse the persisted active session, or create the first one.
    panel._slot = slots.length === 0 ? newSlot(cwd) : activeSlot(cwd)
    panel._pushProject()
    pushSessions(panel)
    loadSession(panel)
    // One-time migration of legacy key stores (SecretStorage + thincoder.providers settings)
    // into the shared ~/.thincoder/config.json. Flag-guarded, safe to call on every open.
    await migrateLegacySettings(panel._context)
    await fullStatus(panel._panel, panel._context.workspaceState, () => pushSessions(panel))
    panel._pushMcpStatus()
    const prefs = loadModelPrefs(panel)
    if (prefs.model && panel._statusBar) panel._statusBar.text = `$(hubot) ${prefs.model}`

    // Auto-check: prompt to build vector index if available but missing
    panel._maybePromptIndex()
  }
