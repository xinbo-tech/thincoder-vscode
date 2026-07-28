/**
 * smoke-provider.mjs — Direct connection test for each provider
 * Usage: node test/smoke-provider.mjs <provider-name> <api-key>
 *
 * Dumps raw response headers, raw SSE lines, and parsed result.
 * Does NOT import any VS Code modules — pure Node.js.
 */

import { chat } from "../src/provider.mjs"

const PRESETS = {
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-pro", thinking: { type: "enabled" }, reasoningEffort: "max", maxTokens: 393216 },
  kimi:     { baseURL: "https://api.moonshot.cn/v1", model: "kimi-k3", reasoningEffort: "max", maxTokens: 131072 },
  glm:      { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", thinking: { type: "enabled" }, maxTokens: 128000 },
  qwen:     { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max", maxTokens: 131072 },
  minimax:  { baseURL: "https://api.minimax.chat/v1", model: "MiniMax-M3", chatPath: "/text/chatcompletion_v2", maxTokens: 128000 },
  openai:   { baseURL: "https://api.openai.com/v1", model: "gpt-4o" },
}

const name = process.argv[2]
const apiKey = process.argv[3]

if (!name || !apiKey) {
  console.error("Usage: node test/smoke-provider.mjs <name> <api-key>")
  console.error("  names: " + Object.keys(PRESETS).join(" | "))
  process.exit(1)
}
const preset = PRESETS[name]
if (!preset) { console.error(`Unknown: ${name}. Valid: ${Object.keys(PRESETS).join(" ")}`); process.exit(1) }

const provider = {
  baseURL: preset.baseURL,
  apiKey,
  model: preset.model,
  maxTokens: preset.maxTokens,
  ...(preset.thinking ? { thinking: preset.thinking } : {}),
  ...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {}),
  ...(preset.chatPath ? { chatPath: preset.chatPath } : {}),
}

console.log("=== Provider ===")
console.log(JSON.stringify({ ...provider, apiKey: "***" }, null, 2))

const messages = [{ role: "user", content: "Say hello in exactly one sentence." }]

console.log("\n=== Sending request ===")
const start = Date.now()
try {
  const result = await chat(provider, {
    messages,
    tools: [],
    onToken: (t) => process.stdout.write(t),
    onReasoning: (r) => process.stderr.write(`\n[reasoning] ${r.slice(0, 200)}`),
  })
  console.log(`\n\n=== Result (${Date.now() - start}ms) ===`)
  console.log("content:", result.content?.slice(0, 500))
  console.log("reasoning:", result.reasoning?.slice(0, 200) || "(none)")
  console.log("finishReason:", result.finishReason)
  console.log("toolCalls:", result.toolCalls?.length ?? 0)
  console.log("usage:", JSON.stringify(result.usage))
  console.log("\n✓ OK")
} catch (e) {
  console.log(`\n=== Error (${Date.now() - start}ms) ===`)
  console.log(e.message)
  if (e.stack) console.log("\nStack:", e.stack)
  process.exit(1)
}
