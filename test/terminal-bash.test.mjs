/**
 * terminal-bash.test.mjs — bash tool terminal modes (A: visible / B: inject).
 * Uses the vscode mock: tests stub window.activeTerminal / createTerminal.
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import * as vscode from "vscode"
import { bashTool } from "../src/tools/shell.mjs"

function fakeTerminal({ chunks = [], withSI = true } = {}) {
  const sent = []
  const term = {
    name: "ThinCoder",
    sent,
    shown: 0,
    show() { term.shown++ },
    sendText: (text, execute) => sent.push([text, execute]),
    shellIntegration: withSI
      ? { executeCommand: (_cmd) => ({ read: async function* () { for (const c of chunks) yield c } }) }
      : undefined,
  }
  return term
}

beforeEach(() => {
  vscode.window.terminals.length = 0
  vscode.window.activeTerminal = undefined
})

describe("bash terminal modes", () => {
  it("inject: fills the command into the terminal WITHOUT executing", async () => {
    const term = fakeTerminal()
    vscode.window.activeTerminal = term
    const r = await bashTool.execute({ command: "npm test", terminal: "inject" }, { cwd: process.cwd() })
    assert.deepEqual(term.sent, [["npm test", false]], "sendText(cmd, false) — filled, not run")
    assert.ok(term.shown > 0, "terminal revealed")
    assert.match(r, /NOT executed/)
    assert.match(r, /do NOT report a result/)
  })

  it("visible: runs via shell integration and returns stripped output", async () => {
    const term = fakeTerminal({ chunks: ["[32mWrote 1 file[0m\n", "done\n"] })
    vscode.window.activeTerminal = term
    const r = await bashTool.execute({ command: "echo hi", terminal: "visible" }, { cwd: process.cwd() })
    assert.match(r, /Wrote 1 file/)
    assert.ok(!/\x1b\[/.test(r), "ANSI escape codes stripped") // eslint-disable-line no-control-regex
    assert.match(r, /exit code unavailable in terminal mode/)
  })

  it("visible + Stop: sends Ctrl+C to the terminal and finishes (stopped)", async () => {
    // Stream that never ends on its own — only the abort resolves it.
    const term = {
      name: "ThinCoder",
      sent: [],
      show() {},
      sendText(t, e) { term.sent.push([t, e]) },
      shellIntegration: {
        executeCommand: () => ({ read: async function* () { yield "starting\n"; await new Promise(() => {}) } }),
      },
    }
    vscode.window.activeTerminal = term
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    const r = await bashTool.execute({ command: "sleep 999", terminal: "visible" }, { cwd: process.cwd(), signal: ctrl.signal })
    assert.match(r, /\(stopped\)/)
    assert.deepEqual(term.sent, [["\x03", undefined]], "Ctrl+C sent to interrupt the foreground process")
  })

  it("visible falls back to the child process when shell integration is unavailable", async () => {
    vscode.window.activeTerminal = undefined
    vscode.window.createTerminal = () => fakeTerminal({ withSI: false })
    const r = await bashTool.execute({ command: "node -e \"console.log('fallback-ok')\"", terminal: "visible" }, { cwd: process.cwd() })
    assert.match(r, /fallback-ok/, "child-process fallback ran the command")
    assert.match(r, /exit code 0/)
  })
})
