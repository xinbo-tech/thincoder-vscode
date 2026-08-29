/**
 * image-handler.mjs — save pasted images to temp files
 * Extracted from extension.mjs ChatPanel class.
 *
 * Plan B (GitHub thincoder#3, 2026-08-29): the webview sends dataURLs with
 * `userMessage`; the EXTENSION saves each to <cwd>/.thincoder/tmp/paste-*.png
 * and passes the absolute paths as runOpts.images. setupAgentRun appends an
 * "[Attached images: ...]" pointer to the user message text; the model then
 * calls the read_image tool, whose multimodal path (execute-tools.mjs) injects
 * the image part into the payload. Pasted images no longer ride inline in the
 * request — they flow through the same reliable tool path as read_image.
 *
 * Cleanup: files land in .thincoder/tmp/, which offloadToolResult
 * (src/agent/run-helpers.mjs) sweeps by mtime (TMP_RETENTION_MS) on every
 * offload write — paste-* files are covered by that sweep, no name filter.
 */

import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/** dataURL → { ext, buffer } | null. Raster mime types only; oversized (>15 MB, aligned with
 *  read_image's MAX_IMAGE_BYTES) returns null so a giant paste is skipped at save time
 *  instead of failing later inside the read_image tool call. */
function parseDataUrl(dataUrl) {
  const m = typeof dataUrl === "string" ? dataUrl.match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/) : null
  if (!m) return null
  const ext = m[1] === "jpeg" ? "jpg" : m[1]
  const buffer = Buffer.from(m[2], "base64")
  if (buffer.length === 0) return null // empty payload — nothing to write
  if (buffer.length > 15 * 1024 * 1024) return null // oversized — read_image would reject it anyway
  return { ext, buffer }
}

/**
 * Save pasted data-URL images to <cwd>/.thincoder/tmp/paste-<id>-<i>.<ext>.
 * Invalid entries (non-dataURL, empty payload) are skipped; write failures are
 * skipped; returns the absolute paths that actually landed on disk ([] when none).
 */
export function savePastedImages(dataUrls, cwd) {
  if (!Array.isArray(dataUrls) || dataUrls.length === 0) return []
  const parsed = dataUrls.map(parseDataUrl).filter(Boolean)
  if (parsed.length === 0) return [] // all-invalid input — no directory, no files
  const tmpDir = join(cwd, ".thincoder", "tmp")
  try { mkdirSync(tmpDir, { recursive: true }) } catch { return [] }
  const paths = []
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6) // run id — offloadToolResult naming parity
  for (let i = 0; i < parsed.length; i++) {
    const fpath = join(tmpDir, `paste-${id}-${i}.${parsed[i].ext}`)
    try { writeFileSync(fpath, parsed[i].buffer) } catch { continue }
    paths.push(fpath)
  }
  return paths
}
