/**
 * read_image.mjs — Image reading tool: read_image
 * Returns multimodal JSON { text, images } for the agent loop to inject as user message.
 */

import { readFileSync, statSync } from "node:fs"
import { resolvePath } from "./shared.mjs"

const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" }
const MAX_IMAGE_BYTES = 15_000_000 // 15MB raw ≈ 20MB base64

export const readImageTool = {
  name: "read_image",
  readonly: true,
  multimodal: true, // returns JSON { text, images } — agent loop converts to multimodal user message
  description:
    "Read an image file and return it as base64 data visible to the model. " +
    "Use this to view screenshots, UI mockups, diagrams, or any visual content. " +
    "The model only sees images through this tool — it cannot 'see' files directly. " +
    "Supports png, jpg, gif, webp, bmp, svg. " +
    "Note: only works with models that support vision input (Kimi K3, Qwen3.7, MiniMax M3).\n" +
    "Parameters:\n" +
    "- path (required): Image file path",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Image file path (relative to cwd or absolute)" },
    },
    required: ["path"],
  },
  /** Returns JSON string: { text, images: [{ type: "image_url", image_url: { url: "data:..." } }] } */
  async execute({ path }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    const ext = abs.slice(abs.lastIndexOf(".") + 1).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (!mime) throw new Error(`Unsupported image format: .${ext}. Supported: ${Object.keys(IMAGE_MIME).join(", ")}`)

    const imgStat = statSync(abs)
    if (imgStat.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large: ${Math.round(imgStat.size / 1_000_000)}MB (max 15MB)`)
    }

    const buf = readFileSync(abs)
    const b64 = buf.toString("base64")
    const bytes = buf.length

    return JSON.stringify({
      text: `[read_image: ${path} (${mime}, ${bytes} bytes)]`,
      images: [{ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }],
    })
  },
}
