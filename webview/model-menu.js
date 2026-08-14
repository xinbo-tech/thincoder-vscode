/**
 * model-menu.js — the reusable two-level hover model menu (provider row → flyout model list).
 *
 * Extracted from chat.js's buildModelDropdown/providerRow so EVERY model selection in the
 * panel uses ONE interaction (design: docs/design/MODEL-PICKER-UNIFY.md — no native
 * dropdowns, no search box; a provider may list dozens of models).
 *
 * Usage:
 *   openModelMenu({ anchorEl, value, onPick })
 *     anchorEl — the trigger button; the menu renders inside anchorEl's positioned parent
 *     value    — { provider, model } | null (marks the ✓ row)
 *     onPick   — ({ provider, model }) => void; called once, menu closes
 */

/** Build the full dropdown DOM for a model list. */
export function buildModelMenuDropdown({ models, value, onPick, footerEntries = [] }) {
  const frag = document.createDocumentFragment()
  if (!models || models.length === 0) return frag

  const byProvider = new Map()
  for (const m of models) {
    const key = m.provider || m.group || ""
    if (!byProvider.has(key)) byProvider.set(key, { group: m.group || key, models: [] })
    byProvider.get(key).models.push(m)
  }
  // Scroll layer for the provider rows — the popup itself must stay overflow:visible
  // so the flyout submenu can extend past its right edge.
  const list = document.createElement("div")
  list.className = "model-menu-list"
  for (const [provider, { group, models: provModels }] of byProvider) {
    list.appendChild(providerRow(provider, group, provModels, value, onPick))
  }
  frag.appendChild(list)
  for (const entry of footerEntries) frag.appendChild(entry)
  return frag
}

function providerRow(provider, group, models, value, onPick) {
  const current = models.find((m) => m.id === value?.model && (m.provider || "") === (value?.provider || ""))
  const shown = current || models[0]

  const item = document.createElement("div")
  item.className = "dropdown-item has-submenu"
  item.tabIndex = 0
  item.setAttribute("role", "option")
  item.setAttribute("aria-selected", String(!!current))
  item.innerHTML = `<span>${group}</span><span class="dropdown-sub">${shown ? shown.label : ""}</span><span class="submenu-arrow">›</span>`

  const sub = document.createElement("div")
  sub.className = "dropdown submenu"
  for (const m of models) {
    const si = document.createElement("div")
    si.className = "dropdown-item"
    si.tabIndex = 0
    si.setAttribute("role", "option")
    si.setAttribute("aria-selected", String(m.id === value?.model && (m.provider || "") === (value?.provider || "")))
    si.innerHTML = `<span>${m.label}</span>${m.id === value?.model && (m.provider || "") === (value?.provider || "") ? '<span class="check">✓</span>' : ""}`
    si.addEventListener("click", (e) => { e.stopPropagation(); onPick({ provider: m.provider || provider, model: m.id }) })
    sub.appendChild(si)
  }
  item.appendChild(sub)

  // Hover opens the flyout; leaving the whole row (item + flyout) closes it.
  const open = () => { closeSiblingSubmenus(item); item.classList.add("open") }
  const close = () => item.classList.remove("open")
  item.addEventListener("mouseenter", open)
  item.addEventListener("mouseleave", close)
  // Keyboard / touch fallback: click toggles the flyout.
  item.addEventListener("click", (e) => { if (e.target.closest(".submenu")) return; e.stopPropagation(); item.classList.contains("open") ? close() : open() })
  return item
}

/** Only one provider flyout open at a time (scoped to a container). */
function closeSiblingSubmenus(except) {
  const scope = except.closest(".model-menu-root") || except.parentElement || document
  for (const el of scope.querySelectorAll(".has-submenu.open")) {
    if (el !== except) el.classList.remove("open")
  }
}

/**
 * A self-contained trigger button + popup for settings cards.
 * The popup is position:FIXED and attached to document.body — settings cards use
 * overflow:hidden (rounded corners) and the panel body scrolls (overflow-y:auto),
 * both of which would clip an absolutely-positioned child. Fixed positioning
 * escapes both; the popup closes on scroll (position would drift) and outside click.
 * Returns the trigger element (caller places it in the DOM).
 */
export function modelMenuTrigger({ label, models, value, onPick, className = "key-btn model-menu-btn" }) {
  const wrap = document.createElement("span")
  wrap.className = "model-menu-root"
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = className
  btn.textContent = label
  const popup = document.createElement("div")
  popup.className = "dropdown model-menu-popup"
  popup.style.display = "none"

  const close = () => { popup.style.display = "none" }
  // Position relative to the settings panel (a containing block with no clipping);
  // panel-body scrolls but the popup re-follows the trigger on scroll instead of closing.
  const position = () => {
    const panel = document.getElementById("settings-panel") || document.body
    const pr = panel.getBoundingClientRect()
    const r = btn.getBoundingClientRect()
    popup.style.left = Math.max(8, r.left - pr.left) + "px"
    popup.style.top = (r.bottom - pr.top + 4) + "px"
  }
  const open = () => {
    closeAllPopups()
    popup.innerHTML = ""
    popup.appendChild(buildModelMenuDropdown({ models, value, onPick: (v) => { close(); onPick(v) } }))
    const panel = document.getElementById("settings-panel") || document.body
    if (popup.parentElement !== panel) panel.appendChild(popup)
    position()
    popup.style.display = ""
  }
  const onScroll = () => { if (popup.style.display !== "none") position() }
  btn.addEventListener("click", (e) => {
    e.stopPropagation()
    bindOutsideClick()
    if (popup.style.display === "none") {
      open()
      const scroller = document.querySelector("#settings-panel .panel-body")
      scroller?.addEventListener("scroll", onScroll)
    } else {
      close()
      document.querySelector("#settings-panel .panel-body")?.removeEventListener("scroll", onScroll)
    }
  })
  wrap.appendChild(btn)
  return wrap
}

/** Close every open model-menu popup (document-level). */
export function closeAllPopups() {
  for (const el of document.querySelectorAll(".model-menu-popup")) el.style.display = "none"
}

// Click-outside closes any open popup (registered lazily — import must work pre-DOM, e.g. in tests)
let _outsideBound = false
function bindOutsideClick() {
  if (_outsideBound || typeof document === "undefined") return
  _outsideBound = true
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".model-menu-root")) closeAllPopups()
  })
}
