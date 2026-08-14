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

  it("renders agent numeric fields and submodel menu slots", () => {
    api.updateAgentSettings({ maxTurns: 42, subagentTurns: 7, subagentModel: "deepseek:deepseek-v4-pro" })
    const body = openPanel()
    assert.equal(body.querySelector("#ag-maxturns")?.value, "42")
    assert.equal(body.querySelector("#ag-subturns")?.value, "7")
    const slot = body.querySelector("#submodel-slot-global")
    assert.ok(slot, "submodel slot exists")
    assert.equal(slot.dataset.value, "deepseek:deepseek-v4-pro", "stored provider:model surfaces on the slot")
    assert.ok(slot.querySelector(".model-menu-btn"), "menu trigger mounted")
    for (const role of ["explore", "plan", "coder", "eng-coder"]) {
      assert.ok(body.querySelector(`#submodel-slot-${role}`), `submodel slot for ${role}`)
    }
  })

  it("submodel slot trigger opens the shared hover menu listing models", () => {
    mockModels = [
      { id: "deepseek-v4-pro", provider: "deepseek", group: "DeepSeek", label: "deepseek-v4-pro" },
      { id: "kimi-k3", provider: "kimi", group: "Kimi", label: "kimi-k3" },
    ]
    api.updateAgentSettings({ subagentModels: { coder: "deepseek:deepseek-v4-pro" } })
    const body = openPanel()
    const slot = body.querySelector("#submodel-slot-coder")
    const btn = slot.querySelector(".model-menu-btn")
    assert.equal(btn.textContent, "deepseek:deepseek-v4-pro")
    btn.click() // opens the popup
    const popup = slot.querySelector(".model-menu-popup")
    assert.ok(popup, "popup rendered")
    const items = [...popup.querySelectorAll(".dropdown-item > span:first-child")].map((x) => x.textContent)
    assert.ok(items.includes("DeepSeek") && items.includes("Kimi"), "providers as hover rows: " + items.join(","))
  })

  it("wraps verifyGuard in a .switch label (not a bare checkbox)", () => {
    api.updateAgentSettings({ verifyGuard: true })
    const body = openPanel()
    const input = body.querySelector("#ag-verifyguard")
    assert.ok(input, "verifyGuard input exists")
    assert.equal(input.closest("label")?.className, "switch", "verifyGuard is a switch toggle")
  })
})

