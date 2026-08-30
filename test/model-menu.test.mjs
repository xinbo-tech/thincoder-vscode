/**
 * model-menu.test.mjs — provider flyout filter + row-toggle fix (GitHub #4).
 * happy-dom (setupWebview) — real DOM events.
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { setupWebview } from "./helpers/webview-env.mjs"
import { openModelMenu, closeModelMenu } from "../webview/model-menu.js"

let env
before(() => { env = setupWebview() })
after(() => env?.cleanup())

function bigModelList(n = 560) {
  const list = []
  for (let i = 0; i < n; i++) list.push({ id: `glm-5.3-${i}`, provider: "zhipu-plan", group: "zhipu-plan", label: `glm-5.3-${i}` })
  list.push({ id: "glm-5.3-flash", provider: "zhipu-plan", group: "zhipu-plan", label: "glm-5.3-flash" })
  list.push({ id: "deepseek-v4-pro", provider: "deepseek", group: "deepseek", label: "deepseek-v4-pro" })
  return list
}

describe("model-menu provider flyout filter (GitHub #4)", () => {
  it("flyout opens with a filter box; typing narrows the list (case-insensitive substring)", () => {
    const anchor = document.createElement("button")
    anchor.getBoundingClientRect = () => ({ left: 100, top: 50, right: 200, bottom: 70, width: 100, height: 20 })
    document.body.appendChild(anchor)
    let picked = null
    openModelMenu({
      anchorEl: anchor,
      models: bigModelList(),
      value: { provider: "deepseek", model: "deepseek-v4-pro" },
      onPick: (m) => { picked = m },
    })
    // The flyout is provider-row based: dispatch mouseenter on the first provider row.
    const providerRow = document.querySelector(".mm-row")
    providerRow.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
    const flyout = document.querySelector(".mm-flyout")
    assert.ok(flyout, "hover opens the flyout")
    const filter = document.querySelector(".mm-filter")
    assert.ok(filter, "flyout carries a filter input")

    const allRows = () => flyout.querySelectorAll(".mm-row")
    // The flyout renders only the hovered provider's group (zhipu-plan = 561).
    assert.equal(allRows().length, 561)

    // Type a narrow substring → only matches remain.
    filter.value = "flash"
    filter.dispatchEvent(new Event("input", { bubbles: true }))
    const rows = allRows()
    const texts = Array.from(rows).map((r) => r.textContent)
    assert.equal(rows.length, 1, `"flash" narrows to exactly 1`)
    assert.ok(texts[0].includes("flash"), "the match is glm-5.3-flash")

    // Enter picks the highlighted match.
    filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    assert.ok(picked, "Enter picked a model")
    assert.equal(document.querySelector(".mm-overlay"), null, "menu closed after pick")
    anchor.remove()
  })

  it("filter with no matches shows the no-match hint, not stale rows", () => {
    const anchor = document.createElement("button")
    anchor.getBoundingClientRect = () => ({ left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 })
    document.body.appendChild(anchor)
    openModelMenu({ anchorEl: anchor, models: bigModelList(), value: null, onPick: () => {} })
    document.querySelector(".mm-row").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
    const filter = document.querySelector(".mm-filter")
    filter.value = "zzz-no-such-model"
    filter.dispatchEvent(new Event("input", { bubbles: true }))
    const flyout = document.querySelector(".mm-flyout")
    assert.ok(flyout.querySelector(".mm-filter-nomatch"), "no-match hint shown")
    assert.equal(flyout.querySelectorAll(".mm-row").length, 0, "zero stale rows")
    closeModelMenu()
    anchor.remove()
  })

  it("clicking an already-hover-open provider row does NOT close the flyout (toggle fix)", () => {
    const anchor = document.createElement("button")
    anchor.getBoundingClientRect = () => ({ left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 })
    document.body.appendChild(anchor)
    openModelMenu({ anchorEl: anchor, models: bigModelList(), value: null, onPick: () => {} })
    const providerRow = document.querySelector(".mm-row")
    providerRow.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
    assert.ok(document.querySelector(".mm-flyout"), "flyout open after hover")
    providerRow.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    assert.ok(document.querySelector(".mm-flyout"), "click on the row keeps the flyout open (was toggling it shut)")
    closeModelMenu()
    anchor.remove()
  })
})