/**
 * settings.test.mjs — settings panel buildSettings (happy-dom).
 * Exercises the card layout + provider rows + switch toggles + the save flow
 * via the initSettings() return value (the extension's real message-dispatch API).
 */
import { describe, it, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { setupWebview, installSettingsFixture } from "./helpers/webview-env.mjs"
import { initSettings } from "../webview/settings.js"

let env
let api
let mockModels = []
before(() => {
  env = setupWebview()
  installSettingsFixture()
  api = initSettings({ onClose: () => {}, getModels: () => mockModels })
})
after(() => env?.cleanup())

// Reset module-level state between cases — update* REPLACES state wholesale and
// settings.js keeps it across cases, so ordering would otherwise leak.
beforeEach(() => {
  mockModels = []
  api.updateProviderStatus({})
  api.updateAgentSettings({})
  api.updateProxySettings({})
  api.updateShellCandidates({})
  api.updateWebsearchSettings({})
  api.updateIndexStatus(null)
})

function openPanel() {
  api.openSettings()
  return document.getElementById("settings-body")
}

describe("buildSettings — provider cards", () => {
  it("renders a configured provider with green dot, masked key, model·url, checked proxy switch", () => {
    api.updateProviderStatus({
      providers: {
        deepseek: {
          configured: true, masked: "sk-••••abc", proxy: true,
          model: "deepseek-v4-pro", baseURL: "https://api.deepseek.com",
          isActive: true,
        },
      },
    })
    const body = openPanel()
    assert.match(body.innerHTML, /Providers/)
    assert.match(body.innerHTML, /DeepSeek/)
    assert.match(body.innerHTML, /prov-dot ok/)          // green status dot
    assert.match(body.innerHTML, /sk-••••abc/)          // masked key
    assert.match(body.innerHTML, /deepseek-v4-pro · https:\/\/api\.deepseek\.com/)
    // the deepseek proxy switch is checked (precise, not "first checked checkbox")
    assert.equal(body.querySelector('#prov-deepseek input[type="checkbox"]')?.checked, true)
  })

  it("renders an unconfigured provider with grey dot and 'Not configured'", () => {
    api.updateProviderStatus({ providers: { kimi: { configured: false } } })
    const body = openPanel()
    assert.match(body.innerHTML, /Kimi/)
    assert.match(body.innerHTML, /Not configured/)
    const dots = body.querySelectorAll(".prov-dot")
    assert.ok([...dots].some((d) => !d.className.includes("ok")), "an unconfigured provider has a grey dot")
  })
})

describe("buildSettings — switch toggles (agent / advisor)", () => {
  it("reflects verifyGuard and advisor.enabled as checked switches", () => {
    api.updateAgentSettings({ verifyGuard: true, advisor: { enabled: true, guard: true } })
    const body = openPanel()
    assert.equal(body.querySelector("#ag-verifyguard")?.checked, true)
    assert.equal(body.querySelector("#adv-enabled")?.checked, true)
    assert.equal(body.querySelector("#adv-guard")?.checked, true)
  })

  it("unchecked when verifyGuard is false", () => {
    api.updateAgentSettings({ verifyGuard: false, advisor: { enabled: false, guard: false } })
    const body = openPanel()
    assert.equal(body.querySelector("#ag-verifyguard")?.checked, false)
    assert.equal(body.querySelector("#adv-enabled")?.checked, false)
  })

  it("renders agent numeric fields and submodel selects", () => {
    api.updateAgentSettings({ maxTurns: 42, subagentTurns: 7, subagentModel: "deepseek:deepseek-v4-pro" })
    const body = openPanel()
    assert.equal(body.querySelector("#ag-maxturns")?.value, "42")
    assert.equal(body.querySelector("#ag-subturns")?.value, "7")
    assert.equal(body.querySelector("#ag-submodel-global")?.tagName, "SELECT")
    assert.equal(body.querySelector("#ag-submodel-global")?.value, "deepseek:deepseek-v4-pro")
    for (const role of ["explore", "plan", "coder", "eng-coder"]) {
      assert.equal(body.querySelector(`#ag-submodel-${role}`)?.tagName, "SELECT", `submodel select for ${role}`)
    }
  })

  it("subagent model selects list provider:model options from the model list", () => {
    mockModels = [
      { id: "deepseek-v4-pro", provider: "deepseek" },
      { id: "kimi-k3", provider: "kimi" },
    ]
    api.updateAgentSettings({ subagentModels: { coder: "deepseek:deepseek-v4-pro" } })
    const body = openPanel()
    const sel = body.querySelector("#ag-submodel-coder")
    const values = [...sel.options].map((o) => o.value)
    assert.ok(values.includes(""), "inherit option present")
    assert.ok(values.includes("deepseek:deepseek-v4-pro"))
    assert.ok(values.includes("kimi:kimi-k3"))
    assert.equal(sel.value, "deepseek:deepseek-v4-pro")
  })

  it("wraps verifyGuard in a .switch label (not a bare checkbox)", () => {
    api.updateAgentSettings({ verifyGuard: true })
    const body = openPanel()
    const input = body.querySelector("#ag-verifyguard")
    assert.ok(input, "verifyGuard input exists")
    assert.equal(input.closest("label")?.className, "switch", "verifyGuard is a switch toggle")
  })
})

describe("buildSettings — advisor provider/model dropdowns", () => {
  it("renders advisor provider/model as selects (not free-text inputs)", () => {
    api.updateAgentSettings({ advisor: { provider: "deepseek", model: "deepseek-v4-pro" } })
    const body = openPanel()
    assert.equal(body.querySelector("#adv-provider")?.tagName, "SELECT")
    assert.equal(body.querySelector("#adv-model")?.tagName, "SELECT")
  })

  it("lists only CONFIGURED providers in the advisor provider dropdown", () => {
    api.updateProviderStatus({
      providers: { deepseek: { configured: true }, kimi: { configured: true }, glm: { configured: false } },
      labels: { deepseek: "DeepSeek", kimi: "Kimi", glm: "GLM" },
    })
    const body = openPanel()
    const values = [...body.querySelector("#adv-provider").options].map((o) => o.value)
    assert.ok(values.includes(""), "inherit option present")
    assert.ok(values.includes("deepseek"))
    assert.ok(values.includes("kimi"))
    assert.ok(!values.includes("glm"), "unconfigured provider excluded")
  })

  it("populates the advisor model dropdown from the model list for the selected provider only", () => {
    mockModels = [
      { id: "deepseek-v4-pro", provider: "deepseek" },
      { id: "deepseek-chat", provider: "deepseek" },
      { id: "kimi-k3", provider: "kimi" },
    ]
    api.updateAgentSettings({ advisor: { provider: "deepseek" } })
    const body = openPanel()
    const values = [...body.querySelector("#adv-model").options].map((o) => o.value)
    assert.ok(values.includes("deepseek-v4-pro"))
    assert.ok(values.includes("deepseek-chat"))
    assert.ok(!values.includes("kimi-k3"), "other provider's model excluded")
  })
})

describe("buildSettings — web search card (Tavily)", () => {
  it("renders the Tavily key row with an Add-Key button when unset", () => {
    api.updateWebsearchSettings({ provider: "tavily", hasKey: false })
    const body = openPanel()
    assert.match(body.innerHTML, /Web Search/)
    assert.match(body.innerHTML, /Tavily/)
    assert.match(body.innerHTML, /Add Key/)
  })

  it("shows a masked key + change/delete when a key is set", () => {
    api.updateWebsearchSettings({ provider: "tavily", hasKey: true })
    const body = openPanel()
    assert.match(body.innerHTML, /\*\*\*\*/)
    assert.match(body.innerHTML, /Change/)
  })

  it("saving the key posts saveWebsearchKey", () => {
    api.updateWebsearchSettings({ provider: "tavily", hasKey: false })
    openPanel()
    window._editWebsearchKey()
    document.getElementById("input-websearch").value = "tvly-abc123"
    window._saveWebsearchKey()
    const last = env.capturedPosts.at(-1)
    assert.equal(last.type, "saveWebsearchKey")
    assert.equal(last.key, "tvly-abc123")
  })
})

describe("Add-provider custom form — fetch models & pick", () => {
  function openCustomForm() {
    api.updateProviderStatus({ presets: [] })
    const body = openPanel()
    window._toggleAddForm(true)
    document.getElementById("pa-type").value = "custom"
    window._paTypeChanged()
    return body
  }

  it("custom model is a select (not a free-text input)", () => {
    openCustomForm()
    assert.equal(document.getElementById("pa-model")?.tagName, "SELECT")
  })

  it("saving a custom provider without fetching models refuses + warns", () => {
    openCustomForm()
    document.getElementById("pa-url").value = "https://api.example.com/v1"
    const before = env.capturedPosts.filter((m) => m.type === "addProvider").length
    window._paSave()
    const after = env.capturedPosts.filter((m) => m.type === "addProvider").length
    assert.equal(after, before, "no addProvider posted without a fetched model")
    assert.match(document.getElementById("pa-conn-status").textContent, /Fetch models first/)
  })

  it("updateTestProviderResult populates the model dropdown on success", () => {
    openCustomForm()
    api.updateTestProviderResult({ ok: true, models: ["m-a", "m-b"] })
    const values = [...document.getElementById("pa-model").options].map((o) => o.value)
    assert.deepEqual(values, ["m-a", "m-b"])
    assert.match(document.getElementById("pa-conn-status").textContent, /Connected/)
  })

  it("updateTestProviderResult shows the error on failure", () => {
    openCustomForm()
    api.updateTestProviderResult({ ok: false, error: "401 Unauthorized" })
    assert.match(document.getElementById("pa-conn-status").textContent, /401/)
  })
})


describe("buildSettings — save flow (posts payload to extension)", () => {
  it("saving agent settings posts the full payload", () => {
    mockModels = [{ id: "deepseek-v4-pro", provider: "deepseek" }]
    api.updateAgentSettings({ maxTurns: 10, verifyGuard: true, advisor: { enabled: true, guard: false } })
    openPanel()
    document.getElementById("ag-maxturns").value = "42"
    document.getElementById("ag-submodel-global").value = "deepseek:deepseek-v4-pro"
    document.getElementById("adv-enabled").checked = false
    document.getElementById("ag-save-btn").click()

    const last = env.capturedPosts.at(-1)
    assert.equal(last.type, "saveAgentSettings")
    assert.equal(last.settings.maxTurns, "42")
    assert.equal(last.settings.subagentModel, "deepseek:deepseek-v4-pro")
    assert.equal(last.settings.verifyGuard, true)
    assert.equal(last.settings.advisor.enabled, false)
  })
})


// ─── consultModels settings round-trip (CONSULTATION.md) ────────

describe("consultModels panel persistence", () => {
  it("save → load round-trip: valid entries kept, junk dropped, empty clears the key", async () => {
    const { saveAgentSettingsFromPanel, loadRaw, _setConfigPathForTest } = await import("../src/config-io.mjs")
    const { mkdtempSync, writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const dir = mkdtempSync(join(tmpdir(), "thincoder-consult-cfg-"))
    const cfg = join(dir, "config.json")
    _setConfigPathForTest(cfg)
    try {
      writeFileSync(cfg, JSON.stringify({ agent: {} }), "utf8")
      saveAgentSettingsFromPanel({
        consultModels: [
          { provider: "deepseek", model: "m1" },
          { provider: "", model: "x" },      // dropped: no provider
          { provider: "glm", model: "  " },  // dropped: blank model
          "junk",                             // dropped: wrong shape
        ],
      })
      let agent = loadRaw().agent
      assert.deepEqual(agent.consultModels, [{ provider: "deepseek", model: "m1" }], "junk dropped, valid kept")

      // >5 capped
      saveAgentSettingsFromPanel({ consultModels: Array.from({ length: 7 }, (_, k) => ({ provider: "p" + k, model: "m" + k })) })
      agent = loadRaw().agent
      assert.ok(Array.isArray(agent.consultModels) && agent.consultModels.length === 5, "capped at 5, got " + agent.consultModels?.length)

      // empty array clears the key entirely
      saveAgentSettingsFromPanel({ consultModels: [] })
      agent = loadRaw().agent
      assert.equal(agent.consultModels, undefined, "empty list removes the key (consult disabled)")
    } finally {
      _setConfigPathForTest(null)
    }
  })
})


// ─── consult rows: add button wiring regression (0.1.16 hot bug) ──
// Bug: dynamic add passed the FULL provider-status object where a providers MAP
// was expected — the filter saw no .configured entries and the provider dropdown
// rendered empty. Also: binding lived inside the agSave guard — any upstream
// bind failure silently killed the add button.

describe("settings consult rows", () => {
  it("Add button appends a row whose provider dropdown lists CONFIGURED providers", async () => {
    const { initSettings } = await import("../webview/settings.js")
    document.body.innerHTML = '<div id="settings-panel"><div id="settings-body"></div></div><button id="settings-btn"></button><button id="settings-close"></button>'
    const api = initSettings({ onClose: () => {}, getModels: () => [
      { provider: "deepseek", id: "deepseek-v4-pro" },
      { provider: "zhipu-plan", id: "glm-5.2" },
    ] })
    api.updateProviderStatus({ providers: {
      deepseek: { configured: true, masked: "sk-***", model: "deepseek-v4-pro" },
      "zhipu-plan": { configured: true, masked: "sk-***", model: "glm-5.2" },
      neverused: { configured: false },
    }, labels: {} })
    api.updateAgentSettings({ maxTurns: 100 }) // consultModels absent — fresh state
    api.openSettings()

    const before = document.querySelectorAll("#consult-rows .consult-row").length
    document.getElementById("consult-add").click()
    const rows = document.querySelectorAll("#consult-rows .consult-row")
    assert.equal(rows.length, before + 1, "row appended")

    const provOpts = rows[rows.length - 1].querySelectorAll(".consult-provider option")
    const values = [...provOpts].map((o) => o.value).filter(Boolean)
    assert.ok(values.includes("deepseek") && values.includes("zhipu-plan"), "configured providers listed: " + values)
    assert.ok(!values.includes("neverused"), "unconfigured provider excluded")

    // cascade: choosing a provider populates the model dropdown
    const p = rows[rows.length - 1].querySelector(".consult-provider")
    p.value = "deepseek"
    p.dispatchEvent(new Event("change"))
    const models = [...rows[rows.length - 1].querySelectorAll(".consult-model option")].map((o) => o.value)
    assert.ok(models.includes("deepseek-v4-pro"), "model cascade works: " + models)
  })
})
