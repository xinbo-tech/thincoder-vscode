/**
 * mcp/utils.mjs — shared utilities and constants for MCP transports
 */

// ─── constants ──────────────────────────────────────────────────

export const INIT_TIMEOUT_MS = 30_000
export const CALL_TIMEOUT_MS = 120_000
export const ENDPOINT_WAIT_MS = 5_000

// ─── utilities ──────────────────────────────────────────────────

let _nextRpcId = 0
export function rpcId() { return String(++_nextRpcId) }

export function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout])
}

export function quoteArg(s) {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function sanitizeToolName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}
