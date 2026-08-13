/**
 * question.mjs — User interaction tool: question
 */

import * as vscode from "vscode"

export const questionTool = {
  name: "question",
  readonly: true,
  description:
    "Ask the user a question and wait for their response.\n" +
    "Parameters:\n" +
    "- question (required): The question to ask\n" +
    "- options: Array of single-choice options (optional)",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "Question to ask" },
      options: { type: "array", items: { type: "string" }, description: "Single-choice options" },
    },
    required: ["question"],
  },
  async execute({ question, options }, ctx) {
    // Panel-inline interaction (preferred): the question renders INSIDE the chat
    // panel via callbacks.onQuestion (same queue pattern as permissionRequest).
    // VS Code's native QuickPick / InputBox pops up at the TOP of the editor
    // window — users miss it and an accidental click dismisses it as "cancelled".
    if (ctx?.callbacks?.onQuestion) {
      const answer = await ctx.callbacks.onQuestion(question, options?.length ? options : null)
      return answer ?? "(user cancelled)"
    }
    // Fallback (no panel callback — e.g. subagent runs): native VS Code UI.
    let answer
    if (options?.length) {
      // Use createQuickPick for proper title support
      const picker = vscode.window.createQuickPick()
      picker.title = question
      picker.items = options.map((o) => ({ label: o }))
      picker.placeholder = question
      answer = await new Promise((resolve) => {
        picker.onDidAccept(() => {
          const sel = picker.selectedItems[0]
          resolve(sel?.label || null)
          picker.hide()
        })
        picker.onDidHide(() => resolve(null))
        picker.show()
      })
    } else {
      answer = await vscode.window.showInputBox({ prompt: question })
    }
    return answer ?? "(user cancelled)"
  },
}
