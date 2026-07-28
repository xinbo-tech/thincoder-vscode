/**
 * file.mjs — File manipulation tools: read, write, edit
 */

import { readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { resolvePath } from "./shared.mjs"

export const readTool = {
  name: "read",
  readonly: true,
  description:
    "Read a text file. Returns numbered lines. Use offset/limit to page large files.\n" +
    "Parameters:\n" +
    "- path (required): File path, relative to workspace or absolute\n" +
    "- offset: 1-based line number to start reading from\n" +
    "- limit: Max lines to return (default 2000)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      offset: { type: "number", description: "1-based line number to start from" },
      limit: { type: "number", description: "Max lines to return" },
    },
    required: ["path"],
  },
  async execute({ path, offset, limit }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    let text = await readFile(abs, "utf8")
    const lines = text.split("\n")
    const start = Math.max(0, (offset || 1) - 1)
    const end = limit ? start + limit : lines.length
    const chunk = lines.slice(start, end)
    return chunk.map((l, i) => `${String(start + i + 1).padStart(6, " ")}\t${l}`).join("\n")
  },
}

export const writeTool = {
  name: "write",
  description:
    "Write content to a file. Creates parent directories; overwrites existing file.\n" +
    "Parameters:\n" +
    "- path (required): File path, relative to workspace or absolute\n" +
    "- content (required): Full content to write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "Full content to write" },
    },
    required: ["path", "content"],
  },
  async execute({ path, content }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, "utf8")
    return `Wrote ${content.length} chars to ${path}`
  },
}

export const editTool = {
  name: "edit",
  description:
    "Edit a file by exact string replacement. old_string must match exactly once unless replace_all is set.\n" +
    "Parameters:\n" +
    "- path (required): File path\n" +
    "- old_string (required): Exact text to find and replace\n" +
    "- new_string (required): Replacement text\n" +
    "- replace_all: Replace all occurrences instead of just one (default false)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute({ path, old_string, new_string, replace_all }, ctx) {
    const abs = resolvePath(path, ctx.cwd)
    const text = await readFile(abs, "utf8")
    const count = text.split(old_string).length - 1
    if (count === 0) return `Error: old_string not found in ${path}`
    if (!replace_all && count > 1) {
      return `Error: old_string matches ${count} times in ${path} — set replace_all=true or add more context to make it unique`
    }
    const result = replace_all ? text.replaceAll(old_string, new_string) : text.replace(old_string, new_string)
    await writeFile(abs, result, "utf8")
    return `Replaced ${replace_all ? count : 1} occurrence(s) in ${path}`
  },
}
