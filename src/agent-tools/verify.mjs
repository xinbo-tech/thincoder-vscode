/**
 * verify.mjs — verifyTool
 * Run a pre-completion self-check: syntax checks + VSCode diagnostics on changed files,
 * optionally the full test suite.
 */
import { join, isAbsolute } from "node:path"
import { resolvePath } from "../tools/shared.mjs"
import * as vscode from "vscode"

export const verifyTool = {
  name: "verify",
  description:
    "Run a pre-completion self-check. Runs syntax checks and reads editor diagnostics on changed files.\n" +
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

    // 1. Syntax check (node --check) for JS files
    for (const f of files) {
      if (/\.(m?js|cjs)$/.test(f)) {
        try {
          const { execSync } = await import("node:child_process")
          const abs = resolvePath(f, ctx.cwd)
          execSync(`node --check "${abs}"`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000, stdio: "pipe" })
          results.push(`✓ ${f}: syntax OK`)
        } catch (e) {
          anyFailure = true
          results.push(`✗ ${f}: ${(e.stderr || e.message).slice(0, 200)}`)
        }
      } else {
        results.push(`- ${f}: not a JS file, skipped syntax check`)
      }
    }

    // 2. VSCode diagnostics (LSP — eslint, tsc, rust-analyzer, etc.)
    const allDiags = vscode.languages.getDiagnostics()
    const diagByFile = new Map()
    for (const [uri, diags] of allDiags) {
      if (diags.length > 0) diagByFile.set(uri.fsPath, diags)
    }

    let diagCount = 0
    for (const f of files) {
      const abs = resolvePath(f, ctx.cwd)
      const diags = diagByFile.get(abs)
      if (!diags || diags.length === 0) continue

      const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error)
      const warnings = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning)
      if (errors.length === 0 && warnings.length === 0) continue

      if (errors.length > 0) anyFailure = true
      diagCount += errors.length + warnings.length

      results.push(`\n── ${f} (${errors.length} errors, ${warnings.length} warnings) ──`)
      const show = [...errors, ...warnings].slice(0, 15)
      for (const d of show) {
        const sev = d.severity === vscode.DiagnosticSeverity.Error ? "E" : "W"
        const line = d.range.start.line + 1
        const col = d.range.start.character + 1
        const src = d.source ? ` [${d.source}]` : ""
        results.push(`  ${sev} ${line}:${col}  ${d.message}${src}`)
      }
      const remaining = (errors.length + warnings.length) - show.length
      if (remaining > 0) results.push(`  ... ${remaining} more`)
    }
    if (diagCount === 0 && files.some(f => /\.(m?js|cjs|ts|tsx|mts|cts|rs|go|py)$/.test(f))) {
      results.push("\n✓ diagnostics: no errors or warnings")
    }

    // 3. Test suite (full mode)
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
