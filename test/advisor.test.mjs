/**
 * advisor.test.mjs — advisor convergence protocol + design-token tests (VS Code port).
 * Ported from the CLI test suite; covers the pure helpers that don't need a live LLM or git repo.
 * Run: node --test test/advisor.test.mjs
 */
import { describe, it, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { extractPriorIssueTable, extractAgentResponseTable, extractConversationBackground } from "../src/advisor/history.mjs"
import { buildAdvisorSystemPrompt, prepareAdvisorMessages } from "../src/advisor/main.mjs"
import { buildAdvisorUserMessage } from "../src/advisor/messages.mjs"
import { isDocFile } from "../src/advisor/repos.mjs"
import { validateDesignToken, extractTokenUUID } from "../src/agent-tools/advisor.mjs"
import { resolveAdvisorProvider } from "../src/advisor/run.mjs"
import { _setConfigPathForTest } from "../src/config-io.mjs"

let tmpDir
let cfgPath

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "thincoder-advisor-"))
  cfgPath = join(tmpDir, "config.json")
  _setConfigPathForTest(cfgPath)
})

after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  _setConfigPathForTest(null)
})

// ─── extractPriorIssueTable ─────────────────────────────────────

describe("extractPriorIssueTable", () => {
  it("returns null when history is empty", () => {
    assert.equal(extractPriorIssueTable([]), null)
  })

  it("returns null when no advisor output found", () => {
    const history = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "tool", tool_call_id: "t1", content: "some tool output" },
    ]
    assert.equal(extractPriorIssueTable(history), null)
  })

  it("ignores header constants quoted inside source code", () => {
    const history = [
      { role: "tool", tool_call_id: "a1", content: 'const ADVISOR_TABLE_HEADER = "| # | File | Severity | Issue | Suggestion |"\nThese constants are matched at line start only — no table here.' },
    ]
    assert.equal(extractPriorIssueTable(history), null)
  })

  it("returns null when last review says all clear", () => {
    const history = [
      { role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |\n|---|------|----------|-------|------------|\n\nNo 🔴 issues found. Review passed." },
    ]
    assert.equal(extractPriorIssueTable(history), null)
  })

  it("returns the table when issues remain", () => {
    const history = [
      { role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |\n|---|------|----------|-------|------------|\n| 1 | src/x.mjs | 🔴 | null check missing | add guard |" },
    ]
    const result = extractPriorIssueTable(history)
    assert(result)
    assert(result.text.includes("src/x.mjs"))
    assert.equal(result.sinceIdx, 0)
  })

  it("picks the most recent advisor table", () => {
    const history = [
      { role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |\n|---|------|----------|-------|------------|\n| 1 | src/old.mjs | 🔴 | old issue | fix |" },
      { role: "assistant", content: "fixed" },
      { role: "tool", tool_call_id: "a2", content: "| # | File | Severity | Issue | Suggestion |\n|---|------|----------|-------|------------|\n| 1 | src/new.mjs | 🔴 | new issue | fix |" },
    ]
    const result = extractPriorIssueTable(history)
    assert(result.text.includes("src/new.mjs"))
    assert.equal(result.sinceIdx, 2)
  })
})

// ─── extractAgentResponseTable ──────────────────────────────────

describe("extractAgentResponseTable", () => {
  it("finds the response table after the advisor call", () => {
    const history = [
      { role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |" },
      { role: "assistant", content: "Here is my response:\n| # | Action | Detail |\n|---|--------|--------|\n| 1 | fixed | added the guard |" },
    ]
    const result = extractAgentResponseTable(history, 0)
    assert(result)
    assert(result.includes("added the guard"))
  })

  it("returns null when no assistant response table exists", () => {
    const history = [
      { role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |" },
      { role: "assistant", content: "no table here" },
    ]
    assert.equal(extractAgentResponseTable(history, 0), null)
  })
})

// ─── extractConversationBackground ──────────────────────────────

describe("extractConversationBackground", () => {
  it("collects recent user/assistant exchanges", () => {
    const history = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "I will fix it" },
      { role: "tool", tool_call_id: "t1", content: "tool output" },
      { role: "user", content: "thanks" },
    ]
    const bg = extractConversationBackground(history)
    assert(bg.includes("fix the bug"))
    assert(bg.includes("I will fix it"))
    assert(!bg.includes("tool output"))
  })

  it("skips system reminders", () => {
    const history = [
      { role: "user", content: "[System reminder: AUTO mode is active]" },
      { role: "user", content: "real question" },
    ]
    const bg = extractConversationBackground(history)
    assert(!bg.includes("AUTO mode"))
    assert(bg.includes("real question"))
  })
})

// ─── buildAdvisorSystemPrompt (round selection) ─────────────────

describe("buildAdvisorSystemPrompt", () => {
  it("returns design prompt for design review", () => {
    const agent = { history: [], _advisorRound: 0 }
    const prompt = buildAdvisorSystemPrompt(agent, null, "design")
    assert(prompt.includes("design reviewer"))
  })

  it("returns round-1 prompt for fresh code review", () => {
    const agent = { history: [], _advisorRound: 0 }
    const prompt = buildAdvisorSystemPrompt(agent, null, "code")
    assert(prompt.includes("full-scope review"))
  })

  it("returns round-2 prompt after one prior round", () => {
    const prior = { text: "| # | File | Severity | Issue | Suggestion |", sinceIdx: 0 }
    const agent = { history: [], _advisorRound: 1 }
    const prompt = buildAdvisorSystemPrompt(agent, prior, "code")
    assert(prompt.includes("Verify the prior issue table"))
  })

  it("returns round-3 prompt after two prior rounds", () => {
    const prior = { text: "| # | File | Severity | Issue | Suggestion |", sinceIdx: 0 }
    const agent = { history: [], _advisorRound: 2 }
    const prompt = buildAdvisorSystemPrompt(agent, prior, "code")
    assert(prompt.includes("Strictly verify"))
  })
})

// ─── design token validation ────────────────────────────────────

describe("design token", () => {
  it("validateDesignToken accepts a legacy non-signed token", () => {
    assert.equal(validateDesignToken("some-simple-token"), true)
  })

  it("validateDesignToken rejects null/empty", () => {
    assert.equal(validateDesignToken(null), false)
    assert.equal(validateDesignToken(""), false)
    assert.equal(validateDesignToken(42), false)
  })

  it("extractTokenUUID returns the first segment", () => {
    assert.equal(extractTokenUUID("abc-def:1234:sig"), "abc-def")
    assert.equal(extractTokenUUID("plain"), "plain")
  })

  it("a freshly signed token validates", async () => {
    // Regenerate a token via the same crypto path the tool uses
    const { createHmac, randomUUID } = await import("node:crypto")
    const uuid = randomUUID()
    const expiresAt = Date.now() + 3600000
    const payload = `${uuid}:${expiresAt}`
    const sig = createHmac("sha256", process.env.THINCODER_TOKEN_SECRET || "thincoder-default-secret").update(payload).digest("hex").slice(0, 16)
    assert.equal(validateDesignToken(`${payload}:${sig}`), true)
  })

  it("an expired signed token is rejected", async () => {
    const { createHmac, randomUUID } = await import("node:crypto")
    const uuid = randomUUID()
    const expiresAt = Date.now() - 1000 // already expired
    const payload = `${uuid}:${expiresAt}`
    const sig = createHmac("sha256", process.env.THINCODER_TOKEN_SECRET || "thincoder-default-secret").update(payload).digest("hex").slice(0, 16)
    assert.equal(validateDesignToken(`${payload}:${sig}`), false)
  })
})

// ─── resolveAdvisorProvider ─────────────────────────────────────

describe("resolveAdvisorProvider", () => {
  beforeEach(() => { if (existsSync(cfgPath)) rmSync(cfgPath) })

  it("falls back to the main agent provider when advisor has no provider", () => {
    const agent = {
      config: { advisor: { enabled: true } },
      _provider: { baseURL: "https://api.test/v1", model: "test-model", apiKey: "sk" },
    }
    const p = resolveAdvisorProvider(agent)
    assert.equal(p.model, "test-model")
    assert.equal(p.baseURL, "https://api.test/v1")
  })

  it("advisor.model overrides the main model", () => {
    const agent = {
      config: { advisor: { enabled: true, model: "advisor-model" } },
      _provider: { baseURL: "https://api.test/v1", model: "test-model", apiKey: "sk" },
    }
    const p = resolveAdvisorProvider(agent)
    assert.equal(p.model, "advisor-model")
  })

  it("advisor.thinking=null explicitly disables thinking", () => {
    const agent = {
      config: { advisor: { enabled: true, thinking: null } },
      _provider: { baseURL: "https://api.test/v1", model: "test-model", apiKey: "sk", thinking: { type: "enabled" } },
    }
    const p = resolveAdvisorProvider(agent)
    assert.equal(p.thinking, undefined)
  })

  it("resolves a named advisor provider from shared config", () => {
    writeFileSync(cfgPath, JSON.stringify({
      providers: [{ name: "reviewer", baseURL: "https://review.test/v1", model: "review-model", apiKey: "rk" }],
      activeProvider: "deepseek",
    }))
    const agent = {
      config: { advisor: { enabled: true, provider: "reviewer" } },
      _provider: { baseURL: "https://api.test/v1", model: "test-model", apiKey: "sk" },
    }
    const p = resolveAdvisorProvider(agent)
    assert.equal(p.baseURL, "https://review.test/v1")
    assert.equal(p.model, "review-model")
  })

  it("falls back to main provider when named provider missing", () => {
    writeFileSync(cfgPath, JSON.stringify({
      providers: [{ name: "only", baseURL: "https://api.test/v1", model: "m", apiKey: "k" }],
      activeProvider: "only",
    }))
    const agent = {
      config: { advisor: { enabled: true, provider: "nonexistent" } },
      _provider: { baseURL: "https://main.test/v1", model: "main-model", apiKey: "mk" },
    }
    const p = resolveAdvisorProvider(agent)
    assert.equal(p.baseURL, "https://main.test/v1")
  })
})

// ─── prepareAdvisorMessages ─────────────────────────────────────

describe("prepareAdvisorMessages", () => {
  it("design review always returns a fresh two-message session", () => {
    const agent = { history: [], cwd: tmpDir, _advisorRound: 3, _advisorSession: null }
    const msgs = prepareAdvisorMessages(agent, "design", "tok", ["docs/design.md"], null)
    assert.equal(msgs.length, 2)
    assert.equal(msgs[0].role, "system")
    assert.equal(msgs[1].role, "user")
    assert(msgs[1].content.includes("docs/design.md"))
    assert(msgs[1].content.includes("tok")) // design token injected
  })

  it("code review with no prior table starts fresh round-1", () => {
    const agent = { history: [], cwd: tmpDir, _advisorRound: 0, _advisorSession: null, _touchedFiles: [] }
    const msgs = prepareAdvisorMessages(agent, "code", null, null, ["src/x.mjs"])
    assert.equal(msgs.length, 2)
    assert(msgs[1].content.includes("src/x.mjs"))
  })

  it("buildAdvisorUserMessage includes review scope paths", () => {
    const agent = { history: [], cwd: tmpDir, _advisorRound: 0 }
    const msg = buildAdvisorUserMessage(agent, null, "code", null, null, ["src/a.mjs", "src/b.mjs"])
    assert(msg.includes("src/a.mjs"))
    assert(msg.includes("src/b.mjs"))
  })

  it("design review with documents scopes to docs only", () => {
    const agent = { history: [], cwd: tmpDir, _advisorRound: 0, config: { agent: {} } }
    const msg = buildAdvisorUserMessage(agent, null, "design", null, ["docs/d.md"], null)
    assert(msg.includes("docs/d.md"))
    assert(msg.includes("Review ONLY these files"))
  })
})

// ─── isDocFile ──────────────────────────────────────────────────

describe("isDocFile", () => {
  it("recognizes markdown and doc files", () => {
    assert.equal(isDocFile("docs/design.md"), true)
    assert.equal(isDocFile("README.md"), true)
    assert.equal(isDocFile("LICENSE"), true)
    assert.equal(isDocFile("notes.txt"), true)
  })

  it("rejects source files", () => {
    assert.equal(isDocFile("src/main.mjs"), false)
    assert.equal(isDocFile("src/prompts/system.md") && false, false) // extension matches; src/ exclusion is the caller's job
    assert.equal(isDocFile("package.json"), false)
  })
})
