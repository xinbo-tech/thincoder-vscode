/**
 * verify.mjs — verifyTool
 * Run a pre-completion self-check: syntax checks on changed files,
 * optionally the full test suite.
 */
import { join } from "node:path"

export const verifyTool = {
  name: "verify",
  description:
    "Run a pre-completion self-check. Runs syntax checks on changed files.\n" +
    "Parameters:\n" +
    "- full: Also run the full test suite (default false)",
  parameters: {
    type: "object",
    properties: {
      full: { type: "boolean", description: "Run full test suite" },
    },
  },
  async execute({ full }, ctx) {
    const files = ctx.agent._touchedFiles || []
    if (files.length === 0) return "(no files modified — nothing to verify)"

    let anyFailure = false
    const results = []
    for (const f of files) {
      if (/\.(m?js|cjs)$/.test(f)) {
        try {
          const { execSync } = await import("node:child_process")
          const abs = join(ctx.cwd, f)
          execSync(`node --check "${abs}"`, { encoding: "utf8", timeout: 10000, stdio: "pipe" })
          results.push(`✓ ${f}: syntax OK`)
        } catch (e) {
          anyFailure = true
          results.push(`✗ ${f}: ${(e.stderr || e.message).slice(0, 200)}`)
        }
      } else {
        results.push(`- ${f}: not a JS file, skipped syntax check`)
      }
    }

    if (full) {
      try {
        const { execSync } = await import("node:child_process")
        const testResult = execSync("npm test", { cwd: ctx.cwd, encoding: "utf8", timeout: 60000, stdio: "pipe" })
        results.push(`\n=== Test suite ===\n${testResult.slice(0, 3000)}`)
      } catch (e) {
        anyFailure = true
        results.push(`\n=== Test suite FAILED ===\n${(e.stdout || e.stderr || e.message).slice(0, 2000)}`)
      }
    }

    ctx.agent._verifiedThisRun = true
    ctx.agent._verifyPassed = !anyFailure
    return results.join("\n")
  },
}
