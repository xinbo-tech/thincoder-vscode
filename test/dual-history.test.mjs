import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  slotPath, manifestPath, loadManifest, saveManifest,
  loadSlot, saveSlot, deleteSlot, extractSlotMeta,
  listSlots, switchToSlot, newSlot, saveSessionToSlot,
  deleteSlotAndUpdate, setSlotTitle, activeSlot,
} from "../src/extension/session-io.mjs"

let tmp, cwd

function setup() {
  tmp = mkdtempSync(join(tmpdir(), "thincoder-vscode-test-"))
  cwd = tmp // Use the tmp dir as cwd so sessions land in a test-specific hash
}

function cleanup() {
  rmSync(tmp, { recursive: true, force: true })
}


describe("editor-context — machine-only injection (never pollutes the human line)", () => {
  it("stripEditorInjection removes a legacy [Current file: ...] tail from a user message", async () => {
    const { stripEditorInjection } = await import("../src/extension/editor-context.mjs")
    const msg = "请看一下这个配置\n\n[Current file: src/config.mjs (lines 47-47)\n```\nXinbo1234\n```]"
    assert.equal(stripEditorInjection(msg), "请看一下这个配置")
    // 无注入的消息原样
    assert.equal(stripEditorInjection("普通消息"), "普通消息")
    // 注入后仍有用户文字（多段消息）——只剥离末尾注入段
    const multi = "第一段\n\n[Current file: a.mjs (full file (first 3000 chars))\n```\ncode\n```]\n\n第二段"
    assert.equal(stripEditorInjection(multi), multi, "非末尾的注入段不动（注入总是 append 在末尾）")
  })
})

