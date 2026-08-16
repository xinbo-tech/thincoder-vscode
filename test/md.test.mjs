/**
 * md.test.mjs — markdown renderer edge cases (webview/md.js)
 * The hand-rolled renderer has no parser to fall back on; these lock its
 * known-behavior contracts. Focus: table pipes, escaping, inline forms.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { md, mdInline, esc } from "../webview/md.js"

describe("md — tables", () => {
  it("renders a basic table with header + body", () => {
    const out = md("| a | b |\n|---|---|\n| 1 | 2 |")
    assert.equal((out.match(/<th>/g) || []).length, 2)
    assert.equal((out.match(/<td>/g) || []).length, 2)
    assert.match(out, /<table>/)
  })

  it("escaped pipe \\| is a literal | inside a cell — never splits it", () => {
    const out = md("| a | b \\| c |\n|---|---|\n| 1 | x \\| y |")
    // 2 header + 2 body cells — a split would create extra cells
    assert.equal((out.match(/<th>/g) || []).length, 2, "header cells")
    assert.equal((out.match(/<td>/g) || []).length, 2, "body cells")
    assert.ok(out.includes("b | c"), "escaped pipe restored, no backslash")
    assert.ok(out.includes("x | y"))
    assert.ok(!out.includes("\\|"), "no raw escape residue")
  })

  it("escaped pipe inside inline code follows GFM (escape in code too)", () => {
    const out = md("| x | `a\\|b` |\n|---|---|\n| 1 | 2 |")
    assert.equal((out.match(/<th>/g) || []).length, 2, "escaped code pipe did not split")
    assert.ok(out.includes("<code>a|b</code>"), "code pipe restored as literal")
  })
})

describe("md — inline", () => {
  it("escapes HTML in plain text", () => {
    assert.equal(esc("<script>&"), "&lt;script&gt;&amp;")
  })

  it("bold + italic + inline code coexist", () => {
    const out = mdInline("**b** and *i* and `c`")
    assert.match(out, /<strong>b<\/strong>/)
    assert.match(out, /<em>i<\/em>/)
    assert.match(out, /<code>c<\/code>/)
  })
})
