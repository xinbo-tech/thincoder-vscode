#!/usr/bin/env node
/**
 * scripts/publish-all.mjs — dual-registry publish with activation polling (RELEASE.md gate).
 *
 * One command = one complete release: microsoft marketplace AND Open VSX, with post-publish
 * API verification for BOTH. Exists because 0.8.4 shipped to the marketplace only and Cursor
 * users stayed on 0.8.3 (2026-08-29 miss), and because `ovsx publish` can exit 🚀 while the
 * version sits in an inactive moderation queue — silent fake success without polling.
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
const VERSION = PKG.version
const PUBLISHER = PKG.publisher
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
  return execSync(cmd, { stdio: "inherit", timeout: 600_000, env: process.env })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll a registry API until `version` is live. Returns true when confirmed. */
async function pollVersion(url, registry, attempts = 20, delayMs = 15_000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url)
      const data = await res.json()
      if (data?.version === VERSION) {
        console.log(`  ✅ ${registry}: version ${VERSION} is LIVE (attempt ${i})`)
        return true
      }
      console.log(`  ⏳ ${registry}: API still reports ${data?.version ?? res.status} (attempt ${i}/${attempts})`)
    } catch (e) {
      console.log(`  ⏳ ${registry}: API error — ${String(e.message).slice(0, 80)} (attempt ${i}/${attempts})`)
    }
    await sleep(delayMs)
  }
  return false
}

const results = { marketplace: false, openvsx: false }

// ── 1. Microsoft Marketplace ──
if (skipMarketplace) {
  console.log("\n⚠️  --skip-marketplace: NOT publishing to the Microsoft Marketplace (explicit flag).")
} else {
  if (!process.env.VSCE_PAT) throw new Error("VSCE_PAT not set — cannot publish to the marketplace")
  // vsce reads VSCE_PAT natively — keep the PAT OFF the command line (process-list / crash-log leak).
  // NOTE: a .vsix must ride -i/--packagePath; a bare positional arg to `vsce publish` is parsed as [version].
  run(`npx @vscode/vsce publish${vsix ? ` -i ${vsix}` : ""}`, "① Microsoft Marketplace (vsce publish)")
  // Microsoft's gallery query API reflects new versions near-instantly.
// ⚠️ marketplace 的 extensionquery 是 POST-only——不走这个 GET（会浪费轮询窗口），见下方 POST 直查。
// 直查（含 flags 71：不含 ExcludeNonValidated，避免"验证扫描中"的新版本被排除导致假 NOT-CONFIRMED）。
{
  const body = JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: `${PUBLISHER}.${PKG.name}` }] }], flags: 71 })
  for (let i = 1; i <= 15; i++) {
    try {
      const res = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json;api-version=3.0-preview.1" },
        body,
      })
      const data = await res.json()
      const latest = data.results?.[0]?.extensions?.[0]?.versions?.[0]?.version
      if (latest === VERSION) { console.log(`  ✅ marketplace: version ${VERSION} is LIVE (attempt ${i})`); results.marketplace = true; break }
      console.log(`  ⏳ marketplace: latest ${latest} (attempt ${i}/15)`)
    } catch (e) { console.log(`  ⏳ marketplace query error (attempt ${i}/15)`) }
    await sleep(10_000)
  }
}
}

// ── 2. Open VSX ──
if (skipOpenvsx) {
  console.log("\n⚠️  --skip-openvsx: NOT publishing to Open VSX (explicit flag).")
} else {
  if (!process.env.OVSX_PAT) throw new Error("OVSX_PAT not set — cannot publish to Open VSX")
  // ovsx reads OVSX_PAT natively (util.addEnvOptions) — keep the PAT off the command line.
  run(`npx ovsx publish${vsix ? ` ${vsix}` : ""}`, "② Open VSX (ovsx publish)")
  // ovsx may report 🚀 while the upload sits in the inactive moderation queue — poll until
  // the API actually flips, or loudly report the stuck state (do NOT exit 0 on fake success).
  results.openvsx = await pollVersion(`https://open-vsx.org/api/${PUBLISHER}/${PKG.name}`, "open-vsx")
  if (!results.openvsx) {
    console.error(`\n❌ Open VSX: version ${VERSION} did not go LIVE within the polling window.`)
    console.error("   Likely sitting in the moderation queue ('already published, but currently isn't active').")
    console.error("   Re-run `npx ovsx publish` later, or check https://github.com/eclipse/openvsx/wiki/Publishing-Extensions")
  }
}

// ── 3. Verdict ──
console.log("\n──────── publish-all summary ────────")
console.log(`  marketplace : ${results.marketplace ? "✅ LIVE" : skipMarketplace ? "⏭️ skipped (explicit)" : "❌ NOT CONFIRMED"}`)
console.log(`  open-vsx    : ${results.openvsx ? "✅ LIVE" : skipOpenvsx ? "⏭️ skipped (explicit)" : "❌ NOT CONFIRMED"}`)
const ok = results.marketplace || skipMarketplace
const ok2 = results.openvsx || skipOpenvsx
if (ok && ok2 && (results.marketplace || results.openvsx)) {
  console.log(`\n🚀 release ${VERSION} complete.`)
  process.exit(0)
}
console.error(`\n❌ release ${VERSION} INCOMPLETE — fix the ❌ registry above and re-run (same version cannot be re-published to a registry that succeeded).`)
process.exit(1)
