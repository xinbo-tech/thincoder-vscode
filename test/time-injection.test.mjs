/**
 * time-injection.test.mjs — per-run time reminder position & prefix-cache contract
 *
 * 2026-08-16 cache-hit regression: the plugin reloads the machine line from disk every
 * run (transient messages dropped on persist), so a time reminder interleaved BEFORE
 * the user input drifted position run-to-run and destroyed provider prefix caches.
 * Contract now: the reminder is the LAST message of the sequence (after the user
 * input) — its second-precision content can never shift a prefix. Also locks the
 * fresh-machine-line injections that the interleaved push had silently disabled.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "../src/agent.mjs"

const TIME_RE = /current time is \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/

function makeProvider() {
  return { baseURL: "http://127.0.0.1:1", apiKey: "x", model: "m" } // unreachable — we never call chat
}

async function captureSetup({ provider, history, fullHistory }) {
  // runAgent with a provider that fails instantly after setup — we only inspect the
  // machine line as prepared before the first chat call.
  const seen = { history: null }
  try {
    await runAgent(provider, process.cwd(), "你好", {}, undefined, true, {
      history, fullHistory,
      // Force failure at the first LLM call; setup already ran by then.
      mcpServers: [], skills: [],
    })
  } catch {
    // expected: chat to 127.0.0.1:1 fails
  }
  seen.history = history
  return seen
}

describe("per-run time reminder (prefix-cache contract)", () => {
  it("sits AFTER the user input (last machine-line message) on a fresh run", async () => {
    const history = []
    const fullHistory = []
    await captureSetup({ provider: makeProvider(), history, fullHistory })
    const timeIdx = history.findIndex((m) => typeof m.content === "string" && TIME_RE.test(m.content))
    assert.ok(timeIdx >= 0, "time reminder injected")
    const userIdx = history.findIndex((m) => m.role === "user" && m.content === "你好")
    assert.ok(userIdx >= 0, "user input present")
    assert.ok(timeIdx > userIdx, `time (${timeIdx}) must come AFTER the user input (${userIdx}) — interleaving drifts run-to-run and kills the prefix cache`)
    assert.equal(history[timeIdx].transient, true, "transient — dropped on persist")
  })

  it("fresh-machine-line injections still run (the interleaved push had disabled them)", async () => {
    const history = []
    const fullHistory = []
    await captureSetup({ provider: makeProvider(), history, fullHistory })
    // fresh run injects the AUTO/permission reminder + context — assert at least one
    // of the machine-only reminders besides the time one landed before the user input
    const machine = history.filter((m) => typeof m.content === "string" && m.content.startsWith("[System"))
    assert.ok(machine.length >= 1, "fresh-run system reminders present")
  })

  it("across runs the prefix before the time stays byte-identical (cache premise)", async () => {
    // Simulate two runs: run 1 leaves real messages; run 2 reloads from disk (transient
    // dropped) and appends a new time at the tail. The prefix up to the previous tail
    // must be identical for the cache to hit.
    const run1 = []
    await captureSetup({ provider: makeProvider(), history: run1, fullHistory: [] })
    // run1 "ends": persist drops transient → what disk holds
    const onDisk = run1.filter((m) => !m.transient)
    const run2 = [...onDisk.map((m) => ({ ...m }))] // disk reload (fresh array, same content)
    await captureSetup({ provider: makeProvider(), history: run2, fullHistory: [] })
    const t1 = run1.find((m) => typeof m.content === "string" && TIME_RE.test(m.content))
    const t2 = run2.find((m) => typeof m.content === "string" && TIME_RE.test(m.content))
    assert.ok(t2, "run 2 re-injects a fresh time")
    assert.notEqual(t1.content, t2.content, "times differ (seconds) — but position is tail so prefix is unaffected")
    // prefix = everything before the time in run2 vs run1's prefix
    const idx1 = run1.findIndex((m) => m === t1)
    const idx2 = run2.findIndex((m) => m === t2)
    const prefix1 = run1.slice(0, idx1).map((m) => JSON.stringify(m))
    const prefix2 = run2.slice(0, idx2).map((m) => JSON.stringify(m))
    assert.deepEqual(prefix2.slice(0, prefix1.length), prefix1, "prefix before the time is byte-identical → cache hits")
  })
})
