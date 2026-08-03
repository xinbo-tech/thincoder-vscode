/**
 * config.mjs — Model capability specs (self-contained copy)
 * One source per spec row; `specForModel` matches by prefix (case-insensitive).
 *
 * Field reference:
 *   context:            context window size in tokens
 *   maxOutput:          max output tokens
 *   thinking:           model supports thinking mode (true/false)
 *   multimodal:         model supports image inputs
 *   prefixMode:         truncation protocol: uses prefix-based continuation
 *   partialMode:        truncation protocol: partially-available response
 *   cacheMode:          "auto" | "prompt" | "none"
 *   thinkApi:           "type"=thinking.type field | "effort"=reasoning_effort field
 *   reasoningEcho:      "required"=must echo | "optional"=optional (default: don't echo)
 *   reasoningEffortEnum: valid reasoning_effort values
 *   tempRange:          [min, max] temperature range
 */
const MODEL_SPECS = [
  // DeepSeek V4 series
  ["deepseek-v4-pro",   { context: 1_000_000, maxOutput: 384_000, thinking: true,  prefixMode: true,  cacheMode: "prompt", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["high", "max"], tempRange: [0, 2] }],
  ["deepseek-v4-flash", { context: 256_000,   maxOutput: 384_000, thinking: false, prefixMode: true,  cacheMode: "prompt", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["high", "max"], tempRange: [0, 2] }],
  ["deepseek-reasoner", { context: 256_000,   maxOutput: 384_000, thinking: true,  prefixMode: true,  cacheMode: "prompt", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["high", "max"], tempRange: [0, 2] }],
  ["deepseek-chat",     { context: 256_000,   maxOutput: 384_000, thinking: false, prefixMode: true,  cacheMode: "prompt", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["high", "max"], tempRange: [0, 2] }],
  // Kimi series
  ["kimi-k3",           { context: 1_000_000, maxOutput: 128_000, thinking: true,  partialMode: true, multimodal: true, cacheMode: "prompt", thinkApi: "effort", reasoningEcho: "required", reasoningEffortEnum: ["low", "high", "max"] }],
  ["kimi-k2",           { context: 256_000,   maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none" }],
  ["moonshot",          { context: 128_000,   maxOutput: 32_000,  thinking: false, cacheMode: "none" }],
  // GLM series
  ["glm-5.2",           { context: 1_000_000, maxOutput: 128_000, thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", reasoningEffortEnum: ["max", "xhigh", "high", "medium", "low", "minimal", "none"], tempRange: [0, 1], noUsageStream: true }],
  ["glm-5",             { context: 1_000_000, maxOutput: 128_000, thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", reasoningEffortEnum: ["max", "xhigh", "high", "medium", "low", "minimal", "none"], tempRange: [0, 1], noUsageStream: true }],
  ["glm-4",             { context: 128_000,   maxOutput: 32_000,  thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", tempRange: [0, 1], noUsageStream: true }],
  // GPT series
  ["gpt-4.1",           { context: 1_000_000, maxOutput: 128_000, thinking: false, cacheMode: "prompt" }],
  ["gpt-4o",            { context: 128_000,   maxOutput: 16_000,  thinking: false, multimodal: true, cacheMode: "prompt" }],
  // Claude series (Anthropic)
  ["claude-opus-4",     { context: 200_000,   maxOutput: 32_000,  thinking: false, multimodal: true, cacheMode: "none", format: "anthropic" }],
  ["claude-sonnet-4",   { context: 200_000,   maxOutput: 32_000,  thinking: false, multimodal: true, cacheMode: "none", format: "anthropic" }],
  ["claude-3.5-haiku",  { context: 200_000,   maxOutput: 8_192,   thinking: false, cacheMode: "none", format: "anthropic" }],
  // Gemini series (Google)
  ["gemini-2.5-pro",    { context: 2_000_000, maxOutput: 64_000,  thinking: false, multimodal: true, cacheMode: "none", format: "google", noUsageStream: true }],
  ["gemini-2.5-flash",  { context: 1_000_000, maxOutput: 64_000,  thinking: false, multimodal: true, cacheMode: "none", format: "google", noUsageStream: true }],
  // Qwen series
  ["qwen3.8-max-preview", { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", reasoningEffortEnum: ["xhigh", "medium", "low"], tempRange: [0, 2] }],
  // qwen3.7-max rejects image parts outright (DashScope 400 "Unexpected item type in content") — text-only.
  // CLI config.mjs marks it WITHOUT multimodal; keep in sync.
  ["qwen3.7-max",       { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen3.8-max",       { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen-max",          { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen-plus",         { context: 1_000_000, maxOutput: 32_000,  thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen",              { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  // MiniMax series
  ["MiniMax-M3",        { context: 1_000_000, maxOutput: 128_000, thinking: true,  multimodal: true, cacheMode: "auto", thinkApi: "type", thinkEnabledValue: "adaptive", tempRange: [0, 2], noUsageStream: true }],
  ["minimax-m3",        { context: 1_000_000, maxOutput: 128_000, thinking: true,  multimodal: true, cacheMode: "auto", thinkApi: "type", thinkEnabledValue: "adaptive", tempRange: [0, 2], noUsageStream: true }],
  ["minimax-m1",        { context: 256_000,   maxOutput: 128_000, thinking: false, cacheMode: "auto", noUsageStream: true }],
  // Grok series (xAI — OpenAI-compatible)
  ["grok-4",            { context: 1_000_000, maxOutput: 64_000,  thinking: false, multimodal: true, tempRange: [0, 2] }],
  ["grok-4-mini",       { context: 128_000,   maxOutput: 16_000,  thinking: false, tempRange: [0, 2] }],
  // Mistral series (OpenAI-compatible)
  ["mistral-large",     { context: 128_000,   maxOutput: 32_000,  thinking: false, multimodal: true, tempRange: [0, 2] }],
  ["codestral",         { context: 256_000,   maxOutput: 32_000,  thinking: false, tempRange: [0, 2] }],
]

const DEFAULT_SPEC = { context: 128_000, maxOutput: 32_000, cacheMode: "none" }

/** Look up spec by model name prefix (case-insensitive), conservative default for unknown models */
export function specForModel(model) {
  const m = (model ?? "").toLowerCase()
  for (const [prefix, spec] of [...MODEL_SPECS].sort((a, b) => b[0].length - a[0].length)) {
    if (m.startsWith(prefix.toLowerCase())) return spec
  }
  return DEFAULT_SPEC
}

/** Return the context window size for a given model name */
export function contextWindowForModel(model) {
  return specForModel(model).context
}
