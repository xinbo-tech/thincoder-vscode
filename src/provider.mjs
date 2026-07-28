/**
 * provider.mjs — LLM provider with rate-limit retry + backoff
 * OpenAI-compatible, fetch + SSE streaming. Zero dependencies.
 */

import { specForModel } from "./specs.mjs"

const FETCH_TIMEOUT_MS = 120000
const MAX_RETRIES = 3
const RETRY_BACKOFF_MS = [1000, 4000, 12000]
const RATE_LIMIT_BACKOFF_MS = 15000

/**
 * Send a streaming chat completion request with automatic retry on 429/5xx.
 */
export async function chat(provider, { messages, tools, onToken, signal }) {
  const spec = specForModel(provider.model)
  const body = {
    model: provider.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (provider.maxTokens) body.max_tokens = provider.maxTokens
  // Temperature: clamp to model's tempRange, only send if explicitly set
  if (provider.temperature != null) {
    let t = provider.temperature
    if (spec.tempRange) {
      t = Math.min(spec.tempRange[1], Math.max(spec.tempRange[0], t))
      t = Math.round(t * 100) / 100
    }
    body.temperature = t
  }
  // Thinking / reasoning — send whichever the provider config specifies
  if (provider.thinking) body.thinking = provider.thinking
  if (provider.reasoningEffort) {
    if (spec.reasoningEffortEnum && !spec.reasoningEffortEnum.includes(provider.reasoningEffort)) {
      throw new Error(
        `reasoning_effort "${provider.reasoningEffort}" not supported by model "${provider.model}"; ` +
        `valid values: ${spec.reasoningEffortEnum.join(", ")}`
      )
    }
    body.reasoning_effort = provider.reasoningEffort
  }
  if (tools?.length) body.tools = tools

  const url = `${provider.baseURL.replace(/\/+$/, "")}${provider.chatPath ?? "/chat/completions"}`

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const onAbort = () => controller.abort()
    signal?.addEventListener("abort", onAbort)

    let res
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (e) {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
      if (e.name === "AbortError") throw e
      // Network error — retry
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS[attempt] || 4000)
        continue
      }
      throw new Error(`Network error after ${MAX_RETRIES + 1} attempts: ${e.message}`)
    }

    clearTimeout(timeout)
    signal?.removeEventListener("abort", onAbort)

    // Rate limited — retry with backoff
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After")
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : RATE_LIMIT_BACKOFF_MS
      if (attempt < MAX_RETRIES) {
        await sleep(waitMs)
        continue
      }
      throw new Error(`Rate limited after ${MAX_RETRIES + 1} attempts`)
    }

    // Server error — retry
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(RETRY_BACKOFF_MS[attempt] || 4000)
      continue
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`LLM API error ${res.status}: ${text.slice(0, 500)}`)
    }

    const result = await readSSE(res.body, { onToken })
    return result
  }

  throw new Error("Max retries exceeded")
}

/**
 * Read SSE (Server-Sent Events) stream and accumulate.
 */
async function readSSE(body, { onToken }) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let content = ""
  const toolCalls = []
  let finishReason = null
  const usage = {}

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() || ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith("data:")) continue
      const data = trimmed.slice(5).trim()
      if (data === "[DONE]") continue

      try {
        const json = JSON.parse(data)
        for (const choice of json.choices || []) {
          const delta = choice.delta || {}
          if (delta.content) {
            content += delta.content
            onToken?.(delta.content)
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              while (toolCalls.length <= idx) {
                toolCalls.push({ id: "", type: "function", function: { name: "", arguments: "" } })
              }
              if (tc.id) toolCalls[idx].id = tc.id
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason
        }
        if (json.usage) {
          usage.prompt_tokens = json.usage.prompt_tokens
          usage.completion_tokens = json.usage.completion_tokens
          usage.total_tokens = json.usage.total_tokens
        }
      } catch {
        // skip malformed SSE lines
      }
    }
  }

  return {
    content,
    toolCalls: toolCalls.filter((tc) => tc.function.name),
    finishReason,
    usage,
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Fetch available model IDs from the provider's /models endpoint.
 * Returns empty array on failure (non-blocking — the preset default model is always available).
 */
export async function listModels(provider) {
  try {
    const url = `${provider.baseURL.replace(/\/+$/, "")}/models`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.data ?? []).map((m) => m.id).filter(Boolean).sort()
  } catch {
    return []
  }
}
