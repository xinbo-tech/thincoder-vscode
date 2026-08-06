/**
 * citations.mjs — host-verified citation checking (decision d698434).
 * Extracted from advisor/run.mjs (file-size split). The evidence rule becomes
 * a host fact: every `file:line: content` reference in a review is mechanically
 * checked against the CURRENT disk state; mismatches mark the finding
 * unverified and cannot support a push-back.
 */
import { readFileSync, realpathSync } from "node:fs"
import { resolve, sep } from "node:path"

// `file:line: content` citations — the file group is narrowed to source/config
// extensions so URLs (`example.com:8080: …`) don't become false-positive
// citations that fail as "file unreadable" in the verification report.
// Single-letter extensions (c/h) are kept — false positives (e.g. "a.c:1: x")
// are rare and only add a failed-citation line to the report; the report is
// advisory for the parent agent, never a crash path.
const CITATION_RE = /([\w./\\-]+\.(?:mjs|cjs|js|ts|jsx|tsx|mts|cts|py|rs|go|c|h|cpp|hpp|java|rb|php|sh|bash|json|md|markdown|mdx|yaml|yml|toml|css|html)):(\d+):\s*([^`\n]{4,})/g

/** Extract `file:line: content` citations from a review text. */
export function extractCitations(text) {
  const out = []
  for (const m of text.matchAll(CITATION_RE)) {
    out.push({ file: m[1], line: Number(m[2]), content: m[3].trim() })
  }
  return out
}

/**
 * Mechanically verify citations against the CURRENT file state: read the file,
 * take the exact line, check it CONTAINS the quoted content. Reports
 * N/M matched + the mismatches. Unverified citations cannot support a
 * push-back — the evidence rule becomes a host fact, not a prompt wish.
 */
export function verifyCitations(text, cwd) {
  const citations = extractCitations(text)
  const matched = []
  const failed = []
  const root = resolve(cwd) + sep
  for (const c of citations) {
    try {
      // Path confinement: citation paths are LLM-generated — never trust them.
      // A hallucinated "../config.json" would otherwise read (and leak via the
      // report) files outside the project, including API-key configs.
      // realpathSync resolves symlinks too — a link inside the project that
      // points outside must not pass the prefix check.
      const resolved = realpathSync(resolve(cwd, c.file))
      if (!resolved.startsWith(root)) {
        failed.push({ ...c, reason: "path traversal" })
        continue
      }
      const line = readFileSync(resolved, "utf8").split("\n")[c.line - 1] ?? ""
      if (line.includes(c.content)) matched.push(c)
      else failed.push(c)
    } catch {
      failed.push({ ...c, reason: "file unreadable" })
    }
  }
  return { total: citations.length, matched, failed }
}

/** Append the verification report to the review text (visible to the parent agent). */
export function appendCitationReport(text, cwd) {
  const { total, matched, failed } = verifyCitations(text, cwd)
  if (total === 0) return text // no citations — nothing to verify
  const lines = [
    "",
    "---",
    `[host-verified] ${matched.length}/${total} citations match current file state.`,
  ]
  if (failed.length > 0) {
    lines.push("Citations that do NOT match the current file state (treat their claims as unverified):")
    for (const f of failed.slice(0, 10)) {
      lines.push(`- ${f.file}:${f.line}: ${f.content.slice(0, 80)}${f.reason ? ` (${f.reason})` : ""}`)
    }
  }
  return text + lines.join("\n")
}
