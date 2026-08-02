/**
 * session-io.mjs — session file I/O and index management
 * Extracted from extension.mjs ChatPanel class.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** Encode a session name to a safe filename */
export function msgPath(msgDir, name) {
  const safe = Buffer.from(String(name)).toString("base64url")
  return join(msgDir, `${safe}.json`)
}

/** List session names from the messages directory (filesystem is the source of truth).
 *  Name = base64url-decoded filename; order = file mtime ascending (creation order). */
export function listSessions(msgDir) {
  try {
    return readdirSync(msgDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        let mtime = 0
        try { mtime = statSync(join(msgDir, f)).mtimeMs } catch {}
        return { name: Buffer.from(f.slice(0, -5), "base64url").toString("utf8"), mtime }
      })
      .filter((s) => s.name)
      .sort((a, b) => a.mtime - b.mtime)
      .map((s) => s.name)
  } catch { return [] }
}

/** Read a session file: returns { messages (human line), contextHistory (machine line) } */
export function loadSessionLines(msgDir, name) {
  try {
    const path = msgPath(msgDir, name)
    const data = readFileSync(path, "utf8")
    const parsed = JSON.parse(data)
    if (Array.isArray(parsed)) return { messages: parsed, contextHistory: null } // legacy bare array
    const messages = parsed.messages || []
    // Machine line falls back to the human line for old sessions without contextHistory.
    const contextHistory = Array.isArray(parsed.contextHistory) ? parsed.contextHistory : null
    return { messages, contextHistory }
  } catch { return { messages: [], contextHistory: null } }
}

/** Read messages from a session file (human line only — for UI rendering) */
export function loadMessages(msgDir, name) {
  return loadSessionLines(msgDir, name).messages
}

/** Write both lines to a session file: messages = human line, contextHistory = machine line */
export function saveMessages(msgDir, name, messages, contextHistory = null) {
  try {
    mkdirSync(msgDir, { recursive: true })
    const path = msgPath(msgDir, name)
    const payload = contextHistory ? { messages, contextHistory } : messages
    writeFileSync(path, JSON.stringify(payload), "utf8")
  } catch (e) { console.warn("ThinCoder: failed to save messages", e.message) }
}

/** Delete a session file */
export function deleteMessages(msgDir, name) {
  try { unlinkSync(msgPath(msgDir, name)) } catch {}
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
