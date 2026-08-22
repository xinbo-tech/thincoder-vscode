/**
 * verify.mjs — verifyTool
 * Run a pre-completion self-check: syntax checks + VSCode diagnostics on changed files,
 * optionally the full test suite.
 */
import { resolvePath, runInterruptible } from "../tools/shared.mjs"
import * as vscode from "vscode"
import { join } from "node:path"

export const verifyTool = {
  name: "verify",
  readonly: true,
  description:
    "Run a pre-completion self-check. Runs syntax checks and reads editor diagnostics on changed files.\n" +
    "Parameters:\n" +
    "- full: Also run the full test suite (default false)\n" +
    "- workdir: Optional — run the test suite in this subdirectory (for monorepos)\n" +
    "- filter: Optional — limit the test run to matching test names (node --test-name-pattern)",
  parameters: {
    type: "object",
    properties: {
      full: { type: "boolean", description: "Run full test suite" },
      workdir: { type: "string", description: "Optional — run the test suite in this subdirectory (for monorepos)" },
      filter: { type: "string", description: "Optional — limit the test run to matching test names (node --test-name-pattern)" },
    },
  },
  async execute({ full, workdir, filter }, ctx) {
    const files = ctx.agent._touchedFiles || []
    if (files.length === 0) return "(no files modified — nothing to verify)"
    const testCwd = workdir ? resolvePath(workdir, ctx.cwd) : ctx.cwd

    let anyFailure = false
    const results = []

    // 1. Syntax check (node --check) for JS files — interruptible (Stop kills it)
    for (const f of files) {
      if (/\.(m?js|cjs)$/.test(f)) {
        try {
          const abs = resolvePath(f, ctx.cwd)
          await runInterruptible(process.execPath, ["--check", abs], { cwd: ctx.cwd, timeout: 10000, signal: ctx.signal })
          results.push(`✓ ${f}: syntax OK`)
        } catch (e) {
          if (e.name === "AbortError") throw e  // propagate Stop — do not swallow as a syntax failure
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

    // 3. Test suite (full mode) — interruptible (Stop kills npm test)
    if (full) {
      try {
        // npm-cli.js via the current Node binary (avoids Windows npm.cmd spawn EINVAL;
        // same pattern as linter's NPX_CLI). execSync froze the host event loop and a
        // Stop click could not even be DELIVERED until the command finished.
        const npmCli = join(process.execPath.replace(/[\\/][^\\/]+$/, ""), "node_modules", "npm", "bin", "npm-cli.js")
        const testResult = await runInterruptible(process.execPath, [npmCli, "test", ...(filter ? ["--", `--test-name-pattern=${filter}`] : [])], { cwd: testCwd, timeout: 60000, signal: ctx.signal })
        results.push(`\n=== Test suite ===\n${testResult.slice(0, 3000)}`)
      } catch (e) {
        if (e.name === "AbortError") throw e  // propagate Stop
        anyFailure = true
        results.push(`\n=== Test suite FAILED ===\n${(e.stdout || e.stderr || e.message).slice(0, 2000)}`)
      }
    }

    ctx.agent._verifiedThisRun = true
    ctx.agent._verifyPassed = !anyFailure
    return results.join("\n")
  },
}
