/**
 * provider.mjs — LLM call core (synced from thincoder CLI src/provider/core.mjs)
 * chat / listModels / requestWithRetry / transport dispatch
 */

import { specForModel } from "./specs.mjs"
import { proxyFetch } from "./proxy.mjs"
import { traceStop } from "./extension/stop-trace.mjs"
import {
  RETRYABLE_STATUS, MAX_RETRIES, MAX_CONTINUATIONS,
  RATE_LIMIT_BACKOFF_MS, _rateHooks,
  estimateRequestTokens, rateGate, recordRate, abortableSleep,
} from "./provider/rate.mjs"
import * as openaiTransport from "./provider/transports/openai.mjs"
import * as anthropicTransport from "./provider/transports/anthropic.mjs"
import * as googleTransport from "./provider/transports/google.mjs"
import * as responsesTransport from "./provider/transports/responses.mjs"

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

/**
 * Enforce the OpenAI tool-message protocol on the outgoing payload (CLI provider/core.mjs
 * normalizeToolPairing parity): every tool message must immediately follow the assistant
 * declaring its tool_call_id, and every declared tool_call must have a result. Strict
 * providers (Kimi, DeepSeek) reject the whole request with 400 ("an assistant message with
 * 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'").
 * History can legitimately violate this — parallel readonly batches inject other messages
 * between tool results, compaction splits, interrupted sessions leave dangling tool_calls —
 * so sanitize at send time. History itself is left untouched.
 */
export function normalizeToolPairing(messages) {
  // Detach all tool messages; reinsert each right after its owner assistant.
  const toolById = new Map()
  const rest = []
  for (const m of messages) {
    if (m.role === "tool") {
      if (!toolById.has(m.tool_call_id)) toolById.set(m.tool_call_id, m)
    } else {
      rest.push(m)
    }
  }
  if (toolById.size === 0 && !messages.some((m) => m.role === "assistant" && m.tool_calls?.length)) {
    return messages // no tool messages AND no tool_calls declared — nothing to enforce
  }
  const out = []
  for (const m of rest) {
    out.push(m)
    if (m.role !== "assistant" || !m.tool_calls?.length) continue
    for (const tc of m.tool_calls) {
      const t = toolById.get(tc.id)
      if (t) {
        toolById.delete(tc.id)
        out.push(t)
      } else {
        // Declared tool_call with no recorded result (interrupted session / compaction split)
        out.push({
          role: "tool",
          tool_call_id: tc.id,
          content: "[Tool result missing: the call was interrupted or its result was dropped by context compaction]",
        })
      }
    }
  }
  // Leftovers in toolById are orphans (owner assistant compacted away or never recorded) — dropped
  return out
}

const TRANSPORTS = {
  openai: openaiTransport,
  anthropic: anthropicTransport,
  google: googleTransport,
  responses: responsesTransport,
}

function getTransport(provider) {
  return TRANSPORTS[provider.format] || TRANSPORTS.openai
}

/** IKBGX4 (CLI escape.mjs parity)：剥离整消息本地标记字段（transient）——严格 OpenAI 兼容
 * 服务端（opencode/LiteLLM 等）拒绝消息级未知 key（"Extra inputs are not permitted"）。 */
export function stripLocalMessageFields(messages) {
  return messages.map((m) => {
    if (m && typeof m === "object" && "transient" in m) {
      const { transient, ...rest } = m
      return rest
    }
    return m
  })
}

