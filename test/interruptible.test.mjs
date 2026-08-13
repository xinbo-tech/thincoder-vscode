/**
 * interruptible.test.mjs — runInterruptible contract:
 * Stop must kill in-flight lint/verify commands immediately (execSync froze
 * the extension-host event loop; the abort message could not even be delivered).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { runInterruptible } from "../src/tools/shared.mjs"

test("resolves stdout on success", async () => {
  const out = await runInterruptible(process.execPath, ["-e", "console.log('hello')"], {})
  assert.match(out, /hello/)
})

test("rejects with execFileSync-compatible error shape on non-zero exit", async () => {
  await assert.rejects(
    () => runInterruptible(process.execPath, ["-e", "console.error('boom'); process.exit(3)"], {}),
    (e) => {
      assert.equal(e.code, 3)
      assert.match(e.stderr ?? "", /boom/)
      return true
    },
  )
})

test("abort kills a long-running child immediately", async () => {
  const ctrl = new AbortController()
  const t0 = Date.now()
  const p = runInterruptible(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { signal: ctrl.signal })
  setTimeout(() => ctrl.abort(), 80)
  await assert.rejects(p, (e) => e.name === "AbortError")
  assert.ok(Date.now() - t0 < 3000, "abort must kill the child immediately, not wait for the command")
})

test("timeout kills the child and rejects with TimeoutError", async () => {
  const t0 = Date.now()
  await assert.rejects(
    () => runInterruptible(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeout: 300 }),
    (e) => e.name === "TimeoutError",
  )
  assert.ok(Date.now() - t0 < 3000, "timeout must fire on schedule")
})

test("an already-aborted signal fails fast without spawning", async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  const t0 = Date.now()
  await assert.rejects(
    () => runInterruptible(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { signal: ctrl.signal }),
    (e) => e.name === "AbortError",
  )
  assert.ok(Date.now() - t0 < 500, "pre-aborted signal must reject immediately")
})
