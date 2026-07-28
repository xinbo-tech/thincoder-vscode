/**
 * read_image.mjs — Image reading tool: read_image
 */

import { readFileSync } from "node:fs"
import { resolvePath } from "./shared.mjs"

export const readImageTool = {
  name: "read_image",
  readonly: true,
  description:
    "Read an image file and return it as base64 data. Supports png, jpg, gif, webp, bmp, svg.\n" +
    "Parameters:\n" +
    "- path (required): Image file path",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Image file path" },
    },
    required: ["path"],
  },
  async execute({ path }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    try {
      const data = readFileSync(abs)
      const ext = abs.split(".").pop()?.toLowerCase()
      const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" }[ext] || "image/png"
      const b64 = data.toString("base64")
      return `data:${mime};base64,${b64.slice(0, 100)}... (${data.length} bytes, full base64 in tool result)`
    } catch (e) {
      return `Error reading image: ${e.message}`
    }
  },
}
