/**
 * history-window.test.mjs — lazy history pagination contract:
 * last-page first paint, scroll-back pages, GLOBAL idx anchors, hasOlder edges.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { historyWindow, HISTORY_PAGE_SIZE } from "../src/extension/session-io.mjs"

function fakeHistory(n) {
  return Array.from({ length: n }, (_, i) => ({ role: i % 3 === 0 ? "user" : "assistant", content: `msg-${i}`, timestamp: i }))
}

describe("historyWindow", () => {
  it("empty / non-array history yields an empty page", () => {
    assert.deepEqual(historyWindow([], null), { messages: [], hasOlder: false })
    assert.deepEqual(historyWindow(null, null), { messages: [], hasOlder: false })
    assert.deepEqual(historyWindow(undefined, 5), { messages: [], hasOlder: false })
  })

  it("a short history loads entirely on first paint with hasOlder=false", () => {
    const h = fakeHistory(7)
    const { messages, hasOlder } = historyWindow(h, null)
    assert.equal(messages.length, 7)
    assert.equal(hasOlder, false)
    assert.equal(messages[0].idx, 0)
    assert.equal(messages[6].idx, 6)
  })

  it("first paint takes the LAST page with global idx anchors", () => {
    const total = 137
    const { messages, hasOlder } = historyWindow(fakeHistory(total), null)
    assert.equal(messages.length, HISTORY_PAGE_SIZE)
    assert.equal(hasOlder, true)
    assert.equal(messages[0].idx, total - HISTORY_PAGE_SIZE)  // global index, never renumbered
    assert.equal(messages.at(-1).idx, total - 1)
  })

  it("scroll-back pages end just before `before` and chain without overlap", () => {
    const h = fakeHistory(137)
    const first = historyWindow(h, null)
    const second = historyWindow(h, first.messages[0].idx)
    assert.equal(second.messages.length, HISTORY_PAGE_SIZE)
    assert.equal(second.messages.at(-1).idx, first.messages[0].idx - 1)  // contiguous, no overlap
    assert.equal(second.hasOlder, true)

    const third = historyWindow(h, second.messages[0].idx)
    assert.equal(third.messages.length, 137 - 2 * HISTORY_PAGE_SIZE)  // remainder
    assert.equal(third.hasOlder, false)  // start === 0
  })

  it("before near the head clamps to the array start and reports hasOlder=false", () => {
    const { messages, hasOlder } = historyWindow(fakeHistory(137), 10)
    assert.equal(messages.length, 10)
    assert.equal(messages[0].idx, 0)
    assert.equal(hasOlder, false)
  })

  it("before=0 yields an empty page", () => {
    assert.deepEqual(historyWindow(fakeHistory(10), 0), { messages: [], hasOlder: false })
  })

  it("before beyond the total clamps to the last page", () => {
    const h = fakeHistory(20)
    const { messages, hasOlder } = historyWindow(h, 999)
    assert.equal(messages.length, 20)
    assert.equal(messages.at(-1).idx, 19)
    assert.equal(hasOlder, false)
  })

  it("skips non-string content and unrenderable kinds, keeps the rest in order", () => {
    const h = [
      { role: "user", content: "a" },
      { role: "tool", content: "b", name: "write" },
      { role: "assistant", content: 123 },        // non-string → skipped
      { role: "system", content: "sys" },          // unrenderable kind → skipped
      { type: "assistant", content: "c" },         // type wins over role
      { role: "user", content: "d", timestamp: 42 },
    ]
    const { messages, hasOlder } = historyWindow(h, null)
    assert.deepEqual(messages.map((m) => m.kind), ["user", "tool", "assistant", "user"])
    assert.deepEqual(messages.map((m) => m.idx), [0, 1, 4, 5])  // global indexes survive the gaps
    assert.equal(messages[1].name, "write")
    assert.equal(messages[3].timestamp, 42)
    assert.equal(hasOlder, false)
  })
})
