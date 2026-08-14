/**
 * autocomplete.js — @-autocomplete, image paste, and file upload
 * Exports initAutocomplete(ui) to wire into the chat page.
 */
import { escHtml } from "./ui.js"

/**
 * @param {object} ui
 * @param {HTMLTextAreaElement} ui.inputEl
 * @param {HTMLElement} ui.atDropdown
 * @param {object} ui.vscode — VS Code API
 * @param {Array<string>} ui.pastedImages — shared array for pasted images
 */
export function initAutocomplete({ inputEl, atDropdown, vscode, pastedImages }) {
  let _atTimer = null, _atActive = false, _atBase = ""

  function handleAtInput() {
    const pos = inputEl.selectionStart
    const text = inputEl.value.slice(0, pos)
    const atIdx = text.lastIndexOf("@")
    if (atIdx < 0) { closeAtDropdown(); return }
    const afterAt = text.slice(atIdx + 1)
    if (/\s/.test(afterAt)) { closeAtDropdown(); return }
    _atBase = text.slice(0, atIdx)
    const query = text.slice(atIdx)
    clearTimeout(_atTimer)
    _atTimer = setTimeout(() => {
      vscode.postMessage({ type: "atComplete", query, cwd: "" })
    }, 150)
  }

  function showAtDropdown(matches) {
    if (matches.length === 0) { closeAtDropdown(); return }
    atDropdown.innerHTML = matches.map((m, i) =>
      `<div class="dropdown-item${i === 0 ? " active" : ""}" data-path="${escHtml(m.path)}" tabindex="0" role="option" aria-selected="${i === 0}">
        <span class="at-file-name">${escHtml(m.name)}</span>
        <span class="at-file-path">${escHtml(m.path)}</span>
      </div>`
    ).join("")
    atDropdown.style.display = "block"
    atDropdown.setAttribute("aria-expanded", "true")
    _atActive = true
  }

  function closeAtDropdown() {
    atDropdown.style.display = "none"
    atDropdown.setAttribute("aria-expanded", "false")
    _atActive = false
    atDropdown.innerHTML = ""
    clearTimeout(_atTimer)
  }

  function insertAtRef(path) {
    const pos = inputEl.selectionStart
    const text = inputEl.value
    const before = _atBase + "@" + path
    const after = text.slice(pos)
    inputEl.value = before + " " + after
    inputEl.selectionStart = inputEl.selectionEnd = before.length + 1
    inputEl.focus()
  }

  // ── bind events ──

  inputEl.addEventListener("input", () => {
    if (!_atActive) return
    handleAtInput()
  })

  inputEl.addEventListener("keydown", (e) => {
    if (!_atActive) return
    if (e.key === "Escape") { closeAtDropdown(); e.preventDefault(); return }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const items = atDropdown.querySelectorAll(".dropdown-item")
      if (items.length === 0) return
      const cur = atDropdown.querySelector(".dropdown-item.active")
      const idx = cur ? Array.from(items).indexOf(cur) : -1
      if (e.key === "ArrowDown") {
        const next = idx + 1 < items.length ? idx + 1 : 0
        items.forEach(i => i.classList.remove("active"))
        items[next].classList.add("active")
        items[next].scrollIntoView({ block: "nearest" })
      } else {
        const prev = idx - 1 >= 0 ? idx - 1 : items.length - 1
        items.forEach(i => i.classList.remove("active"))
        items[prev].classList.add("active")
        items[prev].scrollIntoView({ block: "nearest" })
      }
      return
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const active = atDropdown.querySelector(".dropdown-item.active")
      if (active) {
        e.preventDefault()
        insertAtRef(active.dataset.path)
        closeAtDropdown()
      }
      return
    }
  })

  // Detect @ typing to activate autocomplete. After typing "@", selectionStart
  // is AFTER the @, so the @ is at pos - 1 (the previous pos - 2 checked the
  // character BEFORE the @ — never matched, so the dropdown never activated).
  inputEl.addEventListener("input", (_e) => {
    const pos = inputEl.selectionStart
    const prevChar = inputEl.value[pos - 1]
    if (prevChar === "@") {
      _atActive = true
      handleAtInput()
    }
  })

  // ── image paste ──
  document.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    let hasImage = false
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        if (!hasImage) { e.preventDefault(); hasImage = true }
        readImageFile(item.getAsFile())
      }
    }
  })

  // ── file upload ──
  const fileInput = document.getElementById("file-input")
  document.getElementById("attach-btn").addEventListener("click", () => fileInput.click())
  fileInput.addEventListener("change", () => {
    for (const file of fileInput.files) {
      if (file.type.startsWith("image/")) readImageFile(file)
    }
    fileInput.value = ""
  })

  function readImageFile(file) {
    const reader = new FileReader()
    reader.onload = () => {
      pastedImages.push(reader.result)
      renderPasteBar()
    }
    reader.readAsDataURL(file)
  }

  function renderPasteBar() {
    const bar = document.getElementById("paste-bar")
    const badge = document.getElementById("paste-badge")
    if (pastedImages.length === 0) {
      bar.style.display = "none"
      return
    }
    badge.innerHTML = pastedImages.map((_, i) =>
      `<span class="paste-chip">📎 image ${i + 1}<span class="paste-chip-del" data-idx="${i}">✕</span></span>`
    ).join(" ")
    bar.style.display = "flex"
    badge.querySelectorAll(".paste-chip-del").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation()
        const idx = parseInt(btn.dataset.idx)
        pastedImages.splice(idx, 1)
        renderPasteBar()
      })
    })
  }

  // ── expose to message handler ──
  return { showAtDropdown, closeAtDropdown }
}
