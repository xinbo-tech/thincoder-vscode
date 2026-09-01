/**
 * tools/execute.mjs — JavaScript execution tool (VS Code).
 *
 * Runs JS in a child `node --input-type=module --eval` process (NOT the old
 * in-process vm sandbox). The vm route could not support dynamic `import()` or
 * await it (both need --experimental-vm-modules), which pushed every real JS
 * run back to `bash node -e`. A child node process gives top-level await,
 * dynamic `import()` of the project's own .mjs modules, native console/fetch,
 * AND a killable timeout (an in-process infinite loop would freeze the
 * extension host; a child process is killed).
 *
 * The child `import()`-s exec-prelude.mjs first for readFile/writeFile/glob/
 * grep/log/require (paths confined to the workspace root). Full Node via
 * require()/process/import() is available — same boundary as bash.
 *
 * Two modes: inline `code` (prelude + eval) OR `scriptFile` (run a workspace
 * .mjs/.js file with node [nodeArgs...], self-contained — for `node <script>` /
 * `node --test <file>` / `node --check <file>`). Both run as real node child
 * processes — NO directory restrictions (bash parity, TOOLS.md §10.1).
 */
import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const MAX_SCRIPT = 50_000
const MAX_OUTPUT = 50_000
const DEFAULT_TIMEOUT = 30_000

const __dirname = dirname(fileURLToPath(import.meta.url))
const PRELUDE_URL = pathToFileURL(resolve(__dirname, "exec-prelude.mjs")).href

/** Resolve workdir relative to cwd (no workspace boundary assertion — bash parity,
 *  TOOLS.md §10.1 D-W1: paths are resolved, not restricted). */
function resolveBaseDir(cwd, workdir) {
  if (!workdir || typeof workdir !== "string") return cwd
  return resolve(cwd, workdir)
}

/** Keep only output lines matching a regex (execute filter, case-insensitive). */
function applyFilter(output, filter) {
  try {
    const re = new RegExp(filter, "i")
    const lines = output.split("\n").filter((l) => re.test(l))
    return lines.length ? lines.join("\n") : `(no output lines matched filter "${filter}")`
  } catch (e) {
    return `Error: filter regex invalid: ${e.message}`
  }
}

/** Spawn node, run code + prelude, capture stdout/stderr, enforce timeout/abort.
 *  Resolves { text, ok } — ok=false on non-zero exit / timeout / abort. */
function runNode(childArgs, baseDir, root, timeoutMs, signal) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, childArgs, {
      cwd: baseDir,
      env: { ...process.env, THINCODER_EXEC_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    let outBuf = "", errBuf = "", truncated = false, settled = false, mode = null
    let timer = null, kickTimer = null

    const settle = (text, ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(kickTimer)
      if (signal) signal.removeEventListener("abort", onAbort)
      resolvePromise({ text, ok })
    }
    // SIGKILL (not SIGTERM) so a signal-trapping script can't dodge the watchdog.
    const kill = () => { try { child.kill("SIGKILL") } catch { /* already gone */ } }
    // After kill, wait for "close" (child fully reaped) before settling — settling
    // early races the caller deleting the cwd dir while the child still holds it.
    const armKick = () => { kickTimer = setTimeout(() => settle(mode === "abort" ? "(stopped)" : `Error: script timed out after ${timeoutMs}ms`, false), 3000) }
    const onAbort = () => { if (mode) return; mode = "abort"; kill(); armKick() }

    timer = setTimeout(() => { if (!mode) { mode = "timeout"; kill(); armKick() } }, timeoutMs)

    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }

    const cap = (buf, d) => {
      if (buf.length < MAX_OUTPUT) return buf + d
      if (!truncated) { truncated = true; return buf + "\n...[output truncated]" }
      return buf
    }
    child.stdout.on("data", (d) => { outBuf = cap(outBuf, d.toString()) })
    child.stderr.on("data", (d) => { errBuf = cap(errBuf, d.toString()) })
    child.on("error", (e) => settle(`Error: failed to start node: ${e.message}`, false))
    child.on("close", (code) => {
      if (mode === "abort") return settle("(stopped)", false)
      if (mode === "timeout") return settle(`Error: script timed out after ${timeoutMs}ms`, false)
      const out = outBuf.trimEnd()
      const err = errBuf.trim()
      if (code === 0) {
        settle(out || "(no output)", true)
      } else {
        settle(err ? (out ? `${out}\n\n[stderr]:\n${err}` : err) : `${out}\n(exit code ${code})`.trim(), false)
      }
    })
  })
}

/** Validate nodeArgs (extra node flags for scriptFile mode, e.g. --test / --check). Forbids
 *  eval-like flags that would conflict with scriptFile mode or re-open inline injection. */
