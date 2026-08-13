/**
 * provider.mjs — LLM call core (synced from thincoder CLI src/provider/core.mjs)
 * chat / listModels / requestWithRetry / transport dispatch
 */

import { specForModel } from "./specs.mjs"
import { proxyFetch } from "./proxy.mjs"
import {
  RETRYABLE_STATUS, MAX_RETRIES, MAX_CONTINUATIONS,
  RATE_LIMIT_BACKOFF_MS, _rateHooks,
  estimateRequestTokens, rateGate, recordRate,
} from "./provider/rate.mjs"
import * as openaiTransport from "./provider/transports/openai.mjs"
import * as anthropicTransport from "./provider/transports/anthropic.mjs"
import * as googleTransport from "./provider/transports/google.mjs"

// Hard per-request ceiling (CLI parity: core.mjs / anthropic.mjs / google.mjs all use
// 600_000). Reasoning models on long contexts legitimately think for minutes before
// the first token — 120s aborted real requests with "The operation was aborted due
// to timeout". 10 minutes is the CLI-proven bound; the user's abort button is the
// real escape hatch for anything faster.
export const FETCH_TIMEOUT_MS = 600_000

// AbortSignal.any polyfill for Node 18 / VS Code's Electron (Node 20.3+ has native)
const _anySignal = AbortSignal.any || ((signals) => {
  const ctrl = new AbortController()
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true })
  }
  return ctrl.signal
})

/**
 * Sanitize image parts that would 400 the request (CLI core.mjs parity):
 * - model has no vision support → strip all image parts (text-only APIs reject the
 *   ENTIRE request if any message contains an image part, bricking the conversation);
 * - model IS vision-capable but the data URL is not a raster format (Kimi/Anthropic/
 *   OpenAI/Gemini are all raster-only — Kimi 400s "unsupported image format" on EVERY
 *   subsequent request once an svg/bmp part sits in history) → replace with a text
 *   placeholder so the model knows an image was there.
 * History itself is left untouched, so switching back to a capable model restores images.
 */
const RASTER_IMAGE_URL = /^data:image\/(png|jpe?g|gif|webp);base64,/

export function stripImagesForTextModel(messages, spec) {
  return messages.map((m) => {
    if (!Array.isArray(m.content) || !m.content.some((p) => p?.type === "image_url")) return m
    if (!spec.multimodal) {
      const textOnly = m.content.filter((part) => part.type === "text")
      return { ...m, content: textOnly }
    }
    let msgChanged = false
    const parts = m.content.map((p) => {
      if (p?.type !== "image_url") return p
      const url = p.image_url?.url || ""
      if (!url.startsWith("data:") || RASTER_IMAGE_URL.test(url)) return p
      msgChanged = true
      const fmt = url.match(/^data:([^;,]+)/)?.[1] || "unknown"
      return { type: "text", text: `[image omitted — unsupported format ${fmt}]` }
    })
    return msgChanged ? { ...m, content: parts } : m
  })
}

const TRANSPORTS = {
  openai: openaiTransport,
  anthropic: anthropicTransport,
  google: googleTransport,
}

function getTransport(provider) {
  return TRANSPORTS[provider.format] || TRANSPORTS.openai
}

