/**
 * session-io-parity.test.mjs — 2026-09-01 CLI 会诊修复同步回归（VS Code session-io 对齐）：
 *  F2 覆盖防护（.bak 轮转）、F4 认领不劫持有文件旧槽、newSlot 三重选号跳过、
 *  saveManifest 条目级合并、loadSlot 保留现场（.unreadable/.corrupted）。
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as vscode from "vscode"
import { newSlot, loadSlot, saveSessionToSlot, activeSlot, slotPath, saveManifest, loadManifest, deleteSlotAndUpdate, switchToSlot, _setSessionsDirForTest, _resetSessionsDirForTest } from "../src/extension/session-io.mjs"
import { activeLines, saveLines } from "../src/extension/panel-session.mjs"

let tmp
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tc-io-parity-"))
  // 2026-09-01 advisor 🔵：sessions 目录注入 tmp——测试不再向真实 ~/.thincoder/sessions 写文件
  _setSessionsDirForTest(join(tmp, "sessions"))
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmp } }]
})
afterEach(() => { _resetSessionsDirForTest(); rmSync(tmp, { recursive: true, force: true }) })

describe("session-io parity (CLI 会诊同步)", () => {
  it("F4: activeSlot does NOT hijack a slot whose file exists (dead owner)", () => {
    // slot 1：active 被"活进程"占用（当前 PID 不同 sessionId）；slot 2：死主 + 有文件
    const s1 = newSlot(tmp)
    const s2 = newSlot(tmp)
    const m = loadManifest(tmp)
    m.slotSessions[s1] = `${process.pid}-foreign`
    m.slotSessions[s2] = "99999999-dead"
    m.active = s1
    saveManifest(tmp, m, null, { setActive: true })
    assert.ok(existsSync(slotPath(tmp, s2)), "slot 2 file exists")

    const claimed = activeSlot(tmp)
    assert.notEqual(claimed, s2, "must not reclaim a slot whose FILE exists (would resume into a stranger session)")
    const saved = JSON.parse(readFileSync(slotPath(tmp, s2), "utf8"))
    assert.equal(saved.history.length, 0, "slot 2 untouched (still the empty new session)")
  })

  it("F2: saveSessionToSlot rotates a foreign-session slot to .bak before overwriting", () => {
    const slot = newSlot(tmp)
    // 旧会话（sessionStart 属于另一会话）
    const foreign = { version: 2, cwd: tmp, title: "old", updatedAt: Date.now(), history: [{ role: "user", content: "old session" }], sessionStart: "2026-08-01T00:00:00.000Z" }
    writeFileSync(slotPath(tmp, slot), JSON.stringify(foreign))
    // 新会话（sessionStart 不同）保存 → 必须轮转 .bak（返回值透出，不枚举全局 sessions 目录）
    const fresh = { version: 2, cwd: tmp, title: "new", updatedAt: Date.now(), history: [{ role: "user", content: "brand new" }], sessionStart: "2026-08-02T00:00:00.000Z" }
    const bak = saveSessionToSlot(tmp, slot, fresh)
    assert.ok(bak && bak.includes(`.json.${slot}.bak-`), `rotation happened (got ${bak})`)
    const bakData = JSON.parse(readFileSync(bak, "utf8"))
    assert.equal(bakData.history[0].content, "old session", ".bak holds the foreign session intact")
    const saved = JSON.parse(readFileSync(slotPath(tmp, slot), "utf8"))
    assert.equal(saved.history[0].content, "brand new", "new session written")
    try { unlinkSync(bak) } catch {}
  })

  it("F2: same-session resume does NOT rotate (sessionStart matches)", () => {
    const slot = newSlot(tmp)
    const data = { version: 2, cwd: tmp, title: "x", updatedAt: Date.now(), history: [{ role: "user", content: "a" }], sessionStart: "2026-08-01T00:00:00.000Z" }
    writeFileSync(slotPath(tmp, slot), JSON.stringify(data))
    const rotated = saveSessionToSlot(tmp, slot, { ...data, history: [{ role: "user", content: "b" }] })
    assert.equal(rotated, null, "no rotation on consistent resume")
    const saved = JSON.parse(readFileSync(slotPath(tmp, slot), "utf8"))
    assert.equal(saved.history[0].content, "b", "resumed session appended normally")
  })

  it("newSlot: skips a number whose FILE exists but manifest entry is gone", () => {
    const slot = newSlot(tmp)
    // 删 manifest 条目但保留文件（模拟丢失更新）——显式 deletions 才能真正从磁盘删除
    // 条目（saveManifest 条目级合并会把已删条目从 fresh 复活回写）
    const m = loadManifest(tmp)
    delete m.slots[slot]
    saveManifest(tmp, m, { slots: [slot] })
    assert.ok(existsSync(slotPath(tmp, slot)), "file still on disk")
    const next = newSlot(tmp)
    assert.notEqual(next, slot, "must not reuse a number whose file still exists")
  })

  it("saveManifest: entry-level merge preserves concurrent changes", () => {
    const slot = newSlot(tmp)
    const m = loadManifest(tmp)
    m.slots[7] = { ts: 1, title: "foreign" }
    m.slotSessions[7] = "99999-foreign"
    saveManifest(tmp, m)
    // 我方再保存（只改自己槽的 digest）→ 对方条目保留
    const m2 = loadManifest(tmp)
    m2.slots[slot] = { ts: Date.now(), title: "mine" }
    saveManifest(tmp, m2)
    const after = loadManifest(tmp)
    assert.equal(after.slots[7].title, "foreign", "foreign slot entry survives merge")
    assert.equal(after.slotSessions[7], "99999-foreign", "foreign ownership survives merge")
  })

  it("loadSlot: invalid structure is preserved as .unreadable, not silently dropped", () => {
    const slot = newSlot(tmp)
    writeFileSync(slotPath(tmp, slot), JSON.stringify({ version: 2, cwd: tmp, title: "bad", history: "not-an-array" }))
    const data = loadSlot(tmp, slot)
    assert.equal(data, null, "invalid structure → null")
    assert.ok(existsSync(`${slotPath(tmp, slot)}.unreadable`), "invalid file preserved as .unreadable")
  })

  it("deleteSlotAndUpdate: deletions + setActive keep the pointer consistent", () => {
    const s1 = newSlot(tmp)
    const s2 = newSlot(tmp)
    const m = loadManifest(tmp)
    m.active = s1
    saveManifest(tmp, m, null, { setActive: true })
    const next = deleteSlotAndUpdate(tmp, s1)
    assert.ok(next === s2 || next === null, `active falls to the remaining slot (got ${next})`)
    const after = loadManifest(tmp)
    assert.equal(after.slots[s1], undefined, "deleted slot entry gone (no merge resurrection)")
  })

  it("F2: saveSessionToSlot rotates a v3 file regardless of sessionStart (CLI deepseek 🟡 parity)", () => {
    const slot = newSlot(tmp)
    writeFileSync(slotPath(tmp, slot), JSON.stringify({ version: 3, cwd: tmp, title: "v3", history: [{ role: "user", content: "future" }], sessionStart: null }))
    const rotated = saveSessionToSlot(tmp, slot, { version: 2, cwd: tmp, title: "old cli", history: [{ role: "user", content: "x" }], sessionStart: null })
    assert.ok(rotated && rotated.includes(`.json.${slot}.bak-`), `v3 file rotated (got ${rotated})`)
    const bakData = JSON.parse(readFileSync(rotated, "utf8"))
    assert.equal(bakData.version, 3, ".bak preserves the newer-version file")
    try { unlinkSync(rotated) } catch {}
  })

  it("switchToSlot: does NOT flip the active pointer when the slot file is missing (advisor 🟡)", () => {
    const s1 = newSlot(tmp)
    const s2 = newSlot(tmp)
    const m = loadManifest(tmp)
    m.active = s1
    saveManifest(tmp, m, null, { setActive: true })
    // 删掉 slot 2 文件（manifest 条目仍在——模拟 F2 轮转后主文件已变 .bak）
    unlinkSync(slotPath(tmp, s2))
    const data = switchToSlot(tmp, s2)
    assert.equal(data, null, "missing file → null")
    const after = loadManifest(tmp)
    assert.equal(after.active, s1, "active pointer NOT flipped to the phantom slot")
  })
})

describe("session-io cross-end parity (2026-09-01 会诊 4 模型共识)", () => {
  it("saveLines stamps sessionStart once (kimi/qwen 🔴 — F2 身份此前恒 null)", () => {
    const slot = newSlot(tmp)
    const panel = { _slot: slot }
    saveLines(panel, [{ role: "user", content: "hi", type: "user" }], [{ role: "user", content: "hi" }], {})
    const data = JSON.parse(readFileSync(slotPath(tmp, slot), "utf8"))
    assert.ok(data.sessionStart, `sessionStart stamped (got ${data.sessionStart})`)
    // 二次保存保持同一 start（不重打）
    saveLines(panel, [{ role: "user", content: "hi2", type: "user" }], [{ role: "user", content: "hi2" }], {})
    const data2 = JSON.parse(readFileSync(slotPath(tmp, slot), "utf8"))
    assert.equal(data2.sessionStart, data.sessionStart, "same-session start preserved")
  })

  it("activeLines: contextHistory:[] + non-empty history falls back to the human line (deepseek/glm/kimi 🟡)", () => {
    const slot = newSlot(tmp)
    const hist = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }]
    writeFileSync(slotPath(tmp, slot), JSON.stringify({ version: 2, cwd: tmp, history: hist, contextHistory: [], sessionStart: "2026-08-01T00:00:00.000Z" }))
    const lines = activeLines({ _slot: slot })
    assert.deepEqual(lines.contextHistory, hist, "empty machine line → fallback to full history (CLI length>0 语义)")
  })

  it("activeLines: v1 fallback strips truncated tool args (F6 镜像, deepseek/kimi/qwen 🟡)", () => {
    const slot = newSlot(tmp)
    const hist = [
      { role: "user", content: "a" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{\"x\":\"abc…" } }] },
    ]
    // v1 老文件：无 contextHistory，人类线被 slimForDisplay 截断过
    writeFileSync(slotPath(tmp, slot), JSON.stringify({ version: 1, cwd: tmp, history: hist, sessionStart: "2026-08-01T00:00:00.000Z" }))
    const lines = activeLines({ _slot: slot })
    assert.equal(lines.contextHistory[1].tool_calls[0].function.arguments, "{}", "truncated args neutralized (半截 \\uXXXX 毒化防护)")
  })

  it("loadSlot filters legacy transient injections (glm/kimi 🔴)", () => {
    const slot = newSlot(tmp)
    writeFileSync(slotPath(tmp, slot), JSON.stringify({
      version: 2, cwd: tmp,
      history: [
        { role: "user", content: "real message" },
        { role: "user", content: "[System reminder: working directory snapshot: D:\\x" },
      ],
      sessionStart: "2026-08-01T00:00:00.000Z",
    }))
    const data = loadSlot(tmp, slot)
    assert.equal(data.history.length, 1, "legacy injection filtered on read")
    assert.equal(data.history[0].content, "real message")
  })

  it("saveSessionToSlot: concurrent-append detection rotates instead of silent clobber (qwen 🔴)", () => {
    const slot = newSlot(tmp)
    const start = "2026-08-01T00:00:00.000Z"
    writeFileSync(slotPath(tmp, slot), JSON.stringify({
      version: 2, cwd: tmp, sessionStart: start,
      history: [{ role: "user", content: "cli-1" }, { role: "assistant", content: "cli-2" }, { role: "user", content: "cli-3" }],
    }))
    // 面板旧快照（1 条）回合末写回——磁盘已长到 3 条（CLI 并发追加）
    const rotated = saveSessionToSlot(tmp, slot, { version: 2, cwd: tmp, sessionStart: start, history: [{ role: "user", content: "stale" }] })
    assert.ok(rotated && rotated.includes(`.json.${slot}.bak-`), `concurrent append rotated (got ${rotated})`)
    const bakData = JSON.parse(readFileSync(rotated, "utf8"))
    assert.equal(bakData.history.length, 3, ".bak preserves the CLI's newer messages")
    try { unlinkSync(rotated) } catch {}
  })
})



