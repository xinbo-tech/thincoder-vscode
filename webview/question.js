/**
 * question.js — inline question prompt (question tool) rendered INSIDE the chat
 * panel — not VS Code's native popup at the window top. Options → button list;
 * free text → input + submit. Cancel always available (answer null = cancelled).
 */
import { vscode } from "./state.js"
import { t } from "./i18n.js"
import { escHtml } from "./ui.js"

export function showQuestion(ctx, question, options) {
  const el = document.createElement("div")
  el.className = "question-card"
  el.setAttribute("role", "alert")
  el.setAttribute("aria-label", t("question.label"))

  const textEl = document.createElement("div")
  textEl.className = "question-text"
  textEl.innerHTML = `<span class="question-mark">${escHtml(t("question.mark"))}</span> ${escHtml(question)}`
  el.appendChild(textEl)

  const actions = document.createElement("div")
  actions.className = "question-actions"
  el.appendChild(actions)

  const answer = (value) => {
    el.remove()
    vscode.postMessage({ type: "questionResponse", answer: value ?? null })
    ctx.inputEl.focus()
  }

  // Free-text channel — ALWAYS present (options or not). Users must be able to
  // supplement or correct the AI's preset choices with their own answer.
  const addFreeInput = (placeholder) => {
    const input = document.createElement("input")
    input.className = "question-input"
    input.type = "text"
    input.placeholder = placeholder
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) answer(input.value.trim())
    })
    actions.appendChild(input)
    const submit = document.createElement("button")
    submit.className = "perm-btn approve"
    submit.textContent = t("question.submit")
    submit.addEventListener("click", () => { if (input.value.trim()) answer(input.value.trim()) })
    actions.appendChild(submit)
  }

  if (Array.isArray(options) && options.length > 0) {
    for (const opt of options) {
      const b = document.createElement("button")
      b.className = "perm-btn approve question-option"
      // 防御：schema 声明 options 是 string[]，但 LLM 可能误传 {label,description} 对象。
      // 取 label/text/title 字段兜底，绝不显示 "[object Object]"。
      const label = typeof opt === "string" ? opt : (opt?.label ?? opt?.text ?? opt?.title ?? String(opt))
      b.textContent = label
      b.addEventListener("click", () => answer(label))
      actions.appendChild(b)
    }
    // Preset options PLUS a free-text input — the user can pick a preset or
    // type their own answer (the AI's options are never assumed exhaustive).
    addFreeInput(t("question.customPlaceholder"))
  } else {
    addFreeInput(t("question.placeholder"))
  }

  const cancel = document.createElement("button")
  cancel.className = "perm-btn deny"
  cancel.textContent = t("question.cancel")
  cancel.addEventListener("click", () => answer(null))
  actions.appendChild(cancel)

  ctx.messagesEl.appendChild(el)
  el.scrollIntoView({ behavior: "smooth", block: "nearest" })
  const input = el.querySelector(".question-input")
  if (input) setTimeout(() => input.focus(), 50)
}
