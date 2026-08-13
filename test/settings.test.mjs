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
before(() => {
  env = setupWebview()
  installSettingsFixture()
  api = initSettings({ onClose: () => {} })
})
after(() => env?.cleanup())

// Reset module-level state between cases — update* REPLACES state wholesale and
// settings.js keeps it across cases, so ordering would otherwise leak.
beforeEach(() => {
  api.updateProviderStatus({})
  api.updateAgentSettings({})
  api.updateProxySettings({})
  api.updateShellCandidates({})
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

  it("renders agent numeric fields and submodel inputs", () => {
    api.updateAgentSettings({ maxTurns: 42, subagentTurns: 7, subagentModel: "coder-1" })
    const body = openPanel()
    assert.equal(body.querySelector("#ag-maxturns")?.value, "42")
    assert.equal(body.querySelector("#ag-subturns")?.value, "7")
    assert.equal(body.querySelector("#ag-submodel-global")?.value, "coder-1")
    for (const role of ["explore", "plan", "coder", "eng-coder"]) {
      assert.ok(body.querySelector(`#ag-submodel-${role}`), `missing submodel input for ${role}`)
    }
  })

  it("wraps verifyGuard in a .switch label (not a bare checkbox)", () => {
    api.updateAgentSettings({ verifyGuard: true })
    const body = openPanel()
    const input = body.querySelector("#ag-verifyguard")
    assert.ok(input, "verifyGuard input exists")
    assert.equal(input.closest("label")?.className, "switch", "verifyGuard is a switch toggle")
  })
})

describe("buildSettings — save flow (posts payload to extension)", () => {
  it("saving agent settings posts the full payload", () => {
    api.updateAgentSettings({ maxTurns: 10, verifyGuard: true, advisor: { enabled: true, guard: false } })
    openPanel()
    document.getElementById("ag-maxturns").value = "42"
    document.getElementById("ag-submodel-global").value = "coder-1"
    document.getElementById("adv-enabled").checked = false
    document.getElementById("ag-save-btn").click()

    const last = env.capturedPosts.at(-1)
    assert.equal(last.type, "saveAgentSettings")
    assert.equal(last.settings.maxTurns, "42")
    assert.equal(last.settings.subagentModel, "coder-1")
    assert.equal(last.settings.verifyGuard, true)
    assert.equal(last.settings.advisor.enabled, false)
  })
})
