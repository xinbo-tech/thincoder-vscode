/**
 * i18n-dom.js — apply locale strings to static HTML elements after the i18n
 * message arrives.
 */
import { t } from "./i18n.js"

/** Apply locale strings to static HTML elements after i18n message arrives */
export function applyI18nToDOM() {
  // session bar
  const title = document.getElementById("session-title")
  if (title && title.textContent === "Session 1") title.textContent = t("session.title") + " 1"
  const newBtn = document.getElementById("new-session-btn")
  if (newBtn) newBtn.title = t("session.new")

  // input
  const input = document.getElementById("input")
  if (input) input.placeholder = t("input.placeholder")

  // toolbar buttons
  const sendBtn = document.getElementById("send-btn")
  if (sendBtn) sendBtn.title = t("toolbar.send")
  const abortBtn = document.getElementById("abort-btn")
  if (abortBtn) abortBtn.title = t("toolbar.stop")
  const attachBtn = document.getElementById("attach-btn")
  if (attachBtn) { attachBtn.title = t("toolbar.attach"); attachBtn.textContent = t("toolbar.attachShort") }
  const modelBtn = document.getElementById("model-btn")
  if (modelBtn) modelBtn.title = t("toolbar.model")
  const reasoningBtn = document.getElementById("reasoning-btn")
  if (reasoningBtn) reasoningBtn.title = t("toolbar.reasoning")
  const autoBtn = document.getElementById("auto-btn")
  if (autoBtn) autoBtn.title = t("toolbar.autoApprove")
  if (document.getElementById("advisor-btn")) document.getElementById("advisor-btn").title = t("toolbar.advisor")
  if (document.getElementById("eng-btn")) document.getElementById("eng-btn").title = t("toolbar.engineering")
  const settingsBtn = document.getElementById("settings-btn")
  if (settingsBtn) settingsBtn.title = t("toolbar.settings")

  // settings panel
  const settingsTitle = document.querySelector("#settings-panel h3")
  if (settingsTitle) settingsTitle.textContent = t("settings.title")

  // welcome page
  const welcome = document.querySelector(".welcome h2")
  if (welcome) welcome.textContent = t("welcome.heading")
}
