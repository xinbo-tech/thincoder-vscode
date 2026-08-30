#!/usr/bin/env node
/**
 * scripts/publish-all.mjs — dual-registry publish (RELEASE.md gate, 2026-08-31).
 *
 * One command = one complete release: microsoft marketplace AND Open VSX.
 * Completion verdict = both publish commands returned exit 0 — **no post-publish
 * polling**. The registries' review/moderation queues are their own business: new
 * versions go live minutes-to-longer later, so waiting on API flips is wasted time
 * (user ruling 2026-08-31; RELEASE.md §3/§5b/§6 have the record, incl. the 0.8.7
 * "already published" = the previous command actually succeeded diagnostic note).
 *
 * Usage:
 *   node scripts/publish-all.mjs            # vsce publish + ovsx publish (current version)
 *   node scripts/publish-all.mjs <vsix>     # publish an already-packaged vsix to both
 *
 * Required env: VSCE_PAT (marketplace), OVSX_PAT (open-vsx).
 * Skipped steps must be explicit: --skip-marketplace / --skip-openvsx (each prints a loud
 * warning; skipping BOTH aborts).
 */
import { execSync } from "node:child_process"

const PKG = JSON.parse((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const args = process.argv.slice(2)
const vsix = args.find((a) => !a.startsWith("--"))
const skipMarketplace = args.includes("--skip-marketplace")
const skipOpenvsx = args.includes("--skip-openvsx")

if (skipMarketplace && skipOpenvsx) {
  console.error("❌ both registries skipped — nothing to publish. Aborting.")
  process.exit(1)
}

const run = (cmd, label) => {
  console.log(`\n▶ ${label}\n  $ ${cmd.replace(/(--pat\s+)\S+/g, "$1***")}`)
  // execSync throws on non-zero exit — a failed publish must fail the release,
  // never look like progress.
  return execSync(cmd, { stdio: "inherit", timeout: 600_000, env: process.env })
}

// ── 1. Microsoft Marketplace ──
if (skipMarketplace) {
  console.log("\n⚠️  --skip-marketplace: NOT publishing to the Microsoft Marketplace (explicit flag).")
} else {
  if (!process.env.VSCE_PAT) throw new Error("VSCE_PAT not set — cannot publish to the marketplace")
  // vsce reads VSCE_PAT natively — keep the PAT OFF the command line (process-list / crash-log leak).
  // NOTE: a .vsix must ride -i/--packagePath; a bare positional arg to `vsce publish` is parsed as [version].
  run(`npx @vscode/vsce publish${vsix ? ` -i ${vsix}` : ""}`, "① Microsoft Marketplace (vsce publish)")
}

// ── 2. Open VSX ──
if (skipOpenvsx) {
  console.log("\n⚠️  --skip-openvsx: NOT publishing to Open VSX (explicit flag).")
} else {
  if (!process.env.OVSX_PAT) throw new Error("OVSX_PAT not set — cannot publish to Open VSX")
  // ovsx reads OVSX_PAT natively (util.addEnvOptions) — keep the PAT off the command line.
  run(`npx ovsx publish${vsix ? ` ${vsix}` : ""}`, "② Open VSX (ovsx publish)")
}

// ── 3. Verdict ──
// Reaching this line means both requested publish commands exited 0 — that IS the
// release verdict (2026-08-31 ruling). Any failure above threw and aborted.
const done = [`marketplace : ${skipMarketplace ? "⏭️ skipped (explicit)" : "✅ published"}`,
  `open-vsx    : ${skipOpenvsx ? "⏭️ skipped (explicit)" : "✅ published"}`]
console.log("\n──────── publish-all summary ────────")
console.log(done.join("\n"))
console.log(`\n🚀 release ${PKG.version} submitted to the requested registries.`)
console.log("   Per RELEASE.md: publish exit-0 = release done; review queues are the registries' business.")
process.exit(0)
