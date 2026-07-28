/**
 * session-io.mjs — session file I/O and index management
 * Extracted from extension.mjs ChatPanel class.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from "node:fs"
import { join } from "node:path"

/** Encode a session name to a safe filename */
export function msgPath(msgDir, name) {
  const safe = Buffer.from(name).toString("base64url")
  return join(msgDir, `${safe}.json`)
}

/** Read messages from a session file */
export function loadMessages(msgDir, name) {
  try {
    const data = readFileSync(msgPath(msgDir, name), "utf8")
    const parsed = JSON.parse(data)
    return Array.isArray(parsed) ? parsed : (parsed.messages || [])
  } catch { return [] }
}

/** Write messages to a session file */
export function saveMessages(msgDir, name, messages) {
  try {
    mkdirSync(msgDir, { recursive: true })
    writeFileSync(msgPath(msgDir, name), JSON.stringify(messages), "utf8")
  } catch (e) { console.warn("ThinCoder: failed to save messages", e.message) }
}

/** Delete a session file */
export function deleteMessages(msgDir, name) {
  try { unlinkSync(msgPath(msgDir, name)) } catch {}
}

/** Load the session index from workspaceState */
export function loadIndex(workspaceState, sessionsKey) {
  try {
    const saved = workspaceState.get(sessionsKey)
    if (saved && typeof saved === "object" && saved.active && saved.sessions) return saved
  } catch {}
  return { active: "Session 1", sessions: { "Session 1": { title: "", count: 0, updated: "" } } }
}

/** Save the session index to workspaceState */
export function saveIndex(workspaceState, sessionsKey, s) {
  try { workspaceState.update(sessionsKey, s) } catch {}
}

/** Load or create sessions key from workspace folders */
export function sessionsKey(workspaceFolders) {
  const ws = workspaceFolders?.[0]?.uri?.fsPath || "global"
  return `thincoder.sessions.${Buffer.from(ws).toString("base64").slice(0, 32)}`
}

/** Load model prefs from workspaceState */
export function loadModelPrefs(workspaceState) {
  try { return workspaceState.get("thincoder.modelPrefs") || {} } catch { return {} }
}

/** Rename a session file */
export function renameMessages(msgDir, oldName, newName) {
  try { renameSync(msgPath(msgDir, oldName), msgPath(msgDir, newName)) } catch {}
}

/** Save model prefs to workspaceState */
export function saveModelPrefs(workspaceState, prefs) {
  try { workspaceState.update("thincoder.modelPrefs", prefs) } catch {}
}