describe("session-io — shared slot format (CLI-compatible)", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("newSlot creates slot 1 with empty session and sets active", () => {
    const n = newSlot(cwd)
    assert.equal(n, 1)
    const data = loadSlot(cwd, 1)
    assert.equal(data.version, 2)
    assert.deepEqual(data.history, [])
    assert.equal(data.title, "")
    const m = loadManifest(cwd)
    assert.equal(m.active, 1)
    assert.ok(m.slots[1])
  })

  it("newSlot allocates sequential slot numbers", () => {
    newSlot(cwd)
    const n2 = newSlot(cwd)
    assert.equal(n2, 2)
    const m = loadManifest(cwd)
    assert.equal(m.active, 2)
  })

  it("saveSessionToSlot persists data + updates manifest metadata", () => {
    newSlot(cwd)
    const history = [
      { role: "user", content: "fix the login bug" },
      { role: "assistant", content: "I'll fix it." },
    ]
    saveSessionToSlot(cwd, 1, { version: 2, cwd, title: "Login fix", history, contextHistory: history, activeProvider: "deepseek" })
    const m = loadManifest(cwd)
    assert.equal(m.slots[1].title, "Login fix")
    assert.equal(m.slots[1].turnCount, 1)
    assert.equal(m.slots[1].messageCount, 2)
    assert.equal(m.slots[1].firstMessage, "fix the login bug")
    assert.equal(m.slots[1].activeProvider, "deepseek")
  })

  it("listSlots returns slots sorted by updatedAt desc (newest first)", () => {
    newSlot(cwd)
    newSlot(cwd)
    // Manually set different updatedAt
    const m = loadManifest(cwd)
    m.slots[1].updatedAt = 1000
    m.slots[2].updatedAt = 2000
    saveManifest(cwd, m)
    const slots = listSlots(cwd)
    assert.equal(slots[0].slot, 2)
    assert.equal(slots[1].slot, 1)
    assert.equal(slots[0].isActive, true)
  })

  it("switchToSlot changes active pointer and returns data", () => {
    newSlot(cwd)
    newSlot(cwd)
    const data = switchToSlot(cwd, 1)
    assert.ok(data)
    const m = loadManifest(cwd)
    assert.equal(m.active, 1)
  })

  it("switchToSlot returns null for non-existent slot", () => {
    newSlot(cwd)
    assert.equal(switchToSlot(cwd, 99), null)
  })

  it("deleteSlotAndUpdate removes slot and picks new active", () => {
    newSlot(cwd)
    newSlot(cwd)
    const newActive = deleteSlotAndUpdate(cwd, 2)
    assert.equal(newActive, 1)
    assert.equal(existsSync(slotPath(cwd, 2)), false)
    const m = loadManifest(cwd)
    assert.equal(m.slots[2], undefined)
  })

  it("setSlotTitle updates both slot file and manifest", () => {
    newSlot(cwd)
    setSlotTitle(cwd, 1, "My Title")
    const data = loadSlot(cwd, 1)
    assert.equal(data.title, "My Title")
    const m = loadManifest(cwd)
    assert.equal(m.slots[1].title, "My Title")
  })

  it("activeSlot claims a slot for this process (ensureActive semantics, same as CLI)", () => {
    assert.equal(activeSlot(cwd), 1) // No manifest → claims slot 1
    // Claim recorded in slotSessions
    const m = loadManifest(cwd)
    assert.equal(m.active, 1)
    assert.ok(m.slotSessions[1], "ownership recorded in slotSessions")
    // newSlot sets active but does NOT claim ownership (same as CLI).
    // Slot 1 is still free (ensureActive only set m.active, not m.slots[1]), so it allocates slot 1.
    const n = newSlot(cwd)
    assert.equal(n, 1)
    const m2 = loadManifest(cwd)
    assert.equal(m2.active, 1)
    // Ownership stays with the earlier ensureActive claim — newSlot didn't touch it
    assert.ok(m2.slotSessions[1], "ownership was claimed by the earlier activeSlot call")
  })

  it("activeSlot claims the existing active slot when it is unowned (avoid-collision semantics)", () => {
    newSlot(cwd)
    newSlot(cwd) // active=2, but no ownership claimed (newSlot doesn't claim, same as CLI)
    const before = loadManifest(cwd)
    assert.equal(before.slotSessions, undefined)
    // active=2 is unowned → activeSlot reuses it AND records our claim in slotSessions
    assert.equal(activeSlot(cwd), 2)
    const m = loadManifest(cwd)
    assert.equal(m.active, 2)
    assert.ok(m.slotSessions[2], "claim written for the reused active slot")
  })

  it("activeSlot avoids a slot owned by another LIVE process and allocates a new one", () => {
    newSlot(cwd) // slot 1, active=1
    // Simulate another live process owning slot 1: ppid is alive and != our pid
    const m = loadManifest(cwd)
    m.slotSessions = { 1: `${process.ppid}-999999-other` }
    saveManifest(cwd, m)
    // Our activeSlot must NOT take slot 1 (owned by a live foreign process) → allocates slot 2
    const n = activeSlot(cwd)
    assert.equal(n, 2)
    const m2 = loadManifest(cwd)
    assert.equal(m2.active, 2)
    assert.equal(m2.slotSessions[1], `${process.ppid}-999999-other`, "foreign claim left intact")
    assert.ok(m2.slotSessions[2], "our claim recorded on the new slot")
    assert.notEqual(m2.slotSessions[2].split("-")[0], String(process.ppid))
  })

  it("activeSlot reclaims a slot whose owner process is DEAD", () => {
    newSlot(cwd) // slot 1, active=1
    const m = loadManifest(cwd)
    // A pid that is almost certainly not running
    m.slotSessions = { 1: "99999999-999999-dead" }
    saveManifest(cwd, m)
    // Dead owner → reclaim slot 1 rather than allocating a new one
    assert.equal(activeSlot(cwd), 1)
    const m2 = loadManifest(cwd)
    assert.equal(m2.active, 1)
    assert.notEqual(m2.slotSessions[1], "99999999-999999-dead", "dead claim replaced by ours")
  })

  it("extractSlotMeta counts real user messages, skips system reminders", () => {
    const history = [
      { role: "user", content: "hello" },
      { role: "user", content: "[System reminder: foo]" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "world" },
    ]
    const meta = extractSlotMeta(history, "test", 5000, "T")
    assert.equal(meta.turnCount, 2)
    assert.equal(meta.messageCount, 4)
    assert.equal(meta.firstMessage, "hello")
    assert.equal(meta.title, "T")
  })

  it("slotPath and manifestPath use sha1(cwd) hash", () => {
    const sp = slotPath("/some/dir", 3)
    const mp = manifestPath("/some/dir")
    assert.ok(sp.endsWith(".3"))
    assert.ok(mp.endsWith(".manifest"))
    assert.ok(sp.includes(".thincoder"))
    assert.ok(mp.includes(".thincoder"))
  })

  it("deleteSlot removes the file without touching manifest", () => {
    newSlot(cwd)
    deleteSlot(cwd, 1)
    assert.equal(existsSync(slotPath(cwd, 1)), false)
    const m = loadManifest(cwd)
    assert.ok(m.slots[1]) // Manifest still has it (deleteSlot is low-level)
  })

  it("loadSlot returns null for missing/corrupted/version-mismatch", () => {
    assert.equal(loadSlot(cwd, 99), null)
    // Write a bad file
    saveSlot(cwd, 5, { version: 99, history: [] })
    assert.equal(loadSlot(cwd, 5), null)
  })

  it("field round-trip: CLI-owned fields (activeModel/engineering) survive a re-save", () => {
    // Contract (CLI docs/design/ARCHITECTURE.md): slot files are full-overwrite writes — any
    // field a writer drops is lost. saveSessionToSlot must persist the object it is given
    // verbatim, so a caller that spreads ...existing keeps CLI-owned fields it doesn't know
    // about. This locks the contract at the I/O boundary regardless of caller.
    newSlot(cwd)
    const cliWritten = {
      version: 2, cwd, title: "CLI session", activeProvider: "deepseek", activeModel: "deepseek-chat",
      engineering: true, engDesignToken: "tok-123",
      history: [{ role: "user", content: "hi" }], contextHistory: [{ role: "user", content: "hi" }],
      display: [], tasks: [], planMode: false, goal: null, autoApprove: false, advisor: null,
      pendingReminders: [], sessionStart: null,
    }
    saveSessionToSlot(cwd, 1, cliWritten)
    // Re-save simulating the extension overwriting the two lines it owns (spread ...existing first)
    const existing = loadSlot(cwd, 1)
    saveSessionToSlot(cwd, 1, { ...existing, history: [...existing.history, { role: "assistant", content: "hello" }] })
    const after = loadSlot(cwd, 1)
    assert.equal(after.activeModel, "deepseek-chat", "activeModel survived re-save")
    assert.equal(after.engineering, true, "engineering survived re-save")
    assert.equal(after.engDesignToken, "tok-123", "engDesignToken survived re-save")
    assert.equal(after.history.length, 2, "history line was updated")
  })
})

