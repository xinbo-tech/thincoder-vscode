/**
 * tools/execute.mjs — sandboxed JS execution tool (VS Code port of CLI tools/codemode.mjs)
 *
 * Gives the model an `execute` tool backed by Node.js vm.Script.runInNewContext.
 * Multiple tool calls can be composed into a single script, reducing API round-trips
 * and keeping large intermediate results out of context.
 *
 * Sandbox API (all sync, no callbacks):
 *   readFile(path)      — read a file relative to cwd, return string
 *   writeFile(path, c)  — write content to a file (auto-creates parent dirs)
 *   glob(pattern)        — return array of matching paths
 *   grep(pattern, file)  — return array of matching lines
 *   log(...args)         — append to output buffer
 *   fetch(url)           — HTTP GET, return string (SSRF-protected)
 *
 * Not available: require, import, process, child_process, setTimeout, any Node API.
 *
 * Limits:
 *   timeout: 30s (configurable via timeoutMs param, max 60s)
 *   maxOutput: 50000 bytes
 *   maxScriptSize: 50000 bytes
 *
 * The glob/normalizeEOL/isPrivateHost helpers are inlined (CLI keeps them in shared.mjs)
 * so this module stays pure Node with no vscode import — the sandbox must not touch the editor.
 */

import { Script, createContext } from "node:vm"
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

/** SSRF guard: block cloud-metadata and RFC1918 hosts (CLI shared.mjs isPrivateHost parity). */
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase()
  if (h === "localhost" || h === "0.0.0.0" || h.endsWith(".localhost")) return false
  if (h === "127.0.0.1" || h.startsWith("127.")) return false
  if (h === "169.254.169.254" || h === "metadata.google.internal") return true
  // IPv6 private ranges — only check if host contains ":"
  if (h.includes(":") && (h === "::1" || h === "fe80::1" || h.startsWith("fc") || h.startsWith("fd"))) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || a === 192 && b === 168 || a === 169 && b === 254 || a === 0) return true
  }
  return false
}

/** SSRF-safe fetch: only http/https, private IP rejection, 10s timeout.
 *  Validation throws SYNCHRONOUSLY so the vm sandbox's try/catch can catch it —
 *  an async throw here would become an unhandled rejection and crash the host. */
function sandboxFetch(url) {
  const parsed = new URL(url)
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`CodeMode fetch: protocol not allowed: ${parsed.protocol}`)
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`CodeMode fetch: private/internal host not allowed: ${parsed.hostname}`)
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
    "Execute sandboxed JavaScript code. Use this to compose multiple file operations into one call — read, write, glob, grep, and log results. No system access. Max 30s timeout, 50KB output.\n" +
    "Parameters:\n" +
    "- code (required): JavaScript code to execute in the sandbox. Use provided functions: readFile(path), writeFile(path, content), glob(pattern), grep(pattern, file), log(...args).\n" +
    "- timeoutMs: Timeout in milliseconds (default 30000, max 60000)",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "JavaScript code to execute in the sandbox. Use provided functions: readFile(path), writeFile(path, content), glob(pattern), grep(pattern, file), log(...args).",
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

    // File path guard: ensure paths are within cwd
    function safePath(p) {
      if (typeof p !== "string") throw new Error(`Path must be a string, got ${typeof p}`)
      const abs = resolve(cwd, p)
      const rel = relative(cwd, abs)
      if (rel.startsWith("..") || (rel.includes("..") && process.platform === "win32")) {
        throw new Error(`Path traversal denied: ${p}`)
      }
      return abs
    }

    // Block dynamic imports: check for import() syntax before execution
    if (/\bimport\s*\(/.test(code)) {
      return "Error: dynamic import() is not allowed in CodeMode sandbox. Use the provided readFile/writeFile/glob/grep/fetch functions instead."
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
      // Block process and require access
      require: () => { throw new Error("require() is not available in CodeMode sandbox") },
      process: undefined,
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
