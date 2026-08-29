/**
 * eng-session.test.mjs — engineering + advisor.guard are SESSION-level (2026-08-29).
 * The slot file is the authority; config.json `agent.engineering` / `agent.advisor.guard`
 * is only a CLI-compat mirror. Regression root: the flag lived in global config.json,
 * which the CLI's /eng also wrote — the two ends flipped each other's engineering mode
 * ("VS Code 工程模式下模型仍委托 role='coder'").
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as vscode from "vscode"
import { newSlot, loadSlot, saveSessionToSlot, setSlotEngineering, setSlotAdvisorGuard } from "../src/extension/session-io.mjs"

let tmp
let cfgPath
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tc-eng-session-"))
  cfgPath = join(tmp, "config.json")
  // _cwd() reads vscode.workspace.workspaceFolders[0].uri.fsPath — point it at tmp
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmp } }]
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

// ─── session-io slot setters ────────────────────────────────────

describe("session-io — setSlotEngineering / setSlotAdvisorGuard", () => {
  it("engineering flag round-trips in the slot", () => {
    const slot = newSlot(tmp)
    assert.equal(setSlotEngineering(tmp, slot, true), true)
    assert.equal(loadSlot(tmp, slot).engineering, true)
    assert.equal(setSlotEngineering(tmp, slot, false), true)
    assert.equal(loadSlot(tmp, slot).engineering, false)
  })

  it("advisor guard round-trips and upgrades a legacy null advisor to an object", () => {
    const slot = newSlot(tmp)
    assert.equal(loadSlot(tmp, slot).advisor, null, "new slots ship advisor:null")
    assert.equal(setSlotAdvisorGuard(tmp, slot, true), true)
    assert.equal(loadSlot(tmp, slot).advisor.guard, true)
    assert.equal(setSlotAdvisorGuard(tmp, slot, false), true)
    assert.equal(loadSlot(tmp, slot).advisor.guard, false)
  })

  it("advisor guard preserves sibling advisor keys on merge", () => {
    const slot = newSlot(tmp)
    setSlotAdvisorGuard(tmp, slot, true)
    const data = loadSlot(tmp, slot)
    data.advisor.provider = "deepseek"
    saveSessionToSlot(tmp, slot, data)
    setSlotAdvisorGuard(tmp, slot, false)
    const after = loadSlot(tmp, slot).advisor
    assert.equal(after.guard, false)
    assert.equal(after.provider, "deepseek", "sibling keys survive the guard write")
  })

  it("returns false for an unknown slot (no crash, nothing written)", () => {
    assert.equal(setSlotEngineering(tmp, 99, true), false)
    assert.equal(setSlotAdvisorGuard(tmp, 99, true), false)
  })
})

// ─── panel-messages dual write (slot first, config mirror second) ──

describe("panel-messages — setAdvisorGuard / setEngineeringEnabled dual write", () => {
  it("setAdvisorGuard writes the slot AND the config mirror", async () => {
    const { _setConfigPathForTest, loadRaw } = await import("../src/config-io.mjs")
    _setConfigPathForTest(cfgPath)
    const { handlePanelMessage } = await import("../src/extension/panel-messages.mjs")
    const slot = newSlot(tmp)
    const panel = { _ensureSlot: () => slot, _pushSettingsLight: () => {} }
    await handlePanelMessage(panel, { type: "setAdvisorGuard", value: true })
    assert.equal(loadSlot(tmp, slot).advisor.guard, true, "slot (authority) written")
    assert.equal(loadRaw().agent.advisor.guard, true, "config mirror written")
  })

  it("setEngineeringEnabled writes the slot AND the config mirror", async () => {
    const { _setConfigPathForTest, loadRaw } = await import("../src/config-io.mjs")
    _setConfigPathForTest(cfgPath)
    const { handlePanelMessage } = await import("../src/extension/panel-messages.mjs")
    const slot = newSlot(tmp)
    const panel = { _ensureSlot: () => slot, _pushSettingsLight: () => {} }
    await handlePanelMessage(panel, { type: "setEngineeringEnabled", value: true })
    assert.equal(loadSlot(tmp, slot).engineering, true, "slot (authority) written")
    assert.equal(loadRaw().agent.engineering, true, "config mirror written")
  })

  it("slot write failure does not block the config mirror write", async () => {
    const { _setConfigPathForTest, loadRaw } = await import("../src/config-io.mjs")
    _setConfigPathForTest(cfgPath)
    const { handlePanelMessage } = await import("../src/extension/panel-messages.mjs")
    // Panel without _ensureSlot → the slot write throws inside its try → caught.
    const panel = { _pushSettingsLight: () => {} }
    await handlePanelMessage(panel, { type: "setEngineeringEnabled", value: true })
    assert.equal(loadRaw().agent.engineering, true, "config mirror still written")
  })
})

// ─── setup schema: slot wins, config fallback (compat lock) ─────

/** Pin config-io at a sandbox path; returns a loader for the module under test. */
async function pinnedConfig(agentConfig) {
  const { _setConfigPathForTest } = await import("../src/config-io.mjs")
  _setConfigPathForTest(cfgPath)
  writeFileSync(cfgPath, JSON.stringify({ agent: agentConfig }), "utf8")
}

