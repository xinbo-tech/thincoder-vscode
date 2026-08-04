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
      advisor: { enabled: true, guard: true },
    })
    const raw = loadRaw()
    assert.equal(raw.agent.maxTurns, 30, "maxTurns must persist alongside advisor")
    assert.equal(raw.agent.subagentTurns, 50)
    assert.equal(raw.agent.subagentModel, "deepseek:deepseek-v4-flash")
    assert.deepEqual(raw.agent.subagentModels, { coder: "glm:glm-5.2" })
    assert.equal(raw.agent.compactThreshold, 150000)
    assert.equal(raw.agent.verifyGuard, true)
    assert.equal(raw.agent.advisor.enabled, true)
  })

  it("cleared subagentModel / empty subagentModels delete the keys", () => {
    writeFileSync(cfgPath, JSON.stringify({ agent: { subagentModel: "x", subagentModels: { coder: "y" }, advisor: { enabled: false } } }))
    saveAgentSettingsFromPanel({
      subagentModel: undefined,
      subagentModels: {},
      advisor: { enabled: false, guard: true },
    })
    const raw = loadRaw()
    assert.ok(!("subagentModel" in raw.agent), "cleared global must delete the key")
    assert.ok(!("subagentModels" in raw.agent), "empty subagentModels must delete the key")
  })

  it("advisor provider/model cleared when emptied; guard survives merge", () => {
    writeFileSync(cfgPath, JSON.stringify({ agent: { advisor: { enabled: true, guard: false, provider: "deepseek", model: "m1" } } }))
    saveAgentSettingsFromPanel({ advisor: { enabled: true, guard: true, provider: undefined, model: "" } })
    const raw = loadRaw()
    assert.deepEqual(raw.agent.advisor, { enabled: true, guard: true }, "cleared provider/model removed, guard updated")
    // guard not sent → previous guard survives
    saveAgentSettingsFromPanel({ advisor: { enabled: true } })
    assert.equal(loadRaw().agent.advisor.guard, true, "guard preserved when not in payload")
  })

  it("loadAgentSettings surfaces subagent fields (CLI parity)", () => {
    saveAgentSettingsFromPanel({ subagentModel: "glm:glm-5.2", subagentModels: { explore: "deepseek-v4-flash" } })
    const s = loadAgentSettings()
    assert.equal(s.subagentModel, "glm:glm-5.2")
    assert.deepEqual(s.subagentModels, { explore: "deepseek-v4-flash" })
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
