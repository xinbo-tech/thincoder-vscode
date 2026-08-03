/**
 * session-io.mjs — session file I/O, shared format with the CLI.
 * Reads/writes ~/.thincoder/sessions/<sha1(cwd)>.json.{N,manifest} — same files the CLI uses,
 * so sessions are interoperable between the CLI and the VS Code extension.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { execSync } from "node:child_process"

let currentSessionId = null

/** Unique session ID for this extension-host process (same format as CLI: pid-ts-rand). */
export function getSessionId() {
  if (!currentSessionId) {
    currentSessionId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }
  return currentSessionId
}

function sessionsDir() {
  return join(homedir(), ".thincoder", "sessions")
}

/** Normalize cwd for hashing: uppercase Windows drive letter so the extension's
 *  uri.fsPath (lowercased) matches the CLI's process.cwd() hash. */
export function normalizeCwd(cwd) {
  return cwd.replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ":")
}

/** Full sha1 hex (40 chars), not truncated. Shared contract with the CLI. */
function cwdHash(cwd) {
  return createHash("sha1").update(normalizeCwd(cwd)).digest("hex")
}

/** One-time migration: rename legacy short-hash session files to the full 40-char hash.
 *  Idempotent; runs on first access per cwd.
 *  Historical hash algorithms (all sha1, none normalized the drive letter):
 *    - CLI:      sha1(cwd).slice(0, 12)      — cwd comes from process.cwd() (uppercase drive on Windows)
 *    - VS Code:  sha1(cwd).slice(0, 16)      — cwd comes from uri.fsPath (LOWERCASE drive on Windows)
 *  Plus the previous migration attempt's assumption (normalized 12 = first 12 of the full hash).
 *  Every combination is tried — a migration that only checks one candidate misses real
 *  legacy files (drive-letter case differs between CLI and VS Code historical paths). */
function migrateHashLength(cwd, fullHash) {
  const dir = sessionsDir()
  const lower = cwd.replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ":")
  const candidates = [
    createHash("sha1").update(cwd).digest("hex").slice(0, 12),
    createHash("sha1").update(cwd).digest("hex").slice(0, 16),
    createHash("sha1").update(lower).digest("hex").slice(0, 12),
    createHash("sha1").update(lower).digest("hex").slice(0, 16),
    fullHash.slice(0, 12),
  ]
  const newBase = join(dir, `${fullHash}.json`)
  let migrated = false
  for (const short of new Set(candidates)) {
    const legacyBase = join(dir, `${short}.json`)
    if (!existsSync(legacyBase) && !existsSync(`${legacyBase}.manifest`) && !existsSync(`${legacyBase}.1`)) continue
    migrated = true
    try {
      for (const suffix of ["", ".manifest", ...Array.from({ length: 64 }, (_, i) => `.${i + 1}`)]) {
        const from = legacyBase + suffix
        if (existsSync(from) && !existsSync(newBase + suffix)) renameSync(from, newBase + suffix)
      }
    } catch { /* best-effort */ }
  }
  return migrated
}

function basePath(cwd) {
  const hash = cwdHash(cwd)
  migrateHashLength(cwd, hash)
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
    if (!m.sessionId) m.sessionId = null
    return m
  } catch { return { slots: {}, active: null, sessionId: null } }
}

export function saveManifest(cwd, m) {
  m.sessionId = getSessionId()
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
        timestamp: meta.ts,
        date: new Date(meta.ts).toLocaleString(),
        updatedAt: meta.updatedAt ?? meta.ts,
        updatedDate: new Date(meta.updatedAt ?? meta.ts).toLocaleString(),
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Switch active slot. Returns the loaded session data (null if slot doesn't exist). Same as CLI switchToSlot. */
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
    planMode: false, goal: null, autoApprove: false, advisor: null, pendingReminders: [], sessionStart: null,
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
  if (m.slotSessions) delete m.slotSessions[slot]
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

/**
 * Check if a process with given PID is still alive (same as CLI session.mjs).
 * Returns false if process doesn't exist or we can't determine.
 */
function isProcessAlive(pid) {
  if (!pid || isNaN(pid)) return false
  try {
    if (process.platform === "win32") {
      const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "utf8", stdio: "pipe" })
      return output.includes(String(pid))
    }
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Claim a slot for this process and set it as active. Idempotent. Mirrors CLI ensureActive.
 * Preference order:
 *  1. The current active slot, if it is unowned / ours / its owner is dead — reuse it.
 *  2. Any slot that is unowned or owned by a dead process (reclaim).
 *  3. A brand-new slot when all are owned by live processes.
 * The owner is recorded in m.slotSessions so other processes (CLI ↔ VS Code) can
 * see which slots are taken and avoid them.
 */
function ensureActive(cwd, m) {
  const mySessionId = getSessionId()
  if (!m.slotSessions) m.slotSessions = {}
  if (m.active && m.slotSessions[m.active] === mySessionId) return

  const isFree = (slot) => {
    const owner = m.slotSessions[slot]
    if (!owner || owner === mySessionId) return true
    return !isProcessAlive(parseInt(owner.split("-")[0]))
  }

  // 1. Prefer the current active slot if we can take it (preserves "resume where you left off").
  if (m.active && m.slots[m.active] && isFree(m.active)) {
    m.slotSessions[m.active] = mySessionId
    saveManifest(cwd, m)
    return
  }

  // 2. Otherwise claim the first slot that is free.
  const allSlots = Object.keys(m.slots).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b)
  for (const slot of allSlots) {
    if (isFree(slot)) {
      m.active = slot
      m.slotSessions[slot] = mySessionId
      saveManifest(cwd, m)
      return
    }
  }

  // 3. All slots owned by live processes — allocate a new one (no limit).
  const newSlot = allSlots.length > 0 ? Math.max(...allSlots) + 1 : 1
  m.active = newSlot
  m.slotSessions[newSlot] = mySessionId
  saveManifest(cwd, m)
}

/** Get this process's active slot number, claiming one if needed (same as CLI activeSlot). */
export function activeSlot(cwd) {
  const m = loadManifest(cwd)
  ensureActive(cwd, m)
  return m.active
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
