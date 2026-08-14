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
  for (const [provider, { group, models: provModels }] of byProvider) {
    frag.appendChild(providerRow(provider, group, provModels, value, onPick))
  }
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
 * Renders `btnLabel` on the trigger; opens the hover menu anchored under it.
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
  popup.appendChild(buildModelMenuDropdown({ models, value, onPick: (v) => { close(); onPick(v) } }))

  const close = () => { popup.style.display = "none" }
  const open = () => {
    closeAllPopups()
    popup.innerHTML = ""
    popup.appendChild(buildModelMenuDropdown({ models, value, onPick: (v) => { close(); onPick(v) } }))
    popup.style.display = ""
  }
  btn.addEventListener("click", (e) => { e.stopPropagation(); bindOutsideClick(); popup.style.display === "none" ? open() : close() })
  wrap.addEventListener("mouseleave", close)

  wrap.appendChild(btn)
  wrap.appendChild(popup)
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