describe("setupAgentRun — engineering/advisor.guard slot authority (2026-08-29)", () => {
  it("slot engineering=true + config false → eng-coder schema (THE reported bug, locked)", async () => {
    await pinnedConfig({ engineering: false, advisor: { guard: false } })
    const { setupAgentRun } = await import("../src/agent/setup.mjs")
    const { agent, toolSchemas } = await setupAgentRun({
      provider: { name: "t", model: "deepseek-v4-pro" },
      cwd: tmp,
      input: "hi",
      opts: { engState: { enabled: true, advisorGuard: null, engDesignToken: null } },
      depth: 0, role: null, getAuto: () => true,
    })
    assert.equal(agent.config.agent.engineering, true, "slot value wins over config")
    const sub = toolSchemas.find((s) => s.function.name === "subagent")
    const roles = sub.function.parameters.properties.role.enum
    assert.ok(roles.includes("eng-coder"), "engineering schema advertises eng-coder")
    assert.ok(!roles.includes("coder"), "engineering schema hides coder")
  })

  it("slot WITHOUT fields + config true → falls back to config (legacy compat lock)", async () => {
    await pinnedConfig({ engineering: true, advisor: { guard: true } })
    const { setupAgentRun } = await import("../src/agent/setup.mjs")
    const { agent, toolSchemas } = await setupAgentRun({
      provider: { name: "t", model: "deepseek-v4-pro" },
      cwd: tmp,
      input: "hi",
      opts: { engState: { enabled: null, advisorGuard: null, engDesignToken: null } },
      depth: 0, role: null, getAuto: () => true,
    })
    assert.equal(agent.config.agent.engineering, true, "config fallback preserved for legacy slots")
    const sub = toolSchemas.find((s) => s.function.name === "subagent")
    assert.ok(sub.function.parameters.properties.role.enum.includes("eng-coder"))
    assert.equal(agent.config.advisor.guard, true, "advisor guard falls back to config")
  })

  it("slot advisorGuard=false + config guard=true → session off wins (explicit false ≠ unset)", async () => {
    await pinnedConfig({ engineering: false, advisor: { guard: true } })
    const { setupAgentRun } = await import("../src/agent/setup.mjs")
    const { agent } = await setupAgentRun({
      provider: { name: "t", model: "deepseek-v4-pro" },
      cwd: tmp,
      input: "hi",
      opts: { engState: { enabled: null, advisorGuard: false, engDesignToken: null } },
      depth: 0, role: null, getAuto: () => true,
    })
    assert.equal(agent.config.advisor.guard, false, "an explicit session false beats config true")
  })
})

// ─── agentState → saveLines persistence (turn-end slot write) ───

