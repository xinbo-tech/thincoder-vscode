/**
 * settings-panel.test.mjs — panel persistence handlers (config-io.mjs, pure Node).
 * saveAgentSettingsFromPanel regression: non-advisor fields must NOT be discarded
 * when advisor is present (reported bug), cleared fields delete keys, advisor
 * guard survives merge. shellCandidates caching + saveShellSettingsFromPanel.
 */
import { describe, it, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const {
  _setConfigPathForTest, loadRaw, loadAgentSettings,
  saveAgentSettingsFromPanel, saveShellSettingsFromPanel, shellCandidates,
} = await import("../src/config-io.mjs")

let tmpDir
let cfgPath

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "thincoder-settings-"))
  cfgPath = join(tmpDir, "config.json")
  _setConfigPathForTest(cfgPath)
})

beforeEach(() => {
  if (existsSync(cfgPath)) rmSync(cfgPath)
})

after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("saveAgentSettingsFromPanel — single write channel (regression)", () => {
  it("persists non-advisor fields even when advisor is present (discard bug)", () => {
    saveAgentSettingsFromPanel({
      maxTurns: 30,
      subagentTurns: 50,
      subagentModel: "deepseek:deepseek-v4-flash",
      subagentModels: { coder: "glm:glm-5.2" },
      compactThreshold: "150000",
      verifyGuard: true,
      advisor: { guard: true },
    })
    const raw = loadRaw()
    assert.equal(raw.agent.maxTurns, 30, "maxTurns must persist alongside advisor")
    assert.equal(raw.agent.subagentTurns, 50)
    assert.equal(raw.agent.subagentModel, "deepseek:deepseek-v4-flash")
    assert.deepEqual(raw.agent.subagentModels, { coder: "glm:glm-5.2" })
    assert.equal(raw.agent.compactThreshold, 150000)
    assert.equal(raw.agent.verifyGuard, true)
    assert.equal(raw.agent.advisor.guard, true, "guard persisted")
    assert.ok(!("enabled" in raw.agent.advisor), "deprecated advisor.enabled is never written (2026-08-21)")
  })

  it("cleared subagentModel / empty subagentModels delete the keys", () => {
    writeFileSync(cfgPath, JSON.stringify({ agent: { subagentModel: "x", subagentModels: { coder: "y" }, advisor: { guard: false } } }))
    saveAgentSettingsFromPanel({
      subagentModel: undefined,
      subagentModels: {},
      advisor: { guard: true },
    })
    const raw = loadRaw()
    assert.ok(!("subagentModel" in raw.agent), "cleared global must delete the key")
    assert.ok(!("subagentModels" in raw.agent), "empty subagentModels must delete the key")
    assert.equal(raw.agent.advisor.guard, true, "advisor guard updated in the same write")
  })

  it("advisor provider/model cleared when emptied; guard survives merge; timeoutMs preserved (AGENT-PARAMS-TUNING)", () => {
    writeFileSync(cfgPath, JSON.stringify({ agent: { advisor: { guard: false, provider: "deepseek", model: "m1", timeoutMs: 300000 } } }))
    saveAgentSettingsFromPanel({ advisor: { guard: true, provider: undefined, model: "" } })
    const raw = loadRaw()
    assert.deepEqual(raw.agent.advisor, { guard: true, timeoutMs: 300000 }, "cleared provider/model removed, guard updated, timeoutMs preserved, no enabled key")
    // guard not sent → previous guard survives
    saveAgentSettingsFromPanel({ advisor: {} })
    assert.equal(loadRaw().agent.advisor.guard, true, "guard preserved when not in payload")
  })

  it("advisor guard defaults OFF when the payload carries no guard value (2026-08-21)", () => {
    saveAgentSettingsFromPanel({ advisor: {} })
    assert.equal(loadRaw().agent.advisor.guard, false, "no guard → defaults to OFF")
    assert.ok(!("enabled" in loadRaw().agent.advisor), "deprecated enabled never written")
  })

  it("loadAgentSettings surfaces subagent fields (CLI parity)", () => {
    saveAgentSettingsFromPanel({ subagentModel: "glm:glm-5.2", subagentModels: { explore: "deepseek-v4-flash" } })
    const s = loadAgentSettings()
    assert.equal(s.subagentModel, "glm:glm-5.2")
    assert.deepEqual(s.subagentModels, { explore: "deepseek-v4-flash" })
  })
})