describe("session save — partial history persistence (slice semantics)", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("saving a sliced history removes messages + syncs the machine line", async () => {
    const slot = newSlot(cwd)
    const lines = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "tool", name: "bash", content: "out" },
    ]
    saveSessionToSlot(cwd, slot, { version: 2, cwd, title: "", activeProvider: "p", history: lines, contextHistory: lines })

    // Persist a prefix slice (both lines reseeded from the same slice).
    const kept = lines.slice(0, 2)
    saveSessionToSlot(cwd, slot, { version: 2, cwd, title: "t", activeProvider: "p", history: kept, contextHistory: kept })

    const { loadSlot } = await import("../src/extension/session-io.mjs")
    const data = loadSlot(cwd, slot)
    assert.deepEqual(data.history.map((m) => m.content), ["u1", "a1"], "human line truncated")
    assert.deepEqual(data.contextHistory.map((m) => m.content), ["u1", "a1"], "machine line reseeded from human line")
  })
})

describe("legacy short-hash migration (regression: 12→40 hash change stranded sessions)", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("migrates VS Code's historical 16-char hash (LOWERCASE drive letter)", async () => {
    const { createHash } = await import("node:crypto")
    const { writeFileSync, mkdirSync, existsSync, rmSync: rm } = await import("node:fs")
    const { homedir } = await import("node:os")
    const { slotPath } = await import("../src/extension/session-io.mjs")

    // uri.fsPath on Windows lowercases the drive letter → the legacy 16-char hash
    // was computed over the lowercase path. The migration must find it.
    const lower = cwd.replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ":")
    const legacy16 = createHash("sha1").update(lower).digest("hex").slice(0, 16)
    const dir = join(homedir(), ".thincoder", "sessions")
    mkdirSync(dir, { recursive: true })
    const legacyBase = join(dir, `${legacy16}.json`)
    writeFileSync(legacyBase, JSON.stringify({ version: 2, cwd, title: "", history: [{ role: "user", content: "legacy16" }] }))
    writeFileSync(`${legacyBase}.manifest`, JSON.stringify({ active: 1, slots: {} }))
    try {
      slotPath(cwd, 1) // triggers migration (basePath → migrateHashLength)
      const base40 = join(dir, `${createHash("sha1").update(cwd).digest("hex")}.json`)
      assert.ok(existsSync(base40), "16-char legacy migrated to 40-char base")
      assert.ok(!existsSync(legacyBase), "legacy 16-char file renamed away")
    } finally {
      const base40 = join(dir, `${createHash("sha1").update(cwd).digest("hex")}.json`)
      for (const s of ["", ".manifest", ".1"]) { try { rm(base40 + s, { force: true }) } catch {} }
    }
  })

  it("migrates the CLI's historical 12-char hash (uppercase drive letter)", async () => {
    const { createHash } = await import("node:crypto")
    const { writeFileSync, mkdirSync, existsSync, rmSync: rm } = await import("node:fs")
    const { homedir } = await import("node:os")
    const { slotPath } = await import("../src/extension/session-io.mjs")

    const legacy12 = createHash("sha1").update(cwd).digest("hex").slice(0, 12)
    const dir = join(homedir(), ".thincoder", "sessions")
    mkdirSync(dir, { recursive: true })
    const legacyBase = join(dir, `${legacy12}.json`)
    writeFileSync(legacyBase, JSON.stringify({ version: 2, cwd, title: "", history: [{ role: "user", content: "legacy12" }] }))
    try {
      slotPath(cwd, 1) // triggers migration
      const base40 = join(dir, `${createHash("sha1").update(cwd).digest("hex")}.json`)
      assert.ok(existsSync(base40), "12-char legacy migrated to 40-char base")
      assert.ok(!existsSync(legacyBase), "legacy 12-char file renamed away")
    } finally {
      const base40 = join(dir, `${createHash("sha1").update(cwd).digest("hex")}.json`)
      for (const s of ["", ".manifest", ".1"]) { try { rm(base40 + s, { force: true }) } catch {} }
    }
  })
})


