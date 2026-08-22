/**
 * search.js — in-conversation search (Ctrl+F, CLI parity).
 * Imported for its side effects (registers the Ctrl+F keybinding).
 */
import { ctx } from "./state.js"
import { t } from "./i18n.js"

let _searchMatches = []  // live mark.search-hit elements
let _searchIndex = 0

function clearSearchHighlights() {
  for (const mark of ctx.messagesEl.querySelectorAll("mark.search-hit")) {
    const parent = mark.parentNode
    parent.replaceChild(document.createTextNode(mark.textContent), mark)
    parent.normalize() // merge adjacent text nodes back
  }
  _searchMatches = []
}

function highlightTextNode(node, q) {
  const text = node.nodeValue
  const lower = text.toLowerCase()
  const frag = document.createDocumentFragment()
  let i = 0
  let idx
  while ((idx = lower.indexOf(q, i)) !== -1) {
    if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)))
    const mark = document.createElement("mark")
    mark.className = "search-hit"
    mark.textContent = text.slice(idx, idx + q.length)
    frag.appendChild(mark)
    i = idx + q.length
  }
  if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)))
  node.parentNode.replaceChild(frag, node)
}

function performSearch(query) {
  clearSearchHighlights()
  if (!query) { updateSearchCount(); return }
  const q = query.toLowerCase()
  const NF = window.NodeFilter
  const walker = document.createTreeWalker(ctx.messagesEl, NF.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node.parentElement?.closest("#search-bar")) return NF.FILTER_REJECT
      return node.nodeValue.toLowerCase().includes(q) ? NF.FILTER_ACCEPT : NF.FILTER_REJECT
    },
  })
  const nodes = []
  let n
  while ((n = walker.nextNode())) nodes.push(n)
  for (const node of nodes) highlightTextNode(node, q)
  _searchMatches = [...ctx.messagesEl.querySelectorAll("mark.search-hit")]
  _searchIndex = _searchMatches.length ? Math.min(_searchIndex, _searchMatches.length - 1) : 0
  updateSearchCount()
  if (_searchMatches.length) showCurrentMatch()
}

function showCurrentMatch() {
  _searchMatches.forEach((m, i) => m.classList.toggle("current", i === _searchIndex))
  _searchMatches[_searchIndex]?.scrollIntoView({ block: "center" })
}

function updateSearchCount() {
  const el = document.getElementById("search-count")
  if (el) el.textContent = _searchMatches.length ? `${_searchIndex + 1}/${_searchMatches.length}` : t("search.noMatch")
}

function jumpSearch(dir) {
  if (!_searchMatches.length) return
  _searchIndex = (_searchIndex + dir + _searchMatches.length) % _searchMatches.length
  showCurrentMatch()
  updateSearchCount()
}

function ensureSearchBar() {
  let bar = document.getElementById("search-bar")
  if (bar) return bar
  bar = document.createElement("div")
  bar.id = "search-bar"
  bar.style.display = "none"
  bar.innerHTML =
    `<input id="search-input" type="text" placeholder="${t("search.placeholder")}" aria-label="${t("search.placeholder")}">` +
    `<span id="search-count" role="status" aria-live="polite"></span>` +
    `<button id="search-prev" title="${t("search.prev")}" aria-label="${t("search.prev")}">↑</button>` +
    `<button id="search-next" title="${t("search.next")}" aria-label="${t("search.next")}">↓</button>` +
    `<button id="search-close" title="${t("search.close")}" aria-label="${t("search.close")}">✕</button>`
  const toolbar = document.getElementById("toolbar")
  toolbar.parentNode.insertBefore(bar, toolbar)
  const input = bar.querySelector("#search-input")
  input.addEventListener("input", () => performSearch(input.value.trim()))
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); jumpSearch(e.shiftKey ? -1 : 1) }
    else if (e.key === "Escape") closeSearch()
    else if (e.key === "ArrowDown") { e.preventDefault(); jumpSearch(1) }
    else if (e.key === "ArrowUp") { e.preventDefault(); jumpSearch(-1) }
  })
  bar.querySelector("#search-next").addEventListener("click", () => jumpSearch(1))
  bar.querySelector("#search-prev").addEventListener("click", () => jumpSearch(-1))
  bar.querySelector("#search-close").addEventListener("click", closeSearch)
  return bar
}

function openSearch() {
  const bar = ensureSearchBar()
  bar.style.display = "flex"
  bar.querySelector("#search-input").focus()
}

function closeSearch() {
  const bar = document.getElementById("search-bar")
  if (bar) bar.style.display = "none"
  clearSearchHighlights()
  ctx.inputEl.focus()
}

// Ctrl+F opens in-conversation search (webview's native find does nothing here).
document.addEventListener("keydown", (e) => {
  if (e.key === "f" && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault()
    openSearch()
  }
})
