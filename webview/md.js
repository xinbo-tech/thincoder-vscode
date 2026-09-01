/**
 * md.js — zero-dependency markdown → HTML renderer
 */

import { highlight, normalizeLang } from "./highlight.js"

/** Full markdown → HTML */
export function md(raw) {
  if (!raw) return ""

  const blocks = []

  // 1. Fenced code blocks → placeholders
  let text = raw.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length
    const norm = normalizeLang(lang)
    const l = lang ? `<span class="code-lang">${esc(lang)}</span>` : ""
    const hl = highlight(code.trimEnd(), norm)
    blocks.push(`<pre class="code-block">${l}<code>${hl}</code></pre>`)
    return `\x00B${i}\x00`
  })

  // 2. Tables
  text = text.replace(/^\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)+)/gm, (match) => {
    const i = blocks.length
    blocks.push(renderTable(match))
    return `\x00B${i}\x00`
  })

  // 3. Inline code
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>")

  // 4. Images
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')

  // 5. Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // 6. Bold + italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  text = text.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>")

  // 7. Headers
  text = text.replace(/^#### (.+)$/gm, "<h4>$1</h4>")
  text = text.replace(/^### (.+)$/gm, "<h3>$1</h3>")
  text = text.replace(/^## (.+)$/gm, "<h2>$1</h2>")
  text = text.replace(/^# (.+)$/gm, "<h1>$1</h1>")

  // 8. Unordered lists
  text = text.replace(/^[-*] (.+)$/gm, "<li>$1</li>")
  text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")

  // 9. Ordered lists
  text = text.replace(/^\d+\. (.+)$/gm, "<li>$1</li>")

  // 10. Horizontal rules
  text = text.replace(/^---+$/gm, "<hr>")

  // 11. Paragraphs
  text = text.replace(/\n\n+/g, "</p><p>")
  text = "<p>" + text + "</p>"
  text = text.replace(/<p>\s*<\/p>/g, "")

  // 12. Single newline → <br>
  text = text.replace(/\n/g, "<br>")

  // 13. Restore placeholders
  text = text.replace(/\x00B(\d+)\x00/g, (_, i) => blocks[+i] || "")

  return text
}

/** Inline-only render */
export function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
}

export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

// ─── Helpers ───────────────────────────────────

function renderTable(raw) {
  const lines = raw.trim().split("\n")
  if (lines.length < 2) return esc(raw)

  const parseRow = (line) =>
    line
      .replace(/^\||\|$/g, "")
      // Escaped pipe (\| = literal |) must not split the cell — placeholder before splitting
      .replace(/\\\|/g, "\uE000P\uE000")
      .split("|")
      .map((c) => c.replace(/\uE000P\uE000/g, "|").trim())

  const header = parseRow(lines[0])
  const body = lines.slice(2).map(parseRow)

  let html = "<table>"
  html += "<thead><tr>" + header.map((h) => `<th>${mdInline(h)}</th>`).join("") + "</tr></thead>"
  html += "<tbody>"
  for (const row of body) {
    html += "<tr>" + row.map((c) => `<td>${mdInline(c)}</td>`).join("") + "</tr>"
  }
  html += "</tbody></table>"
  return html
}
