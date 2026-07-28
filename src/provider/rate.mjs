/**
 * rate.mjs — TPM/RPM rate-limiting gate for LLM providers
 * OpenAI-compatible. Zero dependencies.
 */

import { specForModel } from "../specs.mjs"

export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
export const MAX_RETRIES = 3
export const MAX_CONTINUATIONS = 3
export const RATE_LIMIT_BACKOFF_MS = [15_000, 30_000, 60_000]

/**
 * Test hooks: sleep/clock/window length are replaceable.
 * Production code should never call setTimeout/sleep directly — always go through these.
 */
export const _rateHooks = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  windowMs: 60_000,
}

const rateWindows = new Map()

function rateKey(provider) {
  return (provider.baseURL || "").replace(/\/+$/, "").toLowerCase()
}

export function estimateText(s) {
  if (!s) return 0
  if (Array.isArray(s)) {
    // multimodal content array — count text parts + estimate image tokens
    let tokens = 0
    for (const part of s) {
      if (part.type === "text") tokens += Math.ceil(part.text.replace(/\s+/g, " ").length / 4)
      else if (part.type === "image_url") tokens += 85 // ~85 tokens per image
    }
    return tokens
  }
  return Math.ceil(s.replace(/\s+/g, " ").length / 4)
}

export function estimateRequestTokens(body) {
  let tokens = 16
  for (const m of body.messages || []) {
    tokens += 16 + estimateText(m.content || "")
    tokens += estimateText(m.reasoning_content || "")
  }
  if (body.tools) tokens += 128
  if (body.max_tokens) tokens += body.max_tokens
  return Math.ceil(tokens / 100) * 100
}

export async function rateGate(provider, estimated, onWait, signal) {
  const key = rateKey(provider)
  const spec = specForModel(provider.model)
  const tpm = provider.tpm ?? spec.tpm ?? 1_000_000
  const rpm = provider.rpm ?? spec.rpm ?? 500

  if (!rateWindows.has(key)) {
    rateWindows.set(key, { tokens: 0, requests: 0, start: _rateHooks.now() })
  }
  const w = rateWindows.get(key)

  const now = _rateHooks.now()
  if (now - w.start >= _rateHooks.windowMs) {
    w.tokens = 0
    w.requests = 0
    w.start = now
  }

  while (w.tokens + estimated > tpm || w.requests + 1 > rpm) {
    const remainMs = _rateHooks.windowMs - (now - w.start)
    if (remainMs <= 0) {
      w.tokens = 0
      w.requests = 0
      w.start = now
      break
    }
    const waitMs = Math.min(remainMs + 100, 10_000)
    onWait?.({ phase: "rate", seconds: Math.ceil(waitMs / 1000) })
    await _rateHooks.sleep(waitMs)
    const now2 = _rateHooks.now()
    if (now2 - w.start >= _rateHooks.windowMs) {
      w.tokens = 0
      w.requests = 0
      w.start = now2
      break
    }
  }

  w.tokens += estimated
  w.requests++
}

export function recordRate(provider, estimated, usage) {
  if (!usage) return
  const key = rateKey(provider)
  const w = rateWindows.get(key)
  if (!w) return
  const actual = usage.total_tokens ?? estimated
  w.tokens = Math.max(0, w.tokens - (estimated - actual))
}