function validateNodeArgs(nodeArgs) {
  if (!nodeArgs) return []
  const arr = Array.isArray(nodeArgs) ? nodeArgs : String(nodeArgs).split(/\s+/).filter(Boolean)
  const forbidden = /^(--eval|-e|--input-type|--print|-p|--inspect|--inspect-brk)(=|$)/i
  for (const a of arr) {
    if (forbidden.test(a)) throw new Error(`nodeArgs flag not allowed: ${a}`)
  }
  return arr
}

export const executeTool = {
  name: "execute",
  description:
    "Execute JavaScript — either inline `code` or a workspace `scriptFile` — in a real node process with full Node access (top-level await and dynamic import() supported). Use inline code to compose multiple operations into one call — read, write, glob, grep, log, import, or require() — instead of shelling out to bash node -e.\n" +
    "Route to execute instead of bash: `node -e \"…\"` → execute (inline code); `node <script.mjs>` → execute scriptFile; `node --test <file>` / `node --check <file>` → execute scriptFile + nodeArgs.\n" +
    "Parameters:\n" +
    "- code: JavaScript to run inline. Top-level await and import('./x.mjs') work. Globals: readFile(path), writeFile(path, content), glob(pattern), grep(pattern, file), log(...args) — plus native require/process/console/fetch/import. Use this OR scriptFile.\n" +
    "- scriptFile: run a workspace .mjs/.js file with node (self-contained, no prelude). Path relative to workdir (no directory restrictions). Use this OR code.\n" +
    "- nodeArgs: (scriptFile) extra node flags before the script, e.g. [\"--test\"], [\"--check\"]. Eval-like flags rejected.\n" +
    "- workdir: run in this directory (relative to cwd, no directory restrictions)\n" +
    "- filter: optional — only return output lines matching this regex (case-insensitive)\n" +
    "- timeoutMs: Timeout in milliseconds (default 30000, max 600000 — covers node --test suites / package scripts). Use bash for servers and interactive programs.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "JavaScript code to execute (top-level await and dynamic import() supported). Globals: readFile/writeFile/glob/grep/log + native require/process/console/fetch/import. Use this OR scriptFile.",
      },
      scriptFile: {
        type: "string",
        description: "Run a workspace .mjs/.js file with node (self-contained, no prelude). Path relative to workdir, no directory restrictions. Use this OR code. For `node <script>` / `node --test <file>` / `node --check <file>`.",
      },
      nodeArgs: {
        type: "array",
        items: { type: "string" },
        description: "(scriptFile) Extra node flags before the script, e.g. [\"--test\"], [\"--check\"]. Eval-like flags (--eval/--input-type/--inspect) are rejected.",
      },
      workdir: {
        type: "string",
        description: "Run in this directory (relative to cwd, no directory restrictions)",
      },
      filter: {
        type: "string",
        description: "Optional: only return output lines matching this regex (case-insensitive)",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: 600000,
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT}, max 600000)`,
      },
    },
    required: [],
  },
  readonly: false,

  async execute(args, ctx) {
    let baseDir
    try { baseDir = resolveBaseDir(ctx.cwd, args.workdir) }
    catch (e) { return `Error: ${e.message}` }

    const t = Number(args.timeoutMs)
    const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(t, 600_000) : DEFAULT_TIMEOUT

    let childArgs
    if (args.scriptFile) {
      if (args.code?.trim()) return "Error: pass code OR scriptFile, not both"
      // scriptFile mode: run a workspace .mjs/.js file with node [nodeArgs...]. Self-contained —
      // no prelude (a real node process imports what it needs). No directory restrictions (bash parity).
      const scriptAbs = resolve(baseDir, args.scriptFile)
      let nodeArgs
      try { nodeArgs = validateNodeArgs(args.nodeArgs) }
      catch (e) { return `Error: ${e.message}` }
      childArgs = [...nodeArgs, scriptAbs]
    } else {
      const code = args.code ?? ""
      if (!code.trim()) return "Error: either code or scriptFile is required"
      if (code.length > MAX_SCRIPT) {
        return `Error: script too large (${code.length} > ${MAX_SCRIPT} bytes). Split into smaller scripts or use individual tools.`
      }
      childArgs = ["--input-type=module", "--eval", `await import(${JSON.stringify(PRELUDE_URL)});\n${code}`]
    }

    const { text, ok } = await runNode(childArgs, baseDir, ctx.cwd, timeoutMs, ctx.signal)
    // Only filter successful output — never swallow an error report behind a filter.
    if (!ok) return text
    return args.filter ? applyFilter(text, args.filter) : text
  },
}