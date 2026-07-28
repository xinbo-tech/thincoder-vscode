/**
 * generate-title.mjs — LLM-generated session titles
 * Extracted from extension.mjs ChatPanel._generateTitle()
 */

import { providerNames, getKey, buildProvider } from "./presets.mjs"

/** Generate a title for the current session using the first user message */
export async function generateTitle(loadIndex, saveIndex, loadMessages, pushSessions, activeIx) {
  const ix = loadIndex()
  const entry = ix.sessions[activeIx]
  if (!entry || entry.title) return
  const msgs = loadMessages(activeIx)
  const firstUser = msgs.find((m) => m.type === "user")
  if (!firstUser || firstUser.content.length < 10) return

  let provName
  for (const n of providerNames()) { if (await getKey(n)) { provName = n; break } }
  if (!provName) return
  const prov = await buildProvider(provName)
  if (!prov) return

  try {
    const body = JSON.stringify({
      model: prov.model,
      messages: [
        { role: "system", content: "Generate a concise title (max 40 chars, no quotes) for this conversation. Reply ONLY with the title." },
        { role: "user", content: firstUser.content.slice(0, 200) },
      ],
      max_tokens: 30, stream: false,
    })
    const chatPath = prov.chatPath ?? "/chat/completions"
    const res = await fetch(`${prov.baseURL.replace(/\/+$/, "")}${chatPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${prov.apiKey}` },
      body,
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return
    const data = await res.json()
    const title = data.choices?.[0]?.message?.content?.trim().slice(0, 40)
    if (title) {
      entry.title = title
      saveIndex(ix)
      pushSessions()
    }
  } catch { /* best-effort */ }
}
