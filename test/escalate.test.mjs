/**
 * escalate.test.mjs — 飞刀 (ESCALATE.md §3 test table)
 * Covers: pool gating, registration, delegation contract, model pick,
 * depth guard, config round-trip, activity stream.
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { escalateTool } from "../src/agent-tools/escalate.mjs"
import { saveAgentSettingsFromPanel, loadAgentSettings } from "../src/config-io.mjs"
import { _setConfigPathForTest } from "../src/config-io.mjs"

const HOOKED = [
  { provider: "kimi", model: "kimi-k3", effort: "max", surgeon: true },
  { provider: "zhipu-plan", model: "glm-5.2", effort: "high", surgeon: true },
]
const UNHOOKED = [
  { provider: "kimi", model: "kimi-k3", effort: "max" },
]

function makeAgent(models) {
  return { config: { agent: { consultModels: models } }, _touchedFiles: [], _subIdCounter: 0 }
}

function makeCtx(agent, runner, depth = 0) {
  return {
    agent, cwd: process.cwd(), depth, runAgent: runner, callbacks: {},
    buildProvider: async (name) => ({ baseURL: "https://test/v1", apiKey: "sk-test", model: "x", name }),
  }
}

describe("escalate (飞刀)", () => {
  let tmp
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "escalate-"))
    _setConfigPathForTest(join(tmp, "config.json"))
  })
  // restore per-test path via afterEach-equivalent: node:test describe teardown
  describe("tool contract", () => {
    it("empty pool → error explaining the hook", async () => {
      const r = await escalateTool.execute({ task: "x" }, makeCtx(makeAgent([])))
      assert.ok(String(r).includes("no surgeon candidates"))
    })

    it("delegates to the hooked model with configured effort, coder role, depth 1", async () => {
      const seen = []
      const runner = async (provider, cwd, task, callbacks, signal, auto, opts) => { seen.push({ provider, opts }); return "post-op report" }
      const r = await escalateTool.execute({ task: "hard refactor" }, makeCtx(makeAgent(HOOKED), runner))
      assert.equal(seen.length, 1)
      assert.equal(seen[0].provider.name, "kimi", "default = first hooked candidate")
      assert.equal(seen[0].provider.reasoningEffort, "max", "configured effort injected")
      assert.equal(seen[0].provider.model, "kimi-k3")
      assert.equal(seen[0].opts.role, "coder", "full write path")
      assert.equal(seen[0].opts.depth, 1)
      assert.ok(String(r).includes("post-op report"))
    })

    it("model pick: explicit candidate used; unknown candidate rejected with the pool listed", async () => {
      const seen = []
      const runner = async (provider) => { seen.push(provider.name); return "ok" }
      const ctx = makeCtx(makeAgent(HOOKED), runner)
      await escalateTool.execute({ task: "x", model: "zhipu-plan:glm-5.2" }, ctx)
      assert.equal(seen[0], "zhipu-plan")
      const bad = await escalateTool.execute({ task: "x", model: "deepseek:deepseek-v4-pro" }, makeCtx(makeAgent(HOOKED), runner))
      assert.ok(String(bad).includes("not a hooked surgeon candidate"))
      assert.ok(String(bad).includes("kimi:kimi-k3"), "pool listed in the error")
    })

    it("depth guard: a surgeon cannot fly in another surgeon", async () => {
      const r = await escalateTool.execute({ task: "x" }, makeCtx(makeAgent(HOOKED), async () => "never", 1))
      assert.ok(String(r).includes("only available at depth 0"))
    })

    it("activity stream flows under sub:surgeon <label>", async () => {
      const panels = []
      const runner = async (provider, cwd, task, callbacks) => {
        callbacks.onToolCall?.("read", { path: "src/a.mjs" })
        callbacks.onToolResult?.("read", "contents")
        return "report"
      }
      const ctx = makeCtx(makeAgent(HOOKED), runner)
      ctx.callbacks = { onToolPanel: (name, chunk) => panels.push({ name, chunk }) }
      await escalateTool.execute({ task: "x" }, ctx)
      assert.ok(panels.every((p) => p.name === "sub:surgeon kimi:kimi-k3"))
      assert.ok(panels.some((p) => p.chunk.text.includes("read")))
    })

    it("unhooked rows are not in the pool", async () => {
      const r = await escalateTool.execute({ task: "x" }, makeCtx(makeAgent(UNHOOKED), async () => "never"))
      assert.ok(String(r).includes("no surgeon candidates"), "surgeon:false rows excluded")
    })
  })

  describe("config round-trip", () => {
    it("panel payload with surgeon:true persists; unchecking drops the field", () => {
      saveAgentSettingsFromPanel({ consultModels: [
        { provider: "kimi", model: "kimi-k3", effort: "max", surgeon: true },
        { provider: "deepseek", model: "deepseek-v4-pro", effort: "high", surgeon: false },
      ] })
      let s = loadAgentSettings()
      assert.equal(s.consultModels[0].surgeon, true)
      assert.equal(s.consultModels[1].surgeon, undefined, "false → field dropped, not persisted as false")

      saveAgentSettingsFromPanel({ consultModels: [{ provider: "kimi", model: "kimi-k3", effort: "max" }] })
      s = loadAgentSettings()
      assert.equal(s.consultModels[0].surgeon, undefined, "unhooked → no surgeon key")
      rmSync(tmp, { recursive: true, force: true })
    })
  })
})
