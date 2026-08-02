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

  it("activeSlot falls back to first slot, then 1", () => {
    assert.equal(activeSlot(cwd), 1) // No manifest → 1
    newSlot(cwd)
    newSlot(cwd)
    const m = loadManifest(cwd)
    m.active = 99 // Invalid
    saveManifest(cwd, m)
    assert.equal(activeSlot(cwd), 1) // Falls back to first
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
})
