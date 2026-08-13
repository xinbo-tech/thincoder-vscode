/**
 * tools/execute.mjs — JavaScript execution tool (VS Code port of CLI tools/codemode.mjs)
 *
 * Backed by Node.js vm.Script.runInNewContext. Multiple tool calls can be composed
 * into a single script, reducing API round-trips and keeping large intermediate
 * results out of context.
 *
 * Sandbox API:
 *   readFile(path)      — read a file relative to cwd, return string
 *   writeFile(path, c)  — write content to a file (auto-creates parent dirs)
 *   glob(pattern)        — return array of matching paths
 *   grep(pattern, file)  — return array of matching lines
 *   log(...args)         — append to output buffer
 *   fetch(url)           — HTTP GET, return string
 *
 * Full Node access via require()/process is available — no fake sandbox. The bash
 * tool can already reach any Node API, so blocking require here only misled the
 * model about its real capability boundary (project philosophy: no command-level
 * sandbox; transparency + trust + audit).
 *
 * Limits (engineering guards, not security):
 *   timeout: 30s (configurable via timeoutMs param, max 60s)
 *   maxOutput: 50000 bytes
 *   maxScriptSize: 50000 bytes
 *   file paths confined to cwd (accidental out-of-workspace writes)
 */

import { Script, createContext } from "node:vm"
import { createRequire } from "node:module"
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs"
import { join, dirname, relative, resolve } from "node:path"

const MAX_OUTPUT = 50_000
const MAX_SCRIPT = 50_000
const DEFAULT_TIMEOUT = 30_000

/** Normalize Windows line endings to Unix: \r\n → \n (CLI shared.mjs parity). */
function normalizeEOL(text) {
  return text.replace(/\r\n/g, "\n")
}

/** Glob pattern → anchored RegExp (CLI shared.mjs globToRegex parity). */
function globToRegex(pattern) {
  const DS = "\u0001", DP = "\u0002"
  const escaped = pattern
    .replace(/\*\*\//g, DS).replace(/\*\*/g, DP)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
    .replace(new RegExp(DS, "g"), "(?:.+/)?")
    .replace(new RegExp(DP, "g"), ".*")
  return new RegExp(`^${escaped}$`)
}

/** fetch: only http/https (protocol guard kept; no private-host rejection — the
 *  bash tool can reach anything anyway, so the SSRF check was a fake boundary).
 *  Validation throws SYNCHRONOUSLY so the vm sandbox's try/catch can catch it —
 *  an async throw here would become an unhandled rejection and crash the host. */
function sandboxFetch(url) {
  const parsed = new URL(url)
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`CodeMode fetch: protocol not allowed: ${parsed.protocol}`)
  }
  return doFetch(url)
}

async function doFetch(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    const text = await res.text()
    return text.slice(0, 100_000)
  } finally {
    clearTimeout(timer)
  }
}

export const executeTool = {
  name: "execute",
  description:
    "Execute JavaScript code with full Node access. Use this to compose multiple file operations into one call — read, write, glob, grep, log, or require() any module. Max 30s timeout, 50KB output.\n" +
    "Parameters:\n" +
    "- code (required): JavaScript code to execute. Use provided functions: readFile(path), writeFile(path, content), glob(pattern), grep(pattern, file), log(...args). require()/process/Node modules are available.\n" +
    "- timeoutMs: Timeout in milliseconds (default 30000, max 60000)",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "JavaScript code to execute. Use provided functions: readFile(path), writeFile(path, content), glob(pattern), grep(pattern, file), log(...args). require()/process/Node modules are available.",
      },
      timeoutMs: {
        type: "integer",
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT}, max 60000)`,
      },
    },
    required: ["code"],
  },
  readonly: false,

  async execute(args, ctx) {
    const cwd = ctx.cwd
    const code = args.code ?? ""

    if (code.length > MAX_SCRIPT) {
      return `Error: script too large (${code.length} > ${MAX_SCRIPT} bytes). Split into smaller scripts or use individual tools.`
    }

    const output = []
    const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT, 60_000)

    // File path guard: ensure paths are within cwd (accidental out-of-workspace writes)
    function safePath(p) {
      if (typeof p !== "string") throw new Error(`Path must be a string, got ${typeof p}`)
      const abs = resolve(cwd, p)
      const rel = relative(cwd, abs)
      if (rel.startsWith("..") || (rel.includes("..") && process.platform === "win32")) {
        throw new Error(`Path traversal denied: ${p}`)
      }
      return abs
    }

    const sandbox = createContext({
      readFile: (p) => {
        const abs = safePath(p)
        if (!existsSync(abs)) throw new Error(`File not found: ${p}`)
        const st = statSync(abs)
        if (st.size > 5_000_000) throw new Error(`File too large: ${p} (${Math.round(st.size / 1000000)}MB)`)
        return normalizeEOL(readFileSync(abs, "utf8"))
      },
      writeFile: (p, content) => {
        const abs = safePath(p)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, String(content), "utf8")
      },
      glob: (pattern) => {
        if (typeof pattern !== "string") throw new Error("glob pattern must be a string")
        const regex = globToRegex(pattern)
        const results = []
        function walk(dir, rel) {
          let entries
          try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
          for (const e of entries) {
            if (e.name.startsWith(".") || e.name === "node_modules") continue
            const relPath = rel ? `${rel}/${e.name}` : e.name
            if (e.isDirectory()) { walk(join(dir, e.name), relPath) }
            else if (regex.test(relPath)) results.push(relPath)
          }
        }
        walk(cwd, "")
        return results.slice(0, 200)
      },
      grep: (pattern, file) => {
        if (typeof pattern !== "string") throw new Error("grep pattern must be a string")
        if (typeof file !== "string") throw new Error("grep file must be a string")
        const abs = safePath(file)
        if (!existsSync(abs)) throw new Error(`File not found: ${file}`)
        const content = normalizeEOL(readFileSync(abs, "utf8"))
        const regex = new RegExp(pattern)
        const lines = content.split("\n")
        const matches = []
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) matches.push(`${i + 1}: ${lines[i].slice(0, 200)}`)
        }
        return matches.slice(0, 100)
      },
      log: (...args) => {
        const line = args.map((a) => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")
        output.push(line)
        if (output.join("\n").length > MAX_OUTPUT) {
          output.push("... (output truncated)")
          throw new Error("CodeMode output limit exceeded")
        }
      },
      fetch: sandboxFetch,
      // Full Node access — no fake sandbox (bash can reach it anyway).
      require: createRequire(join(cwd, "__codemode__.js")),
      process,
      setTimeout,
      clearTimeout,
    })

    try {
      const script = new Script(code, { filename: "codemode.js" })
      // timeout goes to runInContext, not the Script constructor (CLI bug: constructor ignores it)
      script.runInContext(sandbox, { timeout: timeoutMs })
      return output.join("\n") || "(no output)"
    } catch (err) {
      const out = output.join("\n")
      const prefix = out ? `${out}\n\n` : ""
      return `${prefix}Error: ${err.message}`
    }
  },
}
