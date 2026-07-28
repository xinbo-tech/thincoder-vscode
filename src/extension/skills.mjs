/**
 * skills.mjs — load skill markdown files from .thincoder/skills/
 * Skills are reusable workflow templates the agent can reference.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Load all skill files from .thincoder/skills/ in the workspace.
 * Returns [{ name: "code-review", content: "..." }, ...]
 * Skips files starting with . and non-.md files.
 */
export function loadSkills(cwd) {
  const dir = join(cwd, ".thincoder", "skills")
  if (!existsSync(dir)) return []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const skills = []
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith(".") || !e.name.endsWith(".md")) continue
    try {
      const content = readFileSync(join(dir, e.name), "utf8").trim()
      if (content.length === 0) continue
      skills.push({ name: e.name.replace(/\.md$/, ""), content })
    } catch { /* skip unreadable */ }
  }
  return skills
}