describe("saveAgentSettingsFromPanel — advisor merge (GitHub #3 data-loss fix)", () => {
  // Disk preset written by the CLI: advisor carries provider/model plus CLI-only keys
  // (thinking/reasoningEffort) the webview payload never contains.
  const CLI_ADVISOR = {
    provider: "glm",
    model: "glm-5.2",
    thinking: { type: "enabled" },
    reasoningEffort: "high",
    timeoutMs: 600,
    guard: false,
  }

  // T1 regression (red on HEAD): the webview CHANGE-TO-SAVE payload sends
  // { advisor: { guard } } only when the model slots are empty — provider/model keys
  // MISSING (not null). The merge must backfill them (and every key it does not own)
  // from disk instead of letting saveAgentSettings replace the whole object.
  it("T1: payload with missing provider/model keys preserves the CLI-written advisor", () => {
    writeFileSync(cfgPath, JSON.stringify({ agent: { advisor: { ...CLI_ADVISOR } } }))
    saveAgentSettingsFromPanel({ advisor: { guard: true } })
    const adv = loadRaw().agent.advisor
    assert.equal(adv.guard, true, "guard updated from payload")
    assert.equal(adv.provider, "glm", "missing provider key backfilled from disk")
    assert.equal(adv.model, "glm-5.2", "missing model key backfilled from disk")
    assert.equal(adv.reasoningEffort, "high", "CLI reasoningEffort survives the merge")
    assert.deepEqual(adv.thinking, { type: "enabled" }, "CLI thinking survives the merge")
    assert.equal(adv.timeoutMs, 600, "timeoutMs preserved (existing passthrough)")
  })

  // T2: A1 sends an explicit null for a CLEARED slot (undefined keys are dropped by
  // postMessage JSON serialization). null = delete the field; everything else survives.
  it("T2: explicit null provider/model clears them, the rest of the CLI advisor survives", () => {
    writeFileSync(cfgPath, JSON.stringify({ agent: { advisor: { ...CLI_ADVISOR } } }))
    saveAgentSettingsFromPanel({ advisor: { guard: true, provider: null, model: null } })
    const adv = loadRaw().agent.advisor
    assert.ok(!("provider" in adv), "explicit null deletes provider")
    assert.ok(!("model" in adv), "explicit null deletes model")
    assert.equal(adv.guard, true)
    assert.equal(adv.reasoningEffort, "high", "CLI reasoningEffort survives the clear")
    assert.deepEqual(adv.thinking, { type: "enabled" }, "CLI thinking survives the clear")
    assert.equal(adv.timeoutMs, 600)
  })

  // T3: a payload that DOES carry provider/model is a full replacement — written as-is.
  it("T3: payload carrying provider/model writes them (full replacement path)", () => {
    writeFileSync(cfgPath, JSON.stringify({ agent: { advisor: { ...CLI_ADVISOR } } }))
    saveAgentSettingsFromPanel({ advisor: { guard: true, provider: "deepseek", model: "deepseek-v4-pro" } })
    const adv = loadRaw().agent.advisor
    assert.equal(adv.provider, "deepseek")
    assert.equal(adv.model, "deepseek-v4-pro")
    assert.equal(adv.guard, true)
    assert.equal(adv.timeoutMs, 600)
  })

  // Guard rail for the unknown-key backfill: merge copies only plain-object/scalar
  // advisor keys, never arrays or functions.
  it("unknown-key backfill skips array-valued advisor keys", () => {
    writeFileSync(cfgPath, JSON.stringify({ agent: { advisor: { ...CLI_ADVISOR, weird: ["a"] } } }))
    saveAgentSettingsFromPanel({ advisor: { guard: true } })
    const adv = loadRaw().agent.advisor
    assert.ok(!("weird" in adv), "array-valued advisor keys are not copied into the merge")
    assert.equal(adv.provider, "glm")
  })
})


describe("shell settings", () => {
  it("saveShellSettingsFromPanel writes shell; '' deletes it", () => {
    saveShellSettingsFromPanel("pwsh")
    assert.equal(loadRaw().shell, "pwsh")
    saveShellSettingsFromPanel("")
    assert.ok(!("shell" in loadRaw()), "empty clears the key")
    saveShellSettingsFromPanel(null)
    assert.ok(!("shell" in loadRaw()))
  })

  it("shellCandidates returns System default first and caches", () => {
    const c = shellCandidates()
    assert.ok(Array.isArray(c) && c.length >= 1)
    assert.equal(c[0].name, "System default")
    assert.equal(c[0].value, null)
    const c2 = shellCandidates()
    assert.equal(c2, c, "cached — same array reference")
  })
})
