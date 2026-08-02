/**
 * session-io.mjs — session file I/O, shared format with the CLI.
 * Reads/writes ~/.thincoder/sessions/<sha1(cwd)>.json.{N,manifest} — same files the CLI uses,
 * so sessions are interoperable between the CLI and the VS Code extension.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

const CWD_HASH_LEN = 16

function sessionsDir() {
  return join(homedir(), ".thincoder", "sessions")
}

function basePath(cwd) {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, CWD_HASH_LEN)
  return join(sessionsDir(), `${hash}.json`)
}

export function slotPath(cwd, n) { return `${basePath(cwd)}.${n}` }
export function manifestPath(cwd) { return `${basePath(cwd)}.manifest` }

/** Atomic write: write to temp file then rename (same as CLI writeSessionFile). */
function writeFile(p, data) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(data), "utf8")
  try {
    renameSync(tmp, p)
  } catch {
    try { unlinkSync(p) } catch {}
    try { renameSync(tmp, p) } catch { writeFileSync(p, readFileSync(tmp, "utf8"), "utf8") }
  }
}

// ─── Manifest ───────────────────────────────────────────────

export function loadManifest(cwd) {
  try {
    const p = manifestPath(cwd)
    if (!existsSync(p)) return { slots: {}, active: null, sessionId: null }
    const m = JSON.parse(readFileSync(p, "utf8"))
    if (!m.slots) m.slots = {}
    return m
  } catch { return { slots: {}, active: null, sessionId: null } }
}

export function saveManifest(cwd, m) {
  writeFile(manifestPath(cwd), m)
}

// ─── Slot read/write ────────────────────────────────────────

/** Read a slot file. Returns parsed session data or null. */
export function loadSlot(cwd, n) {
  try {
    const p = slotPath(cwd, n)
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, "utf8"))
    if (data?.version !== 1 && data?.version !== 2) return null
    if (!Array.isArray(data.history)) return null
    return data
  } catch { return null }
}

/** Write a slot file (session data). */
export function saveSlot(cwd, n, data) {
  writeFile(slotPath(cwd, n), data)
}

/** Delete a slot file. */
export function deleteSlot(cwd, n) {
  try { unlinkSync(slotPath(cwd, n)) } catch {}
}

// ─── Slot metadata (same shape as CLI extractSlotMeta) ─────

function isRealUserMsg(m) {
  return m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[System reminder:")
}

export function extractSlotMeta(history, activeProvider, updatedAt, title = "") {
  const userMsgs = history.filter(isRealUserMsg)
  const first = userMsgs[0]?.content ?? ""
  return {
    messageCount: history.length,
    turnCount: userMsgs.length,
    firstMessage: first.slice(0, 80),
    activeProvider: activeProvider ?? "",
    updatedAt: updatedAt ?? Date.now(),
    title,
  }
}

// ─── High-level operations (mirror CLI session.mjs) ────────

/** List all slots, newest first (updatedAt desc). Same shape as CLI listSlots. */
export function listSlots(cwd) {
  const m = loadManifest(cwd)
  const active = m.active ?? null
  return Object.entries(m.slots)
    .filter(([n]) => /^\d+$/.test(n))
    .map(([n, v]) => {
      const meta = typeof v === "object" && v !== null && "ts" in v
        ? v
        : { ts: typeof v === "number" ? v : 0 }
      return {
        slot: Number(n),
        isActive: Number(n) === active,
        title: meta.title ?? "",
        turnCount: meta.turnCount ?? 0,
        messageCount: meta.messageCount ?? 0,
        firstMessage: meta.firstMessage ?? "",
        activeProvider: meta.activeProvider ?? "",
        updatedAt: meta.updatedAt ?? meta.ts,
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Switch active slot. Returns the loaded session data (null if slot doesn't exist). */
export function switchToSlot(cwd, slot) {
  const m = loadManifest(cwd)
  if (!m.slots[slot]) return null
  m.active = slot
  saveManifest(cwd, m)
  return loadSlot(cwd, slot)
}

/** Create a new session slot: allocate next free number, write empty session, mark active. */
export function newSlot(cwd) {
  const m = loadManifest(cwd)
  let slot = 1
  while (m.slots[slot]) slot++
  const data = {
    version: 2, cwd, title: "", updatedAt: Date.now(),
    history: [], contextHistory: [], display: [], tasks: [],
    goal: null, autoApprove: false, advisor: null, pendingReminders: [], sessionStart: null,
  }
  saveSlot(cwd, slot, data)
  m.slots[slot] = { ts: Date.now(), ...extractSlotMeta([], "", data.updatedAt, "") }
  m.active = slot
  saveManifest(cwd, m)
  return slot
}

/** Save session data to a slot + update manifest metadata. */
export function saveSessionToSlot(cwd, slot, data) {
  data.updatedAt = Date.now()
  saveSlot(cwd, slot, data)
  try {
    const m = loadManifest(cwd)
    m.slots[slot] = { ts: Date.now(), ...extractSlotMeta(data.history ?? [], data.activeProvider, data.updatedAt, data.title ?? "") }
    saveManifest(cwd, m)
  } catch { /* non-fatal */ }
}

/** Delete a slot + remove from manifest. Returns the new active slot (or null if none left). */
export function deleteSlotAndUpdate(cwd, slot) {
  deleteSlot(cwd, slot)
  const m = loadManifest(cwd)
  delete m.slots[slot]
  if (m.active === slot) {
    const remaining = Object.keys(m.slots).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b)
    m.active = remaining[0] ?? null
  }
  saveManifest(cwd, m)
  return m.active
}

/** Update the title of a slot (in both the slot file and the manifest). */
export function setSlotTitle(cwd, slot, title) {
  const data = loadSlot(cwd, slot)
  if (data) {
    data.title = title
    saveSlot(cwd, slot, data)
  }
  const m = loadManifest(cwd)
  if (m.slots[slot]) {
    const meta = typeof m.slots[slot] === "object" ? m.slots[slot] : { ts: 0 }
    meta.title = title
    m.slots[slot] = meta
    saveManifest(cwd, m)
  }
}

/** Get the active slot number (fall back to first available, or 1 if none). */
export function activeSlot(cwd) {
  const m = loadManifest(cwd)
  if (m.active && m.slots[m.active]) return m.active
  const slots = Object.keys(m.slots).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b)
  return slots[0] ?? 1
}

// ─── Model prefs (workspaceState, unrelated to session files) ──

/** Load model prefs from workspaceState */
export function loadModelPrefs(workspaceState) {
  try { return workspaceState.get("thincoder.modelPrefs") || {} } catch { return {} }
}

/** Save model prefs to workspaceState */
export function saveModelPrefs(workspaceState, prefs) {
  try { workspaceState.update("thincoder.modelPrefs", prefs) } catch {}
}
