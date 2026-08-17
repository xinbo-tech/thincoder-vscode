/**
 * welcome.test.mjs — first-run onboarding panel contract.
 * The panel is the P0 onboarding fix (previously: no guidance, users had to
 * discover the ⚙ settings themselves). Locks the DOM structure and i18n keys
 * so the panel cannot silently regress.
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { setupWebview } from "./helpers/webview-env.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
let env

before(() => {
  env = setupWebview()
  // Load the real index.html body into happy-dom (scripts/CSP placeholders are inert).
  const html = readFileSync(join(__dirname, "..", "webview", "index.html"), "utf8")
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? ""
  // Drop the module script — happy-dom would try (and fail) to load "__CHAT_URI__".
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "")
})
after(() => env?.cleanup())

describe("welcome panel — DOM structure", () => {
  it("index.html contains the onboarding panel with provider/key/actions", () => {
    for (const id of [
      "welcome-panel", "welcome-heading", "welcome-text",
      "welcome-provider", "welcome-key",
      "welcome-save-btn", "welcome-skip-btn", "welcome-settings-btn",
    ]) {
      assert.ok(document.getElementById(id), `missing #${id}`)
    }
  })

  it("index.html contains the current-project button (hidden until multi-root project push)", () => {
    const btn = document.getElementById("project-btn")
    assert.ok(btn, "missing #project-btn")
    assert.equal(btn.style.display, "none")
  })

  it("the panel is hidden by default (opts in on first providerStatus without a configured key)", () => {
    const panel = document.getElementById("welcome-panel")
    assert.equal(panel.getAttribute("aria-hidden"), "true")
    assert.equal(panel.style.display, "none")
  })
})

describe("welcome panel — i18n", () => {
  it("en and zh both carry the welcome.* keys", () => {
    for (const f of ["en", "zh"]) {
      const j = JSON.parse(readFileSync(join(__dirname, "..", "locales", `${f}.json`), "utf8"))
      for (const k of ["welcome.heading", "welcome.text", "welcome.save", "welcome.skip", "welcome.fullSettings", "settings.providerKey"]) {
        assert.ok(typeof j[k] === "string" && j[k].length > 0, `${f}.json missing ${k}`)
      }
    }
  })
})
