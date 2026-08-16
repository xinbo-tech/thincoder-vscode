/**
 * tool-pairing.test.mjs — tool-call pairing protocol defense (2026-08-16 kimi 400 incident)
 * Kimi rejected the request with "an assistant message with 'tool_calls' must be followed
 * by tool messages responding to each 'tool_call_id': checklist:87, task:88" — the plugin
 * lacked the CLI's normalizeToolPairing send-time sanitizer and compaction could leave
 * dangling tool_calls. Locks both fixes.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { normalizeToolPairing } from "../src/provider.mjs"
import { truncateFallback } from "../src/compact.mjs"

describe("normalizeToolPairing (send-time sanitizer)", () => {
  it("leaves a well-formed pair untouched", () => {
    const msgs = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "read" } }] },
      { role: "tool", tool_call_id: "a", content: "ok" },
    ]
    assert.deepEqual(normalizeToolPairing(msgs), msgs)
  })

  it("reorders tool results to sit right after their assistant (parallel readonly interleave)", () => {
    const msgs = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "read" } }, { id: "b", type: "function", function: { name: "grep" } }] },
      { role: "user", content: "[image injected between results]" },
      { role: "tool", tool_call_id: "a", content: "ra" },
      { role: "tool", tool_call_id: "b", content: "rb" },
    ]
    const out = normalizeToolPairing(msgs)
    // assistant → both tool results immediately after
    assert.equal(out[1].role, "assistant")
    assert.equal(out[2].tool_call_id, "a")
    assert.equal(out[3].tool_call_id, "b")
    assert.equal(out[4].role, "user")
  })

  it("fills a declared tool_call missing its result with a placeholder (compaction split)", () => {
    const msgs = [
      { role: "assistant", content: "", tool_calls: [{ id: "orphan", type: "function", function: { name: "checklist" } }] },
      { role: "user", content: "next" },
    ]
    const out = normalizeToolPairing(msgs)
    assert.equal(out[1].role, "tool")
    assert.equal(out[1].tool_call_id, "orphan")
    assert.match(out[1].content, /missing/, "placeholder mentions the gap")
  })

  it("drops orphan tool messages whose owner assistant was compacted away", () => {
    const msgs = [
      { role: "user", content: "go" },
      { role: "tool", tool_call_id: "ghost", content: "nobody declared this" },
    ]
    const out = normalizeToolPairing(msgs)
    assert.equal(out.length, 1, "orphan tool dropped")
    assert.equal(out[0].role, "user")
  })
})

describe("truncateFallback reverse protection (tail opening with dangling tool_calls)", () => {
  it("extends the tail back over the missing tool results instead of sending dangling tool_calls", () => {
    // Force a small keep count so the cut lands between an assistant and its tool results.
    const provider = { context: 128_000 }
    const many = []
    for (let i = 0; i < 30; i++) many.push({ role: "user", content: `m${i}` })
    // now the tail region: assistant declares tool_calls, tool results sit just before the cut
    const asst = { role: "assistant", content: "", tool_calls: [{ id: "x9", type: "function", function: { name: "bash" } }] }
    const tool = { role: "tool", tool_call_id: "x9", content: "out" }
    const history = [...many, asst, tool, { role: "user", content: "final" }]
    const out = truncateFallback(history, provider)
    assert.ok(out, "fallback produced a result")
    // the assistant must not appear without its tool result in the tail
    const tail = out.slice(-3)
    const asstIdx = tail.findIndex((m) => m.role === "assistant" && m.tool_calls?.length)
    if (asstIdx >= 0) {
      const id = tail[asstIdx].tool_calls[0].id
      assert.equal(tail[asstIdx + 1]?.tool_call_id, id, "tool result follows its assistant")
    }
  })
})