describe("agentState → ChatPanel._saveLines — slot persistence", () => {
  it("persists engineering + advisor.guard from the run's agent state, merging sibling advisor keys", async () => {
    const { ChatPanel } = await import("../src/extension/chat-panel.mjs")
    const { agentState } = await import("../src/agent/run-helpers.mjs")
    const { saveSessionToSlot } = await import("../src/extension/session-io.mjs")
    const panel = new ChatPanel({
      globalStorageUri: { fsPath: tmp },
      workspaceState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    })
    // Seed a CLI-written advisor object with config-scoped keys (provider/model round-trip
    // through the slot untouched) — then a VS Code turn carrying agentState merges over it.
    const lines = [{ role: "user", content: "hi", type: "user" }]
    saveSessionToSlot(tmp, 1, { version: 2, cwd: tmp, title: "", updatedAt: Date.now(), history: lines, advisor: { provider: "deepseek", model: "m" } })
    const fakeAgent = { config: { agent: { engineering: true }, advisor: { guard: true, provider: "deepseek" } }, _engDesignToken: null }
    panel._saveLines(lines, lines, { activeProvider: "deepseek", ...agentState(fakeAgent) })
    const data = loadSlot(tmp, 1)
    assert.equal(data.engineering, true, "engineering persisted from agentState")
    assert.equal(data.advisor.guard, true, "guard persisted from agentState")
    assert.equal(data.advisor.provider, "deepseek", "sibling advisor keys round-trip")
  })

  it("a run that never speaks (abort save) keeps a legacy slot field-less — config fallback survives", async () => {
    const { ChatPanel } = await import("../src/extension/chat-panel.mjs")
    const panel = new ChatPanel({
      globalStorageUri: { fsPath: tmp },
      workspaceState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    })
    // Simulate a legacy CLI slot: no engineering field at all, advisor:null
    const lines = [{ role: "user", content: "hi", type: "user" }]
    panel._saveLines(lines, lines, { activeProvider: "deepseek" })
    const data = loadSlot(tmp, 1)
    assert.equal("engineering" in data, false, "no engineering field pinned by an abort save")
    assert.equal(data.advisor, null, "advisor stays null — config fallback preserved")
  })

  it("eng tool toggle persists to the slot via the engPersist channel", async () => {
    const { _setConfigPathForTest, loadRaw } = await import("../src/config-io.mjs")
    _setConfigPathForTest(cfgPath)
    writeFileSync(cfgPath, JSON.stringify({ agent: { engineering: false } }), "utf8")
    const { engTool } = await import("../src/agent-tools/eng.mjs")
    const slot = newSlot(tmp)
    const agent = { config: { agent: { engineering: false } }, _pendingReminders: [], _engPersist: { cwd: tmp, slot } }
    await engTool.execute({ action: "enter" }, { agent })
    assert.equal(loadSlot(tmp, slot).engineering, true, "slot written by eng(enter)")
    assert.equal(loadRaw().agent.engineering, true, "config mirror written")
    await engTool.execute({ action: "exit" }, { agent })
    assert.equal(loadSlot(tmp, slot).engineering, false, "slot written by eng(exit)")
    assert.equal(loadRaw().agent.engineering, false)
  })

  it("eng tool without _engPersist (subagent) still flips live state and mirrors config", async () => {
    const { _setConfigPathForTest, loadRaw } = await import("../src/config-io.mjs")
    _setConfigPathForTest(cfgPath)
    writeFileSync(cfgPath, JSON.stringify({}), "utf8")
    const { engTool } = await import("../src/agent-tools/eng.mjs")
    const agent = { config: { agent: {} }, _pendingReminders: [] }
    await engTool.execute({ action: "enter" }, { agent })
    assert.equal(agent.config.agent.engineering, true, "live state flipped")
    assert.equal(loadRaw().agent.engineering, true, "config mirror written")
  })
})

// ─── settings snapshot merges the session slot values ───────────

describe("agentSettings(session) — ENG/GUARD button echo follows the slot", () => {
  it("slot values override config in the snapshot", async () => {
    const { _setConfigPathForTest } = await import("../src/config-io.mjs")
    _setConfigPathForTest(cfgPath)
    writeFileSync(cfgPath, JSON.stringify({ agent: { engineering: false, advisor: { guard: false } } }), "utf8")
    const { agentSettings } = await import("../src/extension/settings.mjs")
    const slot = newSlot(tmp)
    setSlotEngineering(tmp, slot, true)
    setSlotAdvisorGuard(tmp, slot, true)
    const s = agentSettings({ cwd: tmp, slot })
    assert.equal(s.engineering, true, "ENG button shows the session state, not global config")
    assert.equal(s.advisor.guard, true, "GUARD button shows the session state")
  })

  it("no session (or unreadable slot) → config fallback", async () => {
    const { _setConfigPathForTest } = await import("../src/config-io.mjs")
    _setConfigPathForTest(cfgPath)
    writeFileSync(cfgPath, JSON.stringify({ agent: { engineering: true, advisor: { guard: true } } }), "utf8")
    const { agentSettings } = await import("../src/extension/settings.mjs")
    const s = agentSettings(null)
    assert.equal(s.engineering, true)
    assert.equal(s.advisor.guard, true)
    const bad = agentSettings({ cwd: tmp, slot: 99 }) // unknown slot → loadSlot null → config
    assert.equal(bad.engineering, true)
    assert.equal(bad.advisor.guard, true)
  })
})