/** Send a streaming chat completion request with automatic continuation on truncation */
export async function chat(provider, { messages, tools, onToken, onReasoning, onWait, signal, toolChoice, parallelToolCalls }) {
  const spec = specForModel(provider.model)
  const transport = getTransport(provider)
  messages = stripImagesForTextModel(messages, spec)
  messages = normalizeToolPairing(messages) // strict providers 400 on orphan tool_calls (kimi hit this live 2026-08-16)
  messages = stripLocalMessageFields(messages) // IKBGX4: transient 等本地标记不得进入载荷

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
  // 2026-08-31：tool_choice/parallel_tool_calls 能力层（OpenAI 直传；anthropic/google 各自映射）
  const req = transport.buildRequest(provider, messages, normalizedTools, { toolChoice, parallelToolCalls })
  // 2026-08-31 Responses 链：本地全量 messages 估算（responses body 无 messages 键，估算器不认 input items）
  const estimated = estimateRequestTokens(provider.format === "responses" ? { messages } : JSON.parse(req.body))
  traceStop(`chat: awaiting rate gate (est ${estimated} tokens)`)
  await rateGate(provider, estimated, onWait, signal)
  traceStop("chat: rate gate passed — issuing request")

  let response
  try {
    response = await requestWithRetry(provider, req.url, req.headers, req.body, signal, onWait)
  } catch (err) {
    // 2026-08-31 评审 #1（CLI parity D6）：responses 链失效（400/404）回退——先清残留链再重建，
    // 真·全量重发；不清链则 buildRequest 增量分支输出裸工具结果且 previous_response_id
    // 不随 header 带走 → 服务端 call_id 无归属二次 400
    if (transport === responsesTransport && typeof err?.status === "number" && (err.status === 400 || err.status === 404)) {
      provider._responsesChain = null
      const freshReq = transport.buildRequest(provider, messages, normalizedTools, { toolChoice, parallelToolCalls })
      response = await requestWithRetry(provider, freshReq.url, freshReq.headers, freshReq.body, signal, onWait)
    } else {
      throw err
    }
  }
  traceStop("chat: response ok — parsing stream")
  const result = await transport.parseStream(response, { onToken, onReasoning, signal })
  traceStop("chat: stream parsed — returning to agent loop")
  recordRate(provider, estimated, result.usage)
  // 2026-08-31 Responses 链推进：completed 的 responseId 供同一 turn 后续增量；截断/失败作废
  if (transport === responsesTransport) {
    if (req._chainMeta && result.finishReason !== "length" && result.responseId) {
      provider._responsesChain = { ...req._chainMeta, id: result.responseId }
    } else {
      provider._responsesChain = null
    }
  }

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
    // 2026-08-31 会诊 #6（与 CLI 465b9c3 #7 对齐）：续写合并时 readSSE 输出的 tc 已
    // finalize（无 index 字段）——原实现恒 append，provider 重发完整 tc 会把 tool 名
    // 拼成 "get_weatherget_weather"、arguments 重复。按 id/name 定位已有槽位，name 只设一次。
    for (const tc of continued.toolCalls ?? []) {
      if (!tc) continue
      let s = tc.id ? result.toolCalls.find((x) => x && x.id === tc.id) : undefined
      if (!s) s = tc.name ? result.toolCalls.find((x) => x && x.name === tc.name) : undefined
      if (!s) { s = { id: "", name: "", arguments: "" }; result.toolCalls.push(s) }
      if (tc.id && !s.id) s.id = tc.id
      if (tc.name && !s.name) s.name = tc.name
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
    // 2026-08-31 会诊 #10：代理/网关返回 HTML 或非 JSON 时 response.json() 抛 SyntaxError
    // 直接冒到模型下拉框——先 text 再容错解析，失败返回空列表（下拉框自然显示无模型）。
    const rawText = await response.text().catch(() => "")
    let data = null
    try { data = JSON.parse(rawText) } catch { /* non-JSON body → empty list */ }
    return (data?.data ?? []).map((m) => m.id).filter(Boolean).sort()
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
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    if (attempt > 0 && !lastWas429) await abortableSleep(2 ** (attempt - 1) * 1000, signal)
    lastWas429 = false

    let response
    try {
      response = await proxyFetch(url, {
        method: "POST",
        headers,
        body,
        signal: signal ? _anySignal([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // 2026-08-31 会诊 #2（与 CLI 465b9c3 #4 对齐）：代理路径响应头超时对齐直连语义——
        // 原 15s 与直连 600s 割裂，推理模型走代理 TTFB>15s 即误报 "Response timeout"。
        _headerTimeoutMs: FETCH_TIMEOUT_MS,
        _bodyIdleMs: 120_000,
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
    if (isNonRetryableError(response.status, text)) {
      const e = new Error(message); e.status = response.status; throw e // status 供 responses D6 回退识别（2026-08-31 评审 #1）
    }
    if (response.status === 429) {
      // 计费/配额类 429（余额不足/充值/insufficient_quota 等）不是限流：立即抛错不干等
      // （round3 #4，CLI b86c453 后对齐）——isNonRetryableError 同文本特征
      if (/余额不足|充值|insufficient_quota|quota exhausted|billing|1113|1114/i.test(text ?? "")) {
        onWait?.({ phase: "quota", message: `quota exhausted: ${text.slice(0, 200)}` })
        const e = new Error(message); e.status = 429; throw e
      }
      // 2026-08-31 会诊 #5（与 CLI 465b9c3 #11 对齐）：Retry-After 支持秒数/HTTP-date，
      // 上限 300s——服务端异常头（1 小时级）不得让 CLI 干等。
      const waitMs = parseRetryAfter(response.headers.get("retry-after"), rateLimitHits)
      rateLimitHits++
      lastError = new Error(message)
      lastWas429 = true
      if (attempt < MAX_RETRIES) {
        onWait?.({ phase: "retry", seconds: Math.ceil(waitMs / 1000) })
        await abortableSleep(waitMs, signal)
      }
      continue
    }
    if (RETRYABLE_STATUS.has(response.status)) {
      lastError = new Error(message)
      continue
    }
    const e = new Error(message); e.status = response.status; throw e
  }
  throw lastError
}

/** Parse Retry-After: 秒数 or HTTP-date；上限 300s（2026-08-31 会诊 #5）— 异常头不得让 CLI 睡数小时。
 *  header 缺失/非法时退回指数退避表（rateLimitHits 计数取档）。 */
export function parseRetryAfter(header, rateLimitHits = 0) {
  const fallback = RATE_LIMIT_BACKOFF_MS[Math.min(rateLimitHits, RATE_LIMIT_BACKOFF_MS.length - 1)]
  if (header == null) return fallback
  let waitMs = 0
  const numeric = Number(header.trim())
  if (Number.isFinite(numeric) && numeric >= 0) waitMs = numeric * 1000
  else {
    const date = Date.parse(header.trim())
    if (Number.isFinite(date)) waitMs = Math.max(0, date - Date.now())
  }
  if (waitMs <= 0) return fallback
  return Math.min(waitMs, 300_000)
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
