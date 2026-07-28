/**
 * shared.mjs — Helper functions and constants shared across tool modules
 */

import { join } from "node:path"

export const BASH_TIMEOUT_MS = 120000

/** Resolve a path relative to cwd or absolute */
export function resolvePath(p, cwd) {
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return p
  return join(cwd, p)
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
