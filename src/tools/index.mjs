/**
 * index.mjs — Tools module index: imports, re-exports, and tool registry
 */

import { readTool, writeTool, editTool } from "./file.mjs"
import { globTool, grepTool } from "./search.mjs"
import { bashTool } from "./shell.mjs"
import { gitDiffTool, gitStatusTool, gitLogTool, checkpointTool } from "./git.mjs"
import { websearchTool, fetchTool } from "./web.mjs"
import { insertAfterTool, applyPatchTool, lsTool, deleteTool } from "./more-file.mjs"
import { lintTool } from "./linter.mjs"
import { checklistTool } from "./checklist.mjs"
import { questionTool } from "./question.mjs"
import { readImageTool } from "./read_image.mjs"
import { codeSearchTool, docSearchTool } from "./code.mjs"
import { repoOutlineTool } from "../repomap.mjs"
import { memoryPutTool, memorySearchTool } from "../memory.mjs"
import { mcpTool } from "../mcp.mjs"

export { readTool, writeTool, editTool }
export { globTool, grepTool }
export { bashTool }
export { gitDiffTool, gitStatusTool, gitLogTool, checkpointTool }
export { websearchTool, fetchTool }
export { insertAfterTool, applyPatchTool, lsTool, deleteTool }
export { lintTool } from "./linter.mjs"
export { checklistTool } from "./checklist.mjs"
export { questionTool }
export { readImageTool }
export { codeSearchTool, docSearchTool }

export { BASH_TIMEOUT_MS, resolvePath, formatSize } from "./shared.mjs"

/** All built-in tools */
export const builtinTools = [
  readTool, writeTool, editTool, insertAfterTool, applyPatchTool,
  lintTool, checklistTool, lsTool, deleteTool,
  globTool, grepTool, bashTool,
  gitDiffTool, gitStatusTool, gitLogTool, checkpointTool,
  websearchTool, fetchTool, questionTool,
  repoOutlineTool, codeSearchTool, docSearchTool,
  memoryPutTool, memorySearchTool, mcpTool,
]

/** Convert a tool definition to OpenAI function schema */
export function toOpenAISchema(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}
