/**
 * panel-session.mjs — ChatPanel session persistence + history paging (split out of
 * chat-panel.mjs). Every function takes the ChatPanel instance as `panel` and
 * mutates panel._slot / panel._autoApprove exactly like the former methods did.
 */
import { loadSlot, saveSessionToSlot, newSlot, deleteSlotAndUpdate, setSlotTitle, activeSlot, loadModelPrefs as loadStoredModelPrefs, historyWindow, listSlots } from "./session-io.mjs"
import { fullStatus } from "./settings.mjs"
import { migrateLegacySettings } from "./migrate-settings.mjs"
import { stripEditorInjection } from "./editor-context.mjs"
import { generateTitle as generateSessionTitle } from "./generate-title.mjs"
import { _cwd } from "./panel-messages.mjs"

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
export function activeData(panel) {
    return loadSlot(_cwd(), ensureSlot(panel))
  }

  /** Human line (history) of the active session. */
export function activeHistory(panel) {
    return activeData(panel)?.history ?? []
  }

  /** Load both persisted lines for the active session: human (history) + machine (contextHistory). */
export function activeLines(panel) {
    const data = activeData(panel)
    const history = data?.history ?? []
    const contextHistory = Array.isArray(data?.contextHistory) ? data.contextHistory : [...history]
    return { fullHistory: history, contextHistory }
  }

  /** Persist both lines to the active slot + update manifest metadata. */
export function saveLines(panel, fullHistory, contextHistory, extra = {}) {
    const cwd = _cwd()
    const slot = ensureSlot(panel)
    const existing = loadSlot(cwd, slot) ?? {}
    // Field-roundtrip contract (CLI docs/design/ARCHITECTURE.md): slot files are full-overwrite
    // writes, so any field we drop here is lost permanently. Spread ...existing so fields the
    // extension doesn't know about (activeModel, engineering, engDesignToken, ...) round-trip
    // intact, then override only what the extension actually owns.
    // Human line drops transient machine-only injections (editor context, time reminder);
    // the MACHINE line keeps them — reloading the slot must rebuild a byte-identical
    // machine line or provider prefix caches miss (CLI parity, 2026-08-16 cache-hit fix).
    const keepReal = (m) => !m.transient
    const keepMachine = () => true
    saveSessionToSlot(cwd, slot, {
      ...existing,
      version: 2, cwd, updatedAt: Date.now(),
      title: existing.title ?? "",
      activeProvider: extra.activeProvider ?? existing.activeProvider ?? "",
      history: fullHistory.filter(keepReal), contextHistory: contextHistory.filter(keepMachine),
      // display (the CLI's old WYSIWYG render snapshot) is DEPRECATED — the CLI no
      // longer reads or writes it (restore always rebuilds from history, lazily).
      // Clear it defensively so OLD CLI builds still fall back to history instead
      // of resuming from a stale snapshot missing every VS Code-added message.
      display: [], tasks: extra.tasks ?? existing.tasks ?? [],
      planMode: existing.planMode ?? false, goal: existing.goal ?? null,
      autoApprove: existing.autoApprove ?? false, advisor: existing.advisor ?? null,
      // Engineering state persisted by runAgent (agentState): design token survives turns;
      // the engineering flag mirrors config.json so the CLI side round-trips it too.
      engineering: extra.engineering ?? existing.engineering ?? false,
      engDesignToken: extra.engDesignToken ?? existing.engDesignToken ?? null,
      pendingReminders: existing.pendingReminders ?? [], sessionStart: existing.sessionStart ?? null,
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
    // Allocate a fresh slot, bind this panel to it, then load its (empty) content.
    panel._slot = newSlot(_cwd())
    loadSession(panel)
  }

export async function deleteSession(panel, slot) {
    if (typeof slot !== "number" || slot < 1) return
    const slots = listSlots(_cwd())
    if (slots.length <= 1) return  // Keep at least one session
    const newActive = deleteSlotAndUpdate(_cwd(), slot)
    // If we deleted the slot this panel was bound to, rebind to the survivor.
    if (slot === panel._slot) panel._slot = newActive
    loadSession(panel)
  }

export async function generateTitle(panel) {
    try {
      const cwd = _cwd()
      const slot = ensureSlot(panel)
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