/** Send a streaming chat completion request with automatic continuation on truncation */
export async function chat(provider, { messages, tools, onToken, onReasoning, onWait, signal }) {
  const spec = specForModel(provider.model)
  const transport = getTransport(provider)
  messages = stripImagesForTextModel(messages, spec)

  // Validate reasoning effort for models that use it
  if (provider.reasoningEffort && provider.format !== "anthropic" && provider.format !== "google") {
    if (spec.reasoningEffortEnum && !spec.reasoningEffortEnum.includes(provider.reasoningEffort)) {
      throw new Error(
        `reasoning_effort "${provider.reasoningEffort}" not supported by model "${provider.model}"; ` +
        `valid values: ${spec.reasoningEffortEnum.join(", ")}`
      )
    }
  }

  const normalizedTools = transport.normalizeTools(tools)
  const req = transport.buildRequest(provider, messages, normalizedTools)
  const estimated = estimateRequestTokens(JSON.parse(req.body))
  await rateGate(provider, estimated, onWait, signal)

  const response = await requestWithRetry(provider, req.url, req.headers, req.body, signal, onWait)
  const result = await transport.parseStream(response, { onToken, onReasoning, signal })
  recordRate(provider, estimated, result.usage)

  // Continuation handling (OpenAI-format only — Claude/Gemini handle truncation differently)
  const isOpenAI = provider.format === "openai" || !provider.format
  if (isOpenAI && (!spec.partialMode && !spec.prefixMode)) return result
  if (isOpenAI && spec.prefixMode && !spec.partialMode && result.reasoning) return result
  for (let n = 0; result.finishReason === "length" && result.content && n < MAX_CONTINUATIONS; n++) {
    const continued = await chat(
      isOpenAI && spec.prefixMode ? { ...provider, baseURL: betaBaseURL(provider.baseURL) } : provider,
      {
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
      },
    )
    result.content += continued.content
    result.reasoning += continued.reasoning ?? ""
    for (const tc of continued.toolCalls ?? []) {
      const idx = tc.index ?? result.toolCalls.length
      const s = (result.toolCalls[idx] ??= { id: "", name: "", arguments: "" })
      if (tc.id) s.id = tc.id
      s.name += tc.name ?? ""
      s.arguments += tc.arguments ?? ""
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

/** List available model IDs from the provider's /models endpoint */
export async function listModels(provider, { signal } = {}) {
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), 15000)
  if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true })
  try {
    const response = await proxyFetch(`${provider.baseURL}/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: ctrl.signal,
    }, provider.proxyUri)
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`GET /models failed ${response.status}: ${text}`)
    }
    const data = await response.json()
    return (data.data ?? []).map((m) => m.id).filter(Boolean).sort()
  } catch (e) {
    if (e.name === "AbortError") return [] // timeout/silence → empty list
    throw e
  } finally {
    clearTimeout(timeout)
  }
}

async function requestWithRetry(provider, url, headers, body, signal, onWait) {
  let lastError
  let lastWas429 = false
  let rateLimitHits = 0
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0 && !lastWas429) await _rateHooks.sleep(2 ** (attempt - 1) * 1000)
    lastWas429 = false

    let response
    try {
      response = await proxyFetch(url, {
        method: "POST",
        headers,
        body,
        signal: signal ? _anySignal([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }, provider.proxyUri)
    } catch (error) {
      if (error.name === "AbortError") throw error
      lastError = error
      continue
    }

    if (response.ok) return response

    const text = await response.text().catch(() => "")
    let message = `LLM API error ${response.status}: ${text}`
    // Kimi has TWO separate platforms with non-interchangeable keys (IK5VGJ):
    // Moonshot (api.moonshot.cn, sk-...) vs Kimi For Coding (api.kimi.com/coding/v1, sk-kimi-...).
    // A 401 on either endpoint is usually a wrong-platform key — say so instead of a bare 401.
    if (response.status === 401) {
      const key = String(provider.apiKey ?? "").trim()
      const base = String(provider.baseURL ?? "").toLowerCase()
      const kimiCodeKey = /^sk-kimi-/i.test(key)
      const kimiCodeUrl = base.includes("api.kimi.com")
      if (kimiCodeKey || kimiCodeUrl) {
        message += " — tip: Kimi has two separate platforms with NON-interchangeable API keys: Moonshot (api.moonshot.cn/v1, sk-...) and Kimi For Coding (api.kimi.com/coding/v1, sk-kimi-...). Your key or baseURL looks mismatched — check which platform issued it."
      }
    }
    if (isNonRetryableError(response.status, text)) throw new Error(message)
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

/**
 * Detect errors that should NOT be retried — quota, billing, auth, invalid params.
 * Different providers use wildly different error formats. Check body text for known patterns.
 */
function isNonRetryableError(status, text) {
  // Auth errors: never retry
  if (status === 401 || status === 403) return true
  // 400-level non-429: usually invalid params
  if (status >= 400 && status < 500 && status !== 429) return true
  // For 429, check if it's actually a billing/quota error (not rate limit)
  if (status === 429) {
    const lower = text.toLowerCase()
    // Chinese providers often return 429 for billing issues
    if (lower.includes("余额不足") || lower.includes("余额") || lower.includes("充值")) return true
    if (lower.includes("insufficient") && (lower.includes("balance") || lower.includes("quota") || lower.includes("credit"))) return true
    if (lower.includes("quota") && (lower.includes("exceeded") || lower.includes("insufficient"))) return true
    // Standard OpenAI billing error (error.type === "insufficient_quota" or similar)
    try {
      const j = JSON.parse(text)
      const errType = j?.error?.type || ""
      if (typeof errType === "string" && (errType.includes("quota") || errType.includes("billing") || errType.includes("insufficient") || errType.includes("balance"))) return true
      const errCode = j?.error?.code || ""
      if (typeof errCode === "string" && (errCode === "1113" || errCode === "1114")) return true // GLM billing codes
    } catch {}
  }
  return false
}

function betaBaseURL(baseURL) {
  // DeepSeek prefix continuation uses /beta endpoint; only handle /v1 suffix, append /beta when /v1 is missing
  if (/\/v1$/.test(baseURL)) return baseURL.replace(/\/v1$/, "/beta")
  return baseURL.endsWith("/") ? baseURL + "beta" : baseURL + "/beta"
}
