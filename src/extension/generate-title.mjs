/**
 * generate-title.mjs — LLM-generated session titles
 * Called from ChatPanel._generateTitle() with (userContent, providerName, modelName).
 */
import { getKey, buildProvider } from "./presets.mjs"

/** Generate a session title from the first user message using an LLM. Returns title string or null. */
export async function generateTitle(userContent, providerName, modelName) {
  // Extract text even from multimodal content (array of parts)
  const userText = Array.isArray(userContent)
    ? userContent.find(p => p.type === "text")?.text || ""
    : userContent
  if (typeof userText !== "string" || userText.length < 10) return null

  const key = await getKey(providerName)
  if (!key) return null
  const prov = await buildProvider(providerName)
  if (!prov) return null

  try {
    const body = JSON.stringify({
      model: prov.model,
      messages: [
        { role: "system", content: "Generate a concise title (max 40 chars, no quotes) for this conversation. Reply ONLY with the title." },
        { role: "user", content: userText.slice(0, 200) },
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
    if (!res.ok) return null
    const data = await res.json()
    const title = data.choices?.[0]?.message?.content?.trim().slice(0, 40)
    return title || null
  } catch {
    return null
  }
}
