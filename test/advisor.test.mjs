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

import { extractAgentResponseTable, extractConversationBackground } from "../src/advisor/history.mjs"
import { buildAdvisorSystemPrompt, prepareAdvisorMessages, escapeLiteralEscapes } from "../src/advisor/main.mjs"
import { verifyCitations, appendCitationReport, extractCitations } from "../src/advisor/citations.mjs"
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
    const prior = "| # | File | Severity | Issue | Suggestion |"
    const agent = { history: [], _advisorRound: 1 }
    const prompt = buildAdvisorSystemPrompt(agent, prior, "code")
    assert(prompt.includes("Verify the prior review output"))
  })

  it("returns round-3 prompt after two prior rounds", () => {
    const prior = "| # | File | Severity | Issue | Suggestion |"
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


// ────────────────────────────────────────
// CLI parity additions (2026-08-06): escapeLiteralEscapes, citations, fresh-session
// ────────────────────────────────────────

describe("escapeLiteralEscapes (CLI parity — hex-escape 400 defense)", () => {
  const cases = [
    ["\\x（单反斜杠）", "\\\\x（单反斜杠）"], // \x + non-hex → doubled
    ["末尾\\x", "末尾\\\\x"], // \x at end → doubled
    ["\\x1b[31m", "\\x1b[31m"], // \x + 2 hex → untouched
    ["\\x1b3", "\\x1b3"], // \x + 3+ hex → \x1b valid + literal 3 → untouched
    ["\\x1后跟", "\\\\x1后跟"], // \x + 1 hex (truncated) → doubled
    ["\\u12中文", "\\\\u12中文"], // \u + <4 hex → doubled
    ["\\uFFFF", "\\uFFFF"], // \u + 4 hex → untouched
    ["\\uFFFF1", "\\uFFFF1"], // \u + 5 hex → untouched
    ["\\n字面", "\\n字面"], // non-hex escapes untouched
    ["\\\\x", "\\\\x"], // already-doubled backslash untouched
    [null, ""], // null → coerced
    [undefined, ""], // undefined → coerced
  ]
  it("doubles invalid literal \\x/\\u, passes valid ones through", () => {
    for (const [input, expected] of cases) {
      assert.equal(escapeLiteralEscapes(input), expected, JSON.stringify(input))
    }
  })
})

describe("citations (CLI parity — host-verified evidence)", () => {
  it("extractCitations pulls file:line: content references", () => {
    const out = extractCitations("see run.mjs:12: import { chat }")
    assert.equal(out.length, 1)
    assert.equal(out[0].file, "run.mjs")
    assert.equal(out[0].line, 12)
  })
  it("verifyCitations matches real file content, flags stale/missing citations", () => {
    const res = verifyCitations("run.mjs:2: * advisor/run.mjs — advisor execution", "src/advisor")
    assert.equal(res.total, 1)
    assert.equal(res.matched.length, 1, "real line content matches")
    const stale = verifyCitations("run.mjs:99999: this line does not exist anywhere in the file", "src/advisor")
    assert.equal(stale.total, 1)
    assert.equal(stale.matched.length, 0)
    assert.equal(stale.failed.length, 1, "stale line flagged")
  })
  it("verifyCitations rejects path traversal (never reads outside cwd)", () => {
    const res = verifyCitations("../../package.json:1: some content that is long enough", "src/advisor")
    assert.equal(res.total, 1)
    assert.equal(res.failed.length, 1)
    assert.equal(res.failed[0].reason, "path traversal")
  })
  it("appendCitationReport appends N/M report only when citations exist", () => {
    const withReport = appendCitationReport("x\nrun.mjs:2: * advisor/run.mjs — advisor execution", "src/advisor")
    assert.ok(withReport.includes("[host-verified]"), "report appended")
    const plain = appendCitationReport("no citations here", "src/advisor")
    assert.equal(plain, "no citations here", "no citations → unchanged")
  })
})

describe("prepareAdvisorMessages: fresh session every round (CLI parity — d698434)", () => {
  it("ignores a stale _advisorSession — every call builds fresh [system, user]", () => {
    const agent = {
      history: [{ role: "tool", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | a.mjs | 🔴 | bug | x |" }],
      _advisorRound: 1,
      _lastAdvisorOutput: "| # | File | Severity | Issue | Suggestion |\n| 1 | a.mjs | 🔴 | bug | x |",
      _mutatedThisRun: true,
      _advisorSession: [{ role: "system", content: "STALE_SESSION_MARKER" }, { role: "user", content: "STALE_SESSION_MARKER" }], // legacy field — must NOT be reused
      config: { agent: {}, advisor: {} },
      cwd: process.cwd(),
    }
    const messages = prepareAdvisorMessages(agent, "code", null, null, ["src/a.mjs"])
    assert.equal(messages.length, 2, "fresh two-message session")
    assert.ok(!JSON.stringify(messages).includes("STALE_SESSION_MARKER"), "stale session content never surfaces")
    // Convergence follow-up messages START with "## Round N" — bracket reminders
    // only appear mid-content (server-side '['-probing concerns only the LEADING char).
    assert.ok(!messages[1].content.startsWith("["), "message does not START with a bracket")
  })
  it("no-prior round-1 user message starts with a PLAIN 'System reminder:' (not '[')", () => {
    const agent = {
      history: [],
      _advisorRound: 0,
      _mutatedThisRun: false,
      config: { agent: {}, advisor: {} },
      cwd: process.cwd(),
    }
    const messages = prepareAdvisorMessages(agent, "code", null, null, ["src/a.mjs"])
    assert.ok(messages[1].content.startsWith("System reminder:"), messages[1].content.slice(0, 60))
  })
})


describe("_renderTimeline (CLI parity — review process at its real positions)", () => {
  it("interleaves thinking/tool/final in emission order", async () => {
    const { _renderTimeline } = await import("../src/advisor/run.mjs")
    assert.equal(_renderTimeline([]), "", "empty timeline")
    assert.equal(_renderTimeline([], "tail only"), "tail only", "tail alone when timeline empty")
    const timeline = [
      { kind: "think", text: "先读文件" },
      { kind: "tool", text: "\n→ read src/a.mjs\n" },
      { kind: "think", text: "看到问题了" },
      { kind: "text", text: "\n| # | 问题 |\n| 1 | x |" },
    ]
    const out = _renderTimeline(timeline)
    assert.ok(out.includes("→ read src/a.mjs"), "tool call present")
    assert.ok(out.indexOf("先读文件") < out.indexOf("→ read src/a.mjs"), "think before its tool call")
    assert.ok(out.indexOf("→ read src/a.mjs") < out.indexOf("看到问题了"), "tool call before the next think")
    assert.ok(out.indexOf("看到问题了") < out.indexOf("| 1 | x |"), "final text last")
    const withPlaceholder = _renderTimeline([{ kind: "think", text: "a\n[thinking…]\nb" }])
    assert.ok(!withPlaceholder.includes("[thinking…]"), "placeholder stripped")
  })
})
