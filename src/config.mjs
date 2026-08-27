/**
 * config.mjs — Model capability specs (self-contained copy)
 * One source per spec row; `specForModel` matches by prefix (case-insensitive).
 *
 * Field reference:
 *   context:               context window size in tokens
 *   maxOutput:             max output tokens
 *   thinking:              model supports thinking mode (true/false)
 *   multimodal:            model supports image inputs
 *   prefixMode:            truncation protocol: uses prefix-based continuation
 *   partialMode:           truncation protocol: partially-available response
 *   cacheMode:             "auto" | "prompt" | "none"
 *   thinkApi:              "type"=thinking.type field | "effort"=reasoning_effort field
 *   thinkEnabledValue:     when thinkApi is "type", the value used to enable thinking (default "enabled"; MiniMax uses "adaptive")
 *   reasoningEcho:         "required"=must echo | "optional"=optional (default: don't echo)
 *   reasoningEffortEnum:   valid reasoning_effort values
 *   reasoningEffortDefault: default reasoning_effort value (preselected in model picker)
 *   tempRange:             [min, max] temperature range
 *   noUsageStream:         true = omit stream_options.include_usage (provider doesn't support usage streaming)
 *   format:                API wire format: "openai" (default) | "anthropic" | "google"
 */
const MODEL_SPECS = [
  // DeepSeek V4 series (official Models & Pricing: dual models, both 1M ctx / 384K out,
  // thinking default-on with effort low/high/max, automatic disk cache)
  ["deepseek-v4-pro",   { context: 1_000_000, maxOutput: 384_000, thinking: true,  prefixMode: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["low", "high", "max"], reasoningEffortDefault: "high", tempRange: [0, 2] }],
  ["deepseek-v4-flash", { context: 1_000_000, maxOutput: 384_000, thinking: true,  prefixMode: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["low", "high", "max"], reasoningEffortDefault: "high", tempRange: [0, 2] }],
  // DeepSeek V4 Flash Vision (experimental) — image input on top of the full V4-Flash stack
  ["deepseek-v4-flash-vision-exp", { context: 1_000_000, maxOutput: 384_000, thinking: true,  prefixMode: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["low", "high", "max"], reasoningEffortDefault: "high", tempRange: [0, 2], multimodal: true }],
  // Kimi series
  ["kimi-k3",           { context: 1_000_000, maxOutput: 131_072, thinking: true,  partialMode: true, multimodal: true, cacheMode: "auto", thinkApi: "effort", reasoningEcho: "required", reasoningEffortEnum: ["low", "high", "max"], reasoningEffortDefault: "max" }],
  ["kimi/kimi-k3",      { context: 1_000_000, maxOutput: 131_072, thinking: true,  partialMode: true, multimodal: true, cacheMode: "auto", thinkApi: "effort", reasoningEcho: "required", reasoningEffortEnum: ["low", "high", "max"], reasoningEffortDefault: "max" }],
  // Kimi For Coding endpoint uses the short model ID "k3" (same specs as kimi-k3) — IK5VGJ
  ["k3",                { context: 1_000_000, maxOutput: 131_072, thinking: true,  partialMode: true, multimodal: true, cacheMode: "auto", thinkApi: "effort", reasoningEcho: "required", reasoningEffortEnum: ["low", "high", "max"], reasoningEffortDefault: "max" }],
  // GLM series
  // GLM-5.3: thinking always-on (no "disabled"); effort converges to low/high/max — NOT the
  //          7-level glm-5.2 enum (verified vs docs.bigmodel.cn GLM-5.3 page, 2026-08)
  ["glm-5.3",           { context: 1_000_000, maxOutput: 128_000, thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", reasoningEffortEnum: ["low", "high", "max"], reasoningEffortDefault: "max", tempRange: [0, 1], noUsageStream: true }],
  ["glm-5.3-flash",     { context: 1_000_000, maxOutput: 128_000, thinking: true, multimodal: true, cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", reasoningEffortEnum: ["low", "high", "max"], reasoningEffortDefault: "max", tempRange: [0, 1], noUsageStream: true }],
  ["glm-5.2",           { context: 1_000_000, maxOutput: 128_000, thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", reasoningEffortEnum: ["max", "xhigh", "high", "medium", "low", "minimal", "none"], reasoningEffortDefault: "max", tempRange: [0, 1], noUsageStream: true }],
  ["glm-5",             { context: 1_000_000, maxOutput: 128_000, thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", reasoningEffortEnum: ["max", "xhigh", "high", "medium", "low", "minimal", "none"], reasoningEffortDefault: "max", tempRange: [0, 1], noUsageStream: true }],
  ["glm-4",             { context: 128_000,   maxOutput: 32_000,  thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", tempRange: [0, 1], noUsageStream: true }],
  // GPT series
  ["gpt-5.6-sol",       { context: 1_050_000, maxOutput: 128_000, thinking: false, multimodal: true, cacheMode: "prompt" }],
  ["gpt-5.6",           { context: 1_050_000, maxOutput: 128_000, thinking: false, multimodal: true, cacheMode: "prompt" }],
  ["gpt-4.1",           { context: 1_000_000, maxOutput: 128_000, thinking: false, cacheMode: "prompt" }],
  ["gpt-4o",            { context: 128_000,   maxOutput: 16_000,  thinking: false, multimodal: true, cacheMode: "prompt" }],
  // Claude series (Anthropic)
  ["claude-opus-5",     { context: 1_000_000, maxOutput: 128_000, thinking: false, multimodal: true, cacheMode: "none", format: "anthropic" }],
  ["claude-sonnet-5",   { context: 1_000_000, maxOutput: 128_000, thinking: false, multimodal: true, cacheMode: "none", format: "anthropic" }],
  ["claude-opus-4",     { context: 200_000,   maxOutput: 32_000,  thinking: false, multimodal: true, cacheMode: "none", format: "anthropic" }],
  ["claude-sonnet-4",   { context: 200_000,   maxOutput: 32_000,  thinking: false, multimodal: true, cacheMode: "none", format: "anthropic" }],
  ["claude-3.5-haiku",  { context: 200_000,   maxOutput: 8_192,   thinking: false, cacheMode: "none", format: "anthropic" }],
  // Gemini series (Google)
  ["gemini-3-pro",      { context: 1_000_000, maxOutput: 64_000,  thinking: false, multimodal: true, cacheMode: "none", format: "google", noUsageStream: true }],
  ["gemini-2.5-pro",    { context: 2_000_000, maxOutput: 64_000,  thinking: false, multimodal: true, cacheMode: "none", format: "google", noUsageStream: true }],
  ["gemini-2.5-flash",  { context: 1_000_000, maxOutput: 64_000,  thinking: false, multimodal: true, cacheMode: "none", format: "google", noUsageStream: true }],
  // Qwen series
  ["qwen3.8-max-preview", { context: 1_000_000, maxOutput: 131_072, thinking: true,  partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", reasoningEffortEnum: ["xhigh", "medium", "low"], reasoningEffortDefault: "xhigh", tempRange: [0, 2] }],
  // qwen3.7-max rejects image parts outright (DashScope 400 "Unexpected item type in content") — text-only.
  // CLI config.mjs marks it WITHOUT multimodal; keep in sync.
  ["qwen3.7-max",       { context: 1_000_000, maxOutput: 131_072, thinking: true,  partialMode: true, cacheMode: "none", thinkApi: "effort", reasoningEffortEnum: ["xhigh", "high"], tempRange: [0, 2] }],
  ["qwen3.8-max",       { context: 1_000_000, maxOutput: 131_072, thinking: true,  partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", reasoningEffortEnum: ["xhigh", "medium", "low"], reasoningEffortDefault: "xhigh", tempRange: [0, 2] }],
  ["qwen-max",          { context: 1_000_000, maxOutput: 131_072, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen-plus",         { context: 1_000_000, maxOutput: 131_072, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen",              { context: 1_000_000, maxOutput: 131_072, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  // MiniMax series
  ["MiniMax-M3",        { context: 1_000_000, maxOutput: 128_000, thinking: true,  multimodal: true, cacheMode: "auto", thinkApi: "type", thinkEnabledValue: "adaptive", tempRange: [0, 2], noUsageStream: true }],
  // MiMo series (Xiaomi — OpenAI-compatible https://api.xiaomimimo.com/v1;
  // deep thinking via thinking.type, default ON; multi-turn tool calls MUST echo
  // reasoning_content back exactly like DeepSeek V4, else 400 on follow-ups)
  ["mimo-v2.5-pro",     { context: 1_000_000, maxOutput: 128_000, thinking: true,  thinkApi: "type", reasoningEcho: "required", tempRange: [0, 1.5] }],
  ["mimo-v2.5",         { context: 1_000_000, maxOutput: 128_000, thinking: true,  multimodal: true, thinkApi: "type", reasoningEcho: "required", tempRange: [0, 1.5] }],
  ["minimax-m3",        { context: 1_000_000, maxOutput: 128_000, thinking: true,  multimodal: true, cacheMode: "auto", thinkApi: "type", thinkEnabledValue: "adaptive", tempRange: [0, 2], noUsageStream: true }],
  ["minimax-m1",        { context: 256_000,   maxOutput: 128_000, thinking: false, cacheMode: "auto", noUsageStream: true }],
  // Grok series (xAI — OpenAI-compatible)
  // grok-4.x: 500K context per xAI Grok 4.6 spec (corrected 2026-08; earlier entries said 1M)
  ["grok-4.6",          { context: 500_000,   maxOutput: 64_000,  thinking: false, multimodal: true, tempRange: [0, 2] }],
  ["grok-4.5",          { context: 500_000,   maxOutput: 64_000,  thinking: false, multimodal: true, tempRange: [0, 2] }],
  ["grok-4",            { context: 500_000,   maxOutput: 64_000,  thinking: false, multimodal: true, tempRange: [0, 2] }],
  ["grok-4-mini",       { context: 128_000,   maxOutput: 16_000,  thinking: false, tempRange: [0, 2] }],
  // Mistral series (OpenAI-compatible)
  ["mistral-large",     { context: 128_000,   maxOutput: 32_000,  thinking: false, multimodal: true, tempRange: [0, 2] }],
  ["codestral",         { context: 256_000,   maxOutput: 32_000,  thinking: false, tempRange: [0, 2] }],
]

const DEFAULT_SPEC = { context: 128_000, maxOutput: 32_000, cacheMode: "none" }

/** Warn once per unknown model name — specForModel is a hot path (every request). IK5VGJ */
const warnedModels = new Set()

/** Look up spec by model name prefix (case-insensitive), conservative default for unknown models */
export function specForModel(model) {
  const m = (model ?? "").toLowerCase()
  for (const [prefix, spec] of [...MODEL_SPECS].sort((a, b) => b[0].length - a[0].length)) {
    if (m.startsWith(prefix.toLowerCase())) return spec
  }
  // Unknown model: warn ONCE (not per request) so a typo'd ID or a missing alias surfaces
  // instead of silently degrading to the 128K default (IK5VGJ).
  if (m && !warnedModels.has(m)) {
    warnedModels.add(m)
    console.warn(`[config] model "${model}" not found in MODEL_SPECS — using default spec (128K context, 32K output). Check the model ID or add an alias.`)
  }
  return DEFAULT_SPEC
}

/** Return the context window size for a given model name */
export function contextWindowForModel(model) {
  return specForModel(model).context
}

/**
 * Context utilization percentage: provider-reported prompt tokens vs the model's
 * spec context window. Null when there is no token data. (The spec field is
 * `context` — a `contextWindow` read would silently fall back to 128K and show
 * absurd percentages on 1M-context models.)
 */
export function ctxPercentForModel(promptTokens, model) {
  if (!promptTokens) return null
  return Math.round((promptTokens / contextWindowForModel(model)) * 100)
}
