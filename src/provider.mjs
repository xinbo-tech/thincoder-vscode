/**
 * provider.mjs — LLM provider with TPM gate, partial/prefix continuation, retry+backoff
 * OpenAI-compatible, fetch + SSE streaming. Zero dependencies.
 */

import { specForModel } from "./specs.mjs"

// ── Constants ──────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 120000
const MAX_RETRIES = 3
const MAX_CONTINUATIONS = 3
const RATE_LIMIT_BACKOFF_MS = [15_000, 30_000, 60_000]
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

// ── Rate-limiting infrastructure ──────────────────────────

/**
 * Test hooks: sleep/clock/window length are replaceable.
 * Production code should never call setTimeout/sleep directly — always go through these.
 */
export const _rateHooks = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  windowMs: 60_000,
}

const rateWindows = new Map() // key → { tokens: [{ts, n}], requests: [ts] }

function rateKey(provider) {
  // Normalize: /beta and /v1 share the same account's rate-limit window
  const base = provider.baseURL.replace(/\/beta$/, "/v1")
  return `${base}|${provider.apiKey ?? ""}`
}

/**
 * Rough estimate of text token count.
 * ASCII ~4 chars/token; non-ASCII (CJK/emoji) ~1 char/token.
 */
export function estimateText(s) {
  let nonAscii = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) nonAscii++
  return Math.ceil((s.length - nonAscii) / 4) + nonAscii
}

/** Estimated prompt tokens for this request */
export function estimateRequestTokens(body) {
  let tokens = 0
  for (const m of body.messages ?? []) {
    if (typeof m.content === "string") tokens += estimateText(m.content)
    if (typeof m.reasoning_content === "string") tokens += estimateText(m.reasoning_content)
    for (const tc of m.tool_calls ?? []) {
      tokens += estimateText(tc.function?.name ?? "") + estimateText(tc.function?.arguments ?? "")
    }
  }
  if (body.tools) tokens += estimateText(JSON.stringify(body.tools))
  return tokens
}

/** Gate: sleep until window frees space when over budget */
export async function rateGate(provider, estimated, onWait, signal) {
  const tpm = provider.tpm != null && estimated <= provider.tpm ? provider.tpm : null
  const rpm = provider.rpm ?? null
  if (tpm == null && rpm == null) return
  const w = rateWindows.get(rateKey(provider)) ?? { tokens: [], requests: [] }
  rateWindows.set(rateKey(provider), w)
  for (;;) {
    const now = _rateHooks.now()
    const cutoff = now - _rateHooks.windowMs
    w.tokens = w.tokens.filter((e) => e.ts > cutoff)
    w.requests = w.requests.filter((ts) => ts > cutoff)
    const usedTokens = w.tokens.reduce((s, e) => s + e.n, 0)
    const overTokens = tpm != null ? usedTokens + estimated - tpm : 0
    const overRequests = rpm != null ? w.requests.length + 1 - rpm : 0
    if (overTokens <= 0 && overRequests <= 0) break
    let waitMs = _rateHooks.windowMs
    if (overTokens > 0) {
      let freed = 0
      for (const e of w.tokens) {
        freed += e.n
        if (freed >= overTokens) {
          waitMs = Math.min(waitMs, e.ts + _rateHooks.windowMs - now)
          break
        }
      }
    }
    if (overRequests > 0) {
      waitMs = Math.min(waitMs, w.requests[overRequests - 1] + _rateHooks.windowMs - now)
    }
    waitMs = Math.max(waitMs, 50)
    onWait?.({ phase: "gate", seconds: Math.ceil(waitMs / 1000) })
    await _rateHooks.sleep(waitMs)
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
  }
}

/** Accounting: record measured usage after response returns */
export function recordRate(provider, estimated, usage) {
  if (provider.tpm == null && provider.rpm == null) return
  const key = rateKey(provider)
  const w = rateWindows.get(key) ?? { tokens: [], requests: [] }
  const now = _rateHooks.now()
  const cutoff = now - _rateHooks.windowMs
  w.tokens = w.tokens.filter((e) => e.ts > cutoff)
  w.requests = w.requests.filter((ts) => ts > cutoff)
  w.requests.push(now)
  w.tokens.push({ ts: now, n: usage ? (usage.prompt_tokens ?? estimated) + (usage.completion_tokens ?? 0) : estimated })
  if (w.tokens.length === 0 && w.requests.length === 0) rateWindows.delete(key)
  else rateWindows.set(key, w)
}

// ── Core: chat with continuation ──────────────────────────

/**
 * Send a streaming chat completion request with:
 *  - TPM/RPM rate gating before sending
 *  - Automatic continuation on truncation (finish_reason=length)
 *  - DeepSeek prefix completion via /beta endpoint
 *  - Exponential backoff on 429/5xx with Retry-After support
 *  - Quota error detection (non-retryable)
 */