describe("buildSettings — advisor model menu + effort", () => {
  it("renders the advisor model slot (shared hover menu) and shows current value", () => {
    api.updateAgentSettings({ advisor: { provider: "deepseek", model: "deepseek-v4-pro" } })
    const body = openPanel()
    const slot = body.querySelector("#adv-model-slot")
    assert.ok(slot, "advisor slot exists")
    assert.equal(slot.dataset.provider, "deepseek")
    assert.equal(slot.dataset.model, "deepseek-v4-pro")
    assert.ok(slot.querySelector(".model-menu-btn"), "menu trigger mounted")
  })

  it("effort dropdown appears for a thinking model with its official default preselected", () => {
    mockModels = [{ id: "glm-5.2", provider: "zhipu-plan", reasoning: ["max", "high", "low"], effortDefault: "max" }]
    api.updateAgentSettings({ advisor: { provider: "zhipu-plan", model: "glm-5.2" } })
    const body = openPanel()
    const sel = body.querySelector("#adv-effort")
    assert.ok(sel, "effort select rendered")
    assert.equal(sel.value, "max", "official default preselected")
  })

  it("no effort dropdown for non-thinking models", () => {
    mockModels = [{ id: "gpt-4o", provider: "openai", reasoning: [] }]
    api.updateAgentSettings({ advisor: { provider: "openai", model: "gpt-4o" } })
    const body = openPanel()
    assert.equal(body.querySelector("#adv-effort"), null)
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
  it("agent card auto-saves on change — no button", async () => {
    const { initSettings } = await import("../webview/settings.js")
    document.body.innerHTML = '<div id="settings-panel"><div id="settings-body"></div></div><button id="settings-btn"></button><button id="settings-close"></button>'
    const api = initSettings({ onClose: () => {}, getModels: () => [] })
    api.updateProviderStatus({ providers: {}, labels: {} })
    api.updateAgentSettings({ maxTurns: 100 })
    api.openSettings()
    let posted = null
    window._vscode = { postMessage: (m) => { if (m.type === "saveAgentSettings") posted = m } }
    const el = document.getElementById("ag-maxturns")
    el.value = "150"
    el.dispatchEvent(new window.Event("change"))
    await new Promise((r) => setTimeout(r, 600))
    assert.ok(posted, "auto-save posted after change")
    assert.equal(posted.settings.maxTurns, "150")
  })
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
          { provider: "deepseek", model: "m1", effort: "high" },
          { provider: "", model: "x" },      // dropped: no provider
          { provider: "glm", model: "  " },  // dropped: blank model
          "junk",                             // dropped: wrong shape
          { provider: "kimi", model: "kimi-k3" }, // no effort → effort:null kept explicit
        ],
      })
      let agent = loadRaw().agent
      assert.deepEqual(agent.consultModels, [
        { provider: "deepseek", model: "m1", effort: "high" },
        { provider: "kimi", model: "kimi-k3", effort: null },
      ], "junk dropped, valid kept, effort explicit (null when unset)")

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

describe("settings consult rows (model-menu)", () => {
  it("add row mounts a model-menu trigger; picking a model sets row data + effort dropdown", async () => {
    const { initSettings } = await import("../webview/settings.js")
    document.body.innerHTML = '<div id="settings-panel"><div id="settings-body"></div></div><button id="settings-btn"></button><button id="settings-close"></button>'
    const api = initSettings({ onClose: () => {}, getModels: () => [
      { id: "glm-5.2", provider: "zhipu-plan", group: "GLM", label: "glm-5.2", reasoning: ["max", "high", "low"], effortDefault: "max" },
      { id: "gpt-4o", provider: "openai", group: "OpenAI", label: "gpt-4o", reasoning: [] },
    ] })
    api.updateProviderStatus({ providers: { "zhipu-plan": { configured: true, model: "glm-5.2" }, openai: { configured: true, model: "gpt-4o" } }, labels: {} })
    api.updateAgentSettings({ maxTurns: 100 })
    api.openSettings()

    document.getElementById("consult-add").click()
    const row = document.querySelectorAll("#consult-rows .consult-row")[0]
    assert.ok(row.querySelector(".model-menu-btn"), "trigger mounted on new row")

    // simulate a pick through the mounted trigger's popup
    const btn = row.querySelector(".model-menu-btn")
    btn.click()
    const item = [...row.querySelectorAll(".model-menu-popup .submenu .dropdown-item")].find((x) => x.textContent.trim() === "glm-5.2")
    item.click()
    assert.equal(row.dataset.provider, "zhipu-plan")
    assert.equal(row.dataset.model, "glm-5.2")
    const eff = row.querySelector(".consult-effort")
    assert.ok(eff, "effort dropdown rendered for thinking model")
    assert.equal(eff.value, "max", "official default preselected")

    // collect carries effort
    const { models } = (function () {
      const collected = []
      document.querySelectorAll("#consult-rows .consult-row").forEach((r) => {
        const p = r.dataset.provider || "", m = r.dataset.model || ""
        if (p && m) collected.push({ provider: p, model: m, effort: r.querySelector(".consult-effort")?.value ?? null })
      })
      return { models: collected }
    })()
    assert.deepEqual(models, [{ provider: "zhipu-plan", model: "glm-5.2", effort: "max" }])
  })

  it("non-thinking model pick hides the effort dropdown", async () => {
    const { initSettings } = await import("../webview/settings.js")
    document.body.innerHTML = '<div id="settings-panel"><div id="settings-body"></div></div><button id="settings-btn"></button><button id="settings-close"></button>'
    const api = initSettings({ onClose: () => {}, getModels: () => [
      { id: "gpt-4o", provider: "openai", group: "OpenAI", label: "gpt-4o", reasoning: [] },
    ] })
    api.updateProviderStatus({ providers: { openai: { configured: true, model: "gpt-4o" } }, labels: {} })
    api.updateAgentSettings({ maxTurns: 100 })
    api.openSettings()
    document.getElementById("consult-add").click()
    const row = document.querySelectorAll("#consult-rows .consult-row")[0]
    row.querySelector(".model-menu-btn").click()
    ;[...row.querySelectorAll(".model-menu-popup .submenu .dropdown-item")].find((x) => x.textContent.trim() === "gpt-4o").click()
    assert.equal(row.dataset.model, "gpt-4o")
    assert.equal(row.querySelector(".consult-effort"), null, "no effort dropdown for non-thinking model")
  })
})
