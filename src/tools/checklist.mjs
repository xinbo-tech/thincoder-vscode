/**
 * checklist.mjs — persistent task checklist (.thincoder/checklist.md)
 * Ported from CLI thincoder/src/tools/checklist.mjs (DESC file-read replaced with inline description).
 * Manages a tree-structured checklist; done items auto-archive to checklist-done.md.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

const CHECKLIST = "checklist.md"
const DONE = "checklist-done.md"

function checklistPath(cwd) { return join(cwd, ".thincoder", CHECKLIST) }
function donePath(cwd) { return join(cwd, ".thincoder", DONE) }

/**
 * Parse checklist file into tree-structured items.
 * Indentation (2 spaces per level) determines parent-child relationships.
 * Each item: { id, index, depth, status, text, children[] }
 */
function parse(filePath) {
  if (!existsSync(filePath)) return []
  const lines = readFileSync(filePath, "utf-8").split("\n")
  const items = []
  let flatIdx = 0
  const stack = [{ children: items, depth: -1 }]

  for (const line of lines) {
    const m = line.match(/^(\s*)- \[(.)\] (.+)$/)
    if (!m) continue
    flatIdx++
    const depth = Math.floor(m[1].length / 2)
    const raw = m[2]
    const status = raw === "x" ? "done" : raw === "~" ? "in_progress" : "pending"
    const text = m[3].trim()
    const idMatch = text.match(/^(T[\d.]+):\s*/)
    const id = idMatch ? idMatch[1] : null
    const bareText = idMatch ? text.slice(idMatch[0].length) : text
    const node = { id, index: flatIdx, depth, status, text: bareText, children: [] }

    while (stack.length > 1 && stack.at(-1).depth >= depth) stack.pop()
    const parent = stack.at(-1)
    parent.children.push(node)
    if (!node.id) {
      const siblingCount = parent.children.length
      if (parent.id) {
        node.id = `${parent.id}.${siblingCount}`
      } else {
        let rootIdx = 0
        for (const c of items) {
          if (c.id?.match(/^T\d+$/)) rootIdx = Math.max(rootIdx, parseInt(c.id.slice(1)))
        }
        node.id = `T${rootIdx + 1}`
      }
    }
    stack.push({ children: node.children, depth, id: node.id })
  }
  return items
}

function write(filePath, items, _depth = 0) {
  if (_depth === 0) mkdirSync(dirname(filePath), { recursive: true })
  const lines = []
  const indent = "  ".repeat(_depth)
  for (const item of items) {
    const mark = item.status === "done" ? "x" : item.status === "in_progress" ? "~" : " "
    const label = item.id ? `${item.id}: ${item.text}` : item.text
    lines.push(`${indent}- [${mark}] ${label}`)
    if (item.children?.length) {
      lines.push(...write(filePath, item.children, _depth + 1).split("\n").filter(Boolean))
    }
  }
  if (_depth === 0) {
    writeFileSync(filePath, lines.join("\n") + "\n")
    return ""
  }
  return lines.join("\n")
}

function findById(items, id) {
  for (const item of items) {
    if (item.id === id) return { parent: items, item, idx: items.indexOf(item) }
    if (item.children?.length) {
      const found = findById(item.children, id)
      if (found) return found
    }
  }
  return null
}

function flatten(items, out = []) {
  for (const item of items) {
    out.push(item)
    if (item.children?.length) flatten(item.children, out)
  }
  return out
}

/** Parse pending items only (for context injection) */
export function pendingItems(cwd) {
  const flat = flatten(parse(checklistPath(cwd)))
  return flat.filter((i) => i.status !== "done")
}

export const checklistTool = {
  name: "checklist",
  description:
    "Manage the persistent task checklist in .thincoder/checklist.md. " +
    "Items support tree hierarchy via indentation (2 spaces per level) and auto-assigned IDs (T1, T1.1). " +
    "Completed items are auto-archived to .thincoder/checklist-done.md.\n" +
    "Parameters:\n" +
    "- action (required): 'add' | 'mark' | 'list'\n" +
    "- item: item text (required for add)\n" +
    "- index: 1-based item index (required for mark)\n" +
    "- status: 'pending' | 'in_progress' | 'done' (required for mark)\n" +
    "- parent: parent task ID for tree-structured tasks (e.g. 'T1')",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "mark", "list"], description: "add a new item / mark item status / list all items" },
      item: { type: "string", description: "Item text (required for add)" },
      index: { type: "number", description: "1-based item index (required for mark)" },
      status: { type: "string", enum: ["pending", "in_progress", "done"], description: "New status (required for mark)" },
      parent: { type: "string", description: "Parent task ID for tree-structured tasks (e.g. 'T1')" },
    },
    required: ["action"],
  },
  readonly: false,
  execute(args, ctx) {
    switch (args.action) {
      case "add": {
        if (!args.item || typeof args.item !== "string") return "Error: 'item' is required for add"
        const items = parse(checklistPath(ctx.cwd))
        let target = items
        let parentId = null
        if (args.parent) {
          const found = findById(items, args.parent)
          if (!found) return `Error: parent '${args.parent}' not found. Use 'list' to see all task IDs.`
          target = found.item.children
          parentId = found.item.id
        }
        let id
        if (parentId) {
          id = `${parentId}.${target.length + 1}`
        } else {
          let maxIdx = 0
          for (const c of items) {
            const m = c.id?.match(/^T(\d+)$/)
            if (m) maxIdx = Math.max(maxIdx, parseInt(m[1]))
          }
          id = `T${maxIdx + 1}`
        }
        const node = { id, index: 0, depth: parentId ? 1 : 0, status: "pending", text: args.item, children: [] }
        target.push(node)
        write(checklistPath(ctx.cwd), items)
        return `Added: [ ] ${id}: ${args.item}${parentId ? ` (under ${parentId})` : ""}`
      }
      case "mark": {
        if (args.index == null) return "Error: 'index' is required for mark"
        const status = args.status
        if (!status || !["pending", "in_progress", "done"].includes(status)) return "Error: 'status' is required (pending|in_progress|done)"
        const cp = checklistPath(ctx.cwd)
        const items = parse(cp)
        const flat = flatten(items)
        if (args.index < 1 || args.index > flat.length) return `Error: index ${args.index} out of range (1-${flat.length})`
        const item = flat[args.index - 1]
        const old = item.status
        if (old === status) return `Already ${status}: ${item.text}`
        item.status = status
        if (status === "done") {
          const dp = donePath(ctx.cwd)
          const doneItems = parse(dp)
          doneItems.push({ id: item.id, index: 0, depth: 0, status: "done", text: item.text, children: [] })
          write(dp, doneItems)
          const found = findById(items, item.id)
          if (found) found.parent.splice(found.idx, 1)
        }
        write(cp, items)
        return `Marked #${args.index} ${old} → ${status}: ${item.id}: ${item.text}`
      }
      case "list": {
        const items = parse(checklistPath(ctx.cwd))
        if (items.length === 0) return "(checklist is empty)"
        const marks = { pending: " ", in_progress: "~", done: "x" }
        const lines = []
        function render(nodes, depth) {
          const indent = "  ".repeat(depth)
          for (const n of nodes) {
            const idTag = n.id ? `${n.id}: ` : ""
            lines.push(`${indent}- [${marks[n.status]}] ${idTag}${n.text}`)
            if (n.children?.length) render(n.children, depth + 1)
          }
        }
        render(items, 0)
        return lines.join("\n")
      }
      default:
        return `Error: unknown action '${args.action}'`
    }
  },
}