export async function chat(provider, { messages, tools, onToken, onReasoning, onWait, signal }) {
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

  const estimated = estimateRequestTokens(body)
  await rateGate(provider, estimated, onWait, signal)

  const response = await requestWithRetry(provider, body, signal, onWait)
  const result = await readSSE(response, { onToken, onReasoning })
  recordRate(provider, estimated, result.usage)

  if (!spec.partialMode && !spec.prefixMode) return result
  if (spec.prefixMode && !spec.partialMode && result.reasoning) return result
  for (let n = 0; result.finishReason === "length" && result.content && n < MAX_CONTINUATIONS; n++) {
    const continued = await chat(spec.prefixMode ? { ...provider, baseURL: betaBaseURL(provider.baseURL) } : provider, {
      messages: [
        ...messages,
        spec.partialMode
          ? {
              role: "assistant",
              content: result.content,
              partial: true,
              ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
            }
          : { role: "assistant", content: result.content, prefix: true },
      ],
      tools,
      onToken,
      onReasoning,
      onWait,
      signal,
    })
    result.content += continued.content
    result.reasoning += continued.reasoning ?? ""
    for (const tc of continued.toolCalls ?? []) {
      const idx = tc.index ?? result.toolCalls.length
      while (result.toolCalls.length <= idx) {
        result.toolCalls.push({ id: "", type: "function", function: { name: "", arguments: "" } })
      }
      if (tc.id) result.toolCalls[idx].id = tc.id
      result.toolCalls[idx].function.name += tc.function?.name ?? ""
      result.toolCalls[idx].function.arguments += tc.function?.arguments ?? ""
    }
    result.finishReason = continued.finishReason
    if (continued.usage) {
      const sum = (k) => (result.usage?.[k] ?? 0) + (continued.usage[k] ?? 0)
      result.usage = {
        prompt_tokens: sum("prompt_tokens"),
        completion_tokens: sum("completion_tokens"),
        total_tokens: sum("total_tokens"),
        prompt_cache_hit_tokens: sum("prompt_cache_hit_tokens"),
        prompt_cache_miss_tokens: sum("prompt_cache_miss_tokens"),
      }
    }
  }
  return result
}

// ── HTTP request with retry ───────────────────────────────

async function requestWithRetry(provider, body, signal, onWait) {
  let lastError
  let lastWas429 = false
  let rateLimitHits = 0
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0 && !lastWas429) await _rateHooks.sleep(2 ** (attempt - 1) * 1000)
    lastWas429 = false

    let response
    try {
      response = await fetch(`${provider.baseURL.replace(/\/+$/, "")}${provider.chatPath ?? "/chat/completions"}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      if (error.name === "AbortError") throw error
      lastError = error
      continue
    }

    if (response.ok) return response

    const text = await response.text().catch(() => "")
    const message = `LLM API error ${response.status}: ${text}`
    if (isQuotaError(text)) throw new Error(message)
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"))
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : RATE_LIMIT_BACKOFF_MS[Math.min(rateLimitHits++, RATE_LIMIT_BACKOFF_MS.length - 1)]
      lastError = new Error(message)
      lastWas429 = true
      if (attempt < MAX_RETRIES) {
        onWait?.({ phase: "retry", seconds: Math.ceil(waitMs / 1000) })
        await _rateHooks.sleep(waitMs)
      }
      continue
    }
    if (RETRYABLE_STATUS.has(response.status)) {
      lastError = new Error(message)
      continue
    }
    throw new Error(message)
  }
  throw lastError
}

function isQuotaError(text) {
  try {
    const type = JSON.parse(text)?.error?.type
    return typeof type === "string" && type.includes("quota")
  } catch {
    return false
  }
}

// ── SSE reader ────────────────────────────────────────────

async function readSSE(response, { onToken, onReasoning }) {
  const result = { content: "", reasoning: "", toolCalls: [], usage: null, finishReason: null }
  const decoder = new TextDecoder()
  let buffer = ""

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
        const idx = tc.index ?? 0
        while (result.toolCalls.length <= idx) {
          result.toolCalls.push({ id: "", type: "function", function: { name: "", arguments: "" } })
        }
        if (tc.id) result.toolCalls[idx].id = tc.id
        if (tc.function?.name) result.toolCalls[idx].function.name += tc.function.name
        if (tc.function?.arguments) result.toolCalls[idx].function.arguments += tc.function.arguments
      }
    }
  }

  if (!response.body) throw new Error("No stream response body")
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop()
    processLines(lines)
  }
  buffer += decoder.decode()
  processLines(buffer.split("\n"))
  return result
}

function betaBaseURL(baseURL) {
  // Already on beta endpoint — don't double-append (handles recursive continuation)
  if (/\/beta$/.test(baseURL)) return baseURL
  if (/\/v1$/.test(baseURL)) return baseURL.replace(/\/v1$/, "/beta")
  return baseURL.endsWith("/") ? baseURL + "beta" : baseURL + "/beta"
}

// ── Model listing ─────────────────────────────────────────

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
