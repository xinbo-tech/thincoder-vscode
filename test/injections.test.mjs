/**
 * injections.test.mjs — editor-context injection regression (2211d46):
 * collectEditorInjection returns a SINGLE message object; the agent loop used
 * to `for...of` it directly → "object is not iterable" on every send while an
 * editor inside the workspace was active.
 */
import test from "node:test"
import assert from "node:assert/strict"

test("runAgent accepts a single injection object (not just arrays)", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => { throw new DOMException("Aborted", "AbortError") }
  try {
    const { runAgent } = await import("../src/agent.mjs")
    const injection = { role: "user", content: "[Current file: a.mjs (full file)]", transient: true }
    await assert.rejects(
      () => runAgent(
        { baseURL: "https://api.test/v1", apiKey: "k", model: "deepseek-v4-pro" },
        "D:/x", "hi", {}, new AbortController().signal, true,
        { history: [], fullHistory: [], injections: injection },
      ),
      (e) => e.name === "AbortError",
      "must reach the LLM call (AbortError), NOT throw 'object is not iterable'",
    )
  } finally {
    globalThis.fetch = orig
  }
})

test("runAgent tolerates null and array injections", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => { throw new DOMException("Aborted", "AbortError") }
  try {
    const { runAgent } = await import("../src/agent.mjs")
    const run = (inj) => runAgent(
      { baseURL: "https://api.test/v1", apiKey: "k", model: "deepseek-v4-pro" },
      "D:/x", "hi", {}, new AbortController().signal, true,
      { history: [], fullHistory: [], injections: inj },
    )
    await assert.rejects(() => run(null), (e) => e.name === "AbortError")
    await assert.rejects(() => run([{ role: "user", content: "inj", transient: true }]), (e) => e.name === "AbortError")
  } finally {
    globalThis.fetch = orig
  }
})
