/**
 * transports/openai.mjs — OpenAI-compatible API transport
 * Used by: DeepSeek, Kimi, GLM, Qwen, MiniMax, OpenAI, custom providers
 */

import { specForModel } from "../../specs.mjs"

/** Convert our tool schemas to OpenAI format */
export function normalizeTools(tools) {
  return tools
}

/** Build the HTTP request */
export function buildRequest(provider, messages, tools) {
  const spec = specForModel(provider.model)
  const body = {
    model: provider.model,
    messages,
    stream: true,
    ...(spec.noUsageStream ? {} : { stream_options: { include_usage: true } }),
  }
  if (provider.maxTokens) body.max_tokens = provider.maxTokens
  if (provider.temperature != null) {
    let t = provider.temperature
    if (spec.tempRange) {
      t = Math.min(spec.tempRange[1], Math.max(spec.tempRange[0], t))
      t = Math.round(t * 100) / 100
    }
    body.temperature = t
  }
  if (provider.thinking) body.thinking = provider.thinking
  if (provider.reasoningEffort) body.reasoning_effort = provider.reasoningEffort
  if (tools?.length) body.tools = tools
  if (provider.responseFormat) body.response_format = provider.responseFormat

  return {
    url: `${provider.baseURL}${provider.chatPath ?? "/chat/completions"}`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  }
}

/**
 * Parse OpenAI SSE stream. Returns { content, reasoning, toolCalls, usage, finishReason }.
 * Reads the full response body; calls onToken/onReasoning callbacks per chunk.
 * `signal` (CLI parity, sse.mjs): every chunk checks aborted; additionally the
 * read loop races an abort promise so a Stop interrupts even a SILENT stream
 * (server accepted, no data — the for-await would otherwise hang).
 */
export async function parseStream(response, { onToken, onReasoning, signal }) {
  const result = { content: "", reasoning: "", toolCalls: [], usage: null, finishReason: null }
  const decoder = new TextDecoder()
  let buffer = ""
  let hasChoices = false

  const abortError = () => {
    const e = new DOMException("The operation was aborted", "AbortError")
    e.reason = signal?.reason
    return e
  }

  const processLines = (lines) => {
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (!data || data === "[DONE]") continue

      let json
      try { json = JSON.parse(data) } catch { continue }

      if (json.usage) result.usage = json.usage
      const choice = json.choices?.[0]
      if (!choice) continue
      hasChoices = true
      if (choice.finish_reason) result.finishReason = choice.finish_reason

      const delta = choice.delta ?? {}
      if (delta.reasoning_content) {
        result.reasoning += delta.reasoning_content
        onReasoning?.(delta.reasoning_content)
      }
      if (delta.content) {
        result.content += delta.content
        onToken?.(delta.content)
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = (result.toolCalls[tc.index] ??= { id: "", name: "", arguments: "" })
        if (tc.id) slot.id = tc.id
        if (tc.function?.name && !slot.name) slot.name = tc.function.name
        if (tc.function?.arguments) slot.arguments += tc.function.arguments
      }
    }
  }

  if (!response.body) throw new Error("No stream response body")

  const readLoop = async () => {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw abortError()
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop()
      processLines(lines)
    }
  }

  if (signal) {
    const abortPromise = new Promise((_, reject) => {
      const onAbort = () => reject(abortError())
      signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([readLoop(), abortPromise])
    } finally {
      // Abort won the race — release the hanging stream; normal completion is a no-op.
      try { await response.body.cancel() } catch { /* */ }
    }
  } else {
    await readLoop()
  }

  buffer += decoder.decode()
  processLines(buffer.split("\n"))

  if (!hasChoices) {
    const contentType = response.headers.get("content-type") || ""
    let errorMsg = ""
    try {
      const raw = buffer.trim() || ""
      if (raw) {
        const parsed = JSON.parse(raw)
        errorMsg = parsed?.error?.message
          || parsed?.base_resp?.status_msg
          || parsed?.detail
          || parsed?.message
          || parsed?.msg
          || (typeof parsed.error === "string" ? parsed.error : "")
      }
    } catch {}
    if (!errorMsg && !contentType.includes("event-stream")) {
      errorMsg = `Response is not SSE (Content-Type: ${contentType || "unknown"})`
    }
    if (errorMsg) throw new Error(`API error: ${errorMsg}`)
  }

  return result
}
