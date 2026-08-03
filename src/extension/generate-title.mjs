/**
 * generate-title.mjs — LLM-generated session titles
 * Called from ChatPanel._generateTitle() with (userContent, providerName, modelName).
 */
import { getKey, buildProvider } from "./presets.mjs"

/** Generate a session title from the first user message using an LLM. Returns title string or null. */
export async function generateTitle(userContent, providerName, _modelName) {
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
    const title = await requestTitle(prov, userText.slice(0, 200))
    return title?.trim().slice(0, 40) || null
  } catch {
    return null
  }
}

/** Non-streaming title request, routed by provider.format (same transport split as provider.mjs). */
async function requestTitle(prov, text) {
  const system = "Generate a concise title (max 40 chars, no quotes) for this conversation. Reply ONLY with the title."
  const headers = { "Content-Type": "application/json" }
  if (prov.format === "anthropic") headers["x-api-key"] = prov.apiKey
  else headers.Authorization = `Bearer ${prov.apiKey}`
  if (prov.format === "anthropic") headers["anthropic-version"] = "2023-06-01"

  let url, body, extract
  if (prov.format === "anthropic") {
    url = `${prov.baseURL}/messages`
    body = JSON.stringify({
      model: prov.model,
      system,
      messages: [{ role: "user", content: text }],
      max_tokens: 30, stream: false,
    })
    extract = (data) => data.content?.map((b) => b.text || "").join("")
  } else if (prov.format === "google") {
    url = `${prov.baseURL}/models/${encodeURIComponent(prov.model)}:generateContent?key=${encodeURIComponent(prov.apiKey)}`
    body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { maxOutputTokens: 30 },
    })
    extract = (data) => data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("")
  } else {
    const chatPath = prov.chatPath ?? "/chat/completions"
    url = `${prov.baseURL.replace(/\/+$/, "")}${chatPath}`
    body = JSON.stringify({
      model: prov.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      max_tokens: 30, stream: false,
    })
    extract = (data) => data.choices?.[0]?.message?.content
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) return null
  const data = await res.json()
  return extract(data) || null
}
