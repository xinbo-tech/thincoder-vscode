/**
 * image-handler.mjs — save pasted images to temp files
 * Extracted from extension.mjs ChatPanel class.
 */

import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/** Save pasted data-URL images to .thincoder/tmp/, return appended prompt text */
export function savePastedImages(images, cwd, baseText) {
  if (!images || images.length === 0) return baseText
  const tmpDir = join(cwd, ".thincoder", "tmp")
  try { mkdirSync(tmpDir, { recursive: true }) } catch {}
  const paths = []
  for (let i = 0; i < images.length; i++) {
    const m = images[i].match(/^data:image\/(\w+);base64,(.+)$/)
    if (!m) continue
    const ext = m[1] === "jpeg" ? "jpg" : m[1]
    const fname = `paste-${Date.now().toString(36)}-${i}.${ext}`
    const fpath = join(tmpDir, fname)
    try { writeFileSync(fpath, Buffer.from(m[2], "base64")) } catch { continue }
    paths.push(fpath)
  }
  if (paths.length > 0) {
    return `${baseText}\n\n[Attached images: ${paths.join(", ")}. Use read_image to view them.]`
  }
  return baseText
}
