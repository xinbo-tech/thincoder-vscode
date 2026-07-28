/**
 * transports/google.mjs — Google Gemini API transport
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent
 * Docs: https://ai.google.dev/gemini-api/docs
 */

/** Convert OpenAI-format tools to Gemini format */
export function normalizeTools(tools) {
  if (!tools?.length) return null
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      parameters: t.function.parameters || { type: "object", properties: {} },
    })),
  }]
}

/**
 * Convert OpenAI-format messages to Gemini contents array.
 * Gemini uses: [{ role: "user"|"model", parts: [{ text: "..." }] }]
 * system messages go into systemInstruction.
 */
function convertMessages(messages) {
  const contents = []
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user"
    if (role === "system") continue // handled separately

    const parts = []
    if (typeof m.content === "string") {
      parts.push({ text: m.content })
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text") parts.push({ text: part.text })
        else if (part.type === "image_url") {
          // Convert to Gemini inline_data format
          const url = part.image_url?.url || ""
          const mimeMatch = url.match(/^data:([^;]+);base64,(.+)$/)
          if (mimeMatch) {
            parts.push({ inlineData: { mimeType: mimeMatch[1], data: mimeMatch[2] } })
          }
        }
      }
    }

    // Gemini doesn't allow consecutive same-role messages; merge if needed
    const last = contents[contents.length - 1]
    if (last?.role === role) {
      last.parts.push(...parts)
    } else {
      contents.push({ role, parts })
    }
  }
  return contents
}

/** Build the HTTP request for Gemini API */
export function buildRequest(provider, messages, tools) {
  const systemMessages = messages.filter((m) => m.role === "system")
  const contents = convertMessages(messages)

  const body = {
    contents,
    generationConfig: {
      ...(provider.temperature != null ? { temperature: provider.temperature } : {}),
      ...(provider.maxTokens ? { maxOutputTokens: provider.maxTokens } : {}),
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  }
  if (systemMessages.length > 0) {
    body.systemInstruction = {
      parts: [{ text: systemMessages.map((m) => m.content).join("\n\n") }],
    }
  }
  if (tools?.length) body.tools = tools

  // Gemini uses API key as query parameter, not header
  const url = `${provider.baseURL}/models/${provider.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(provider.apiKey)}`

  return {
    url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

/**
 * Parse Gemini SSE stream.
 * Gemini SSE format: data: {...}\n\n (each line is a complete JSON object)
 * Response shape: { candidates: [{ content: { parts: [{ text }] }, finishReason }], usageMetadata }
 */
export async function parseStream(response, { onToken, onReasoning }) {
  const result = { content: "", reasoning: "", toolCalls: [], usage: null, finishReason: null }
  const decoder = new TextDecoder()
  let buffer = ""

  const processData = (data) => {
    let json
    try { json = JSON.parse(data) } catch { return }
    if (!json) return

    // Usage
    if (json.usageMetadata) {
      result.usage = {
        prompt_tokens: json.usageMetadata.promptTokenCount || 0,
        completion_tokens: json.usageMetadata.candidatesTokenCount || 0,
        total_tokens: (json.usageMetadata.totalTokenCount) || 0,
      }
    }

    const candidate = json.candidates?.[0]
    if (!candidate) return

    if (candidate.finishReason && candidate.finishReason !== "STOP") {
      result.finishReason = candidate.finishReason
    }

    const parts = candidate.content?.parts || []
    for (const part of parts) {
      if (part.text) {
        result.content += part.text
        onToken?.(part.text)
      } else if (part.thought === true) {
        // Thinking/reasoning — Gemini signals thought via boolean flag on text
        if (part.text) {
          result.reasoning += part.text
          onReasoning?.(part.text)
        }
      } else if (part.functionCall) {
        // Gemini returns function calls as discrete objects, not deltas
        const existing = result.toolCalls.find((tc) => tc.name === part.functionCall.name)
        if (!existing) {
          result.toolCalls.push({
            id: part.functionCall.name + "_" + result.toolCalls.length,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          })
        }
      }
    }

    if (candidate.finishReason === "STOP" || candidate.finishReason === "MAX_TOKENS") {
      // On final event with stop reason
      if (!result.finishReason) result.finishReason = candidate.finishReason === "MAX_TOKENS" ? "length" : "stop"
    }
  }

  if (!response.body) throw new Error("No stream response body")
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop()

    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (!data || data === "[DONE]") continue
      processData(data)
    }
  }
  buffer += decoder.decode()
  for (const line of buffer.split("\n")) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") continue
    processData(data)
  }

  return result
}
