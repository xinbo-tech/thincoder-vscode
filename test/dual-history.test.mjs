/**
 * dual-history.test.mjs — Dual-structure session persistence (human line + machine line).
 * Verifies the VS Code extension's session-io aligns with the CLI's dual-line model:
 *   saveMessages writes both `messages` (human/fullHistory) and `contextHistory` (machine);
 *   loadSessionLines restores both, seeding the machine line from the human line for legacy files.
 * Pure Node.js, local temp dirs only — no global home dir, no VS Code, no API keys.
 * Run: node --test test/dual-history.test.mjs
 */
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { loadSessionLines, loadMessages, saveMessages, msgPath, listSessions } from "../src/extension/session-io.mjs"

const TOOL_CALL = { id: "call_1", type: "function", function: { name: "noop", arguments: "{}" } }

const dirs = []
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "thincoder-vscode-dual-"))
  dirs.push(d)
  return d
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe("session-io — dual-field persistence", () => {
  it("saveMessages writes both messages + contextHistory; loadSessionLines restores both lines", () => {
    const dir = tmp()
    const human = [
      { role: "user", type: "user", content: "q1", timestamp: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", content: "a1", tool_calls: [TOOL_CALL] },
      { role: "tool", tool_call_id: "call_1", content: "tool out" },
      { role: "assistant", type: "assistant", content: "done", timestamp: "2026-01-01T00:00:01.000Z" },
    ]
    const machine = [{ role: "user", content: "[System reminder: AUTO mode is active]" }, ...human]
    saveMessages(dir, "S", human, machine)

    // Raw file is the dual-field object shape
    const raw = JSON.parse(readFileSync(msgPath(dir, "S"), "utf8"))
    assert.ok(Array.isArray(raw.messages), "messages field persisted")
    assert.ok(Array.isArray(raw.contextHistory), "contextHistory field persisted")
    assert.equal(raw.messages.length, human.length)
    assert.equal(raw.contextHistory.length, machine.length)

    const lines = loadSessionLines(dir, "S")
    assert.equal(lines.messages.length, human.length)
    assert.equal(lines.contextHistory.length, machine.length)
    assert.ok(lines.contextHistory[0].content.startsWith("[System reminder:"), "machine line keeps injections")
    assert.ok(!lines.messages.some((m) => String(m.content).startsWith("[System reminder:")), "human line has no injections")
    // tool_calls / tool_call_id / timestamp survive the round-trip
    assert.deepEqual(lines.messages[1].tool_calls, human[1].tool_calls)
    assert.equal(lines.messages[2].tool_call_id, "call_1")
    assert.equal(lines.messages[0].timestamp, "2026-01-01T00:00:00.000Z")
  })

  it("legacy bare-array file seeds the machine line from the human line (null contextHistory)", () => {
    const dir = tmp()
    const human = [{ role: "user", type: "user", content: "legacy msg" }]
    saveMessages(dir, "S", human) // no contextHistory → legacy single-field write
    const raw = JSON.parse(readFileSync(msgPath(dir, "S"), "utf8"))
    assert.ok(Array.isArray(raw), "legacy file is a bare array")

    const lines = loadSessionLines(dir, "S")
    assert.equal(lines.messages.length, 1)
    assert.equal(lines.contextHistory, null, "legacy file reports null machine line (caller seeds from human)")
  })

  it("legacy object file with only messages yields null contextHistory", () => {
    const dir = tmp()
    saveMessages(dir, "S", [{ role: "user", content: "only human" }])
    const lines = loadSessionLines(dir, "S")
    assert.equal(lines.contextHistory, null)
    assert.deepEqual(lines.messages, [{ role: "user", content: "only human" }])
  })

  it("multimodal content (image parts) is kept verbatim through save/load", () => {
    const dir = tmp()
    const img = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
    const human = [{ role: "user", content: [{ type: "text", text: "look" }, img] }]
    saveMessages(dir, "S", human, human)
    const lines = loadSessionLines(dir, "S")
    assert.ok(Array.isArray(lines.messages[0].content), "multimodal array preserved")
    assert.deepEqual(lines.messages[0].content[1], img)
  })

  it("loadMessages (UI) returns only the human line", () => {
    const dir = tmp()
    const human = [{ role: "user", type: "user", content: "hi" }]
    const machine = [{ role: "user", content: "[System reminder: x]" }, ...human]
    saveMessages(dir, "S", human, machine)
    const msgs = loadMessages(dir, "S")
    assert.equal(msgs.length, human.length, "UI line excludes machine injections")
    assert.ok(!msgs.some((m) => String(m.content).startsWith("[System reminder:")))
  })

  it("missing session file returns empty lines", () => {
    const dir = tmp()
    const lines = loadSessionLines(dir, "nonexistent")
    assert.deepEqual(lines.messages, [])
    assert.equal(lines.contextHistory, null)
  })
})

describe("session-io — listSessions (filesystem as source of truth)", () => {
  it("decodes base64url filenames to session names, ordered by mtime (creation order)", () => {
    const dir = tmp()
    saveMessages(dir, "Session 2", [{ role: "user", content: "b" }])
    saveMessages(dir, "Session 1", [{ role: "user", content: "a" }])
    // Force deterministic mtimes: Session 1 older than Session 2
    utimesSync(msgPath(dir, "Session 1"), new Date(1000), new Date(1000))
    utimesSync(msgPath(dir, "Session 2"), new Date(2000), new Date(2000))
    assert.deepEqual(listSessions(dir), ["Session 1", "Session 2"])
  })

  it("decodes non-ASCII (e.g. Chinese) session titles", () => {
    const dir = tmp()
    saveMessages(dir, "修复登录bug", [{ role: "user", content: "x" }])
    assert.deepEqual(listSessions(dir), ["修复登录bug"])
  })

  it("ignores non-.json files and returns [] for empty/missing directory", () => {
    const dir = tmp()
    writeFileSync(join(dir, "stray.txt"), "not a session")
    saveMessages(dir, "S", [{ role: "user", content: "x" }])
    assert.deepEqual(listSessions(dir), ["S"])
    assert.deepEqual(listSessions(join(dir, "does-not-exist")), [])
  })
})
