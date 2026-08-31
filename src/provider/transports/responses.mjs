/**
 * provider/transports/responses.mjs — OpenAI Responses API transport（2026-08-31，CLI PROVIDER.md §13 同规格）
 *
 * TRANSPORTS 对象模式：{ normalizeTools, buildRequest, parseStream }。
 * 双轨链（provider._responsesChain 由 provider.mjs chat() 推进）：
 *  - 链模式（stateful，host 白名单驱动）：同一 turn 内工具往返用 previous_response_id
 *    增量（只发未发送的 function_call_output）；跨 turn/压缩/换模型 chainKey 不匹配 → 全量。
 *  - DeepSeek/GLM 等灰名单：显式全量 + 一次性 warning（官方明说不支持参数被静默忽略
 *    ——发链只会丢上下文）。
 * 事件流：流以 response.completed/incomplete/failed 结束，无 "data: [DONE]"。
 */

import { specForModel } from "../../specs.mjs"

/** 白名单：已实证 previous_response_id 的官方端（2026-08-31 官方文档核实）。 */
function isStatefulHost(baseURL) {
  try {
    const host = new URL(baseURL).hostname
    return /(^|\.)openai\.com$/.test(host)
      || host.includes("dashscope.aliyuncs.com") || host.includes(".maas.aliyuncs.com")
  } catch {
    return false
  }
}

/** 灰名单：格式完整但链未证实/不支持——显式全量 + 一次警告。 */
function isNonStatefulHost(baseURL) {
  try {
    const host = new URL(baseURL).hostname
    return /(^|\.)deepseek\.com$/.test(host) || /(^|\.)bigmodel\.cn$/.test(host)
  } catch {
    return false
  }
}

/** 链 key：system 部分 + 最后一条 user 消息（turn 内不变、跨 turn 变、压缩后变）。 */
function chainKey(messages) {
  let sig = "s:"
  let lastUser = ""
  for (const m of messages ?? []) {
    if (m.role === "system") sig += (typeof m.content === "string" ? m.content : "") + "\u0001"
    else if (m.role === "user") lastUser = typeof m.content === "string" ? m.content : ""
  }
  return sig + "\u0002u:" + lastUser
}

export function normalizeTools(tools) {
  return (tools ?? []).map((t) => ({
    type: "function",
    name: t.function?.name ?? t.name,
    description: t.function?.description ?? t.description,
    parameters: t.function?.parameters ?? t.parameters ?? { type: "object", properties: {} },
  }))
}

/** 内置工具声明（2026-08-31 用户拍板，一期 web_search；CLI 同规格）。
 *  provider.builtinTools === false 关闭、数组显式覆盖；服务端执行（绕过本地权限门/审计）。 */
function builtinToolsFor(baseURL, providerBuiltin) {
  if (providerBuiltin === false) return []
  if (Array.isArray(providerBuiltin)) return providerBuiltin
  try {
    const host = new URL(baseURL).hostname
    if (/(^|\.)openai\.com$/.test(host) || host.includes("dashscope.aliyuncs.com") || host.includes(".maas.aliyuncs.com") || /(^|\.)deepseek\.com$/.test(host)) {
      return [{ type: "web_search" }]
    }
  } catch { /* fallthrough */ }
  return []
}

function toItems(messages) {
  const items = []
  for (const m of messages ?? []) {
    if (m.role === "system") continue
    if (typeof m.tool_call_id === "string" && m.tool_call_id.startsWith("web_search_call_") && typeof m.content === "string") {
      // 内置工具结果本地化消息 → 原样 web_search_call item 回传（服务端自动恢复搜索结果）
      let query = ""
      let srcs = []
      try {
        const parsed = JSON.parse(m.content)
        query = parsed.query ?? ""
        srcs = parsed.sources ?? []
      } catch { /* 非 JSON 纯展示 → query 缺省 */ }
      items.push({ type: "web_search_call", id: m.tool_call_id, status: "completed", action: { query, type: "search", sources: srcs } })
      continue
    }
    if (m.role === "user") {
      const content = m.content
      items.push(Array.isArray(content)
        ? {
            role: "user",
            content: content
              .map((p) => (p?.type === "image_url"
                ? { type: "input_image", image_url: p.image_url?.url }
                : p?.type === "text" || typeof p === "string"
                  ? { type: "input_text", text: typeof p === "string" ? p : p.text }
                  : null))
              .filter(Boolean),
          }
        : { role: "user", content: [{ type: "input_text", text: String(content ?? "") }] })
    } else if (m.role === "assistant") {
      items.push({ role: "assistant", content: [{ type: "output_text", text: String(m.content ?? "") }] })
      for (const tc of m.tool_calls ?? []) {
        items.push({
          type: "function_call",
          call_id: tc.id ?? "",
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "{}",
        })
      }
    } else if (m.role === "tool" || m.role === "function") {
      items.push({
        type: "function_call_output",
        call_id: m.tool_call_id ?? m.name ?? "",
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      })
    }
  }
  return items
}

/**
 * buildRequest（TRANSPORTS 约定：返回 { url, headers, body }）。
 * 链决策元数据放在返回对象的 _chainMeta（非序列化字段，chat() 读取推进链）。
 */
export function buildRequest(provider, messages, tools, { toolChoice, stateful } = {}) {
  const items = toItems(messages ?? [])
  const spec = specForModel(provider.model)
  const warnings = []
  const wantStateful = provider.stateful !== false && stateful !== false
  const hostStateful = isStatefulHost(provider.baseURL)
  const hostNonStateful = isNonStatefulHost(provider.baseURL)

  let chain = provider._responsesChain ?? null
  const key = chainKey(messages)

  if (hostNonStateful && !stateful) {
    if (wantStateful) warnings.push({ name: "responses-stateful-unsupported", message: "endpoint 未实证支持 previous_response_id；已发送全量上下文" })
    chain = null
  } else if (chain && chain.key !== key) {
    chain = null
  } else if (chain && !hostStateful && !stateful) {
    chain = null
  }

  const body = {
    model: provider.model,
    input: items,
    stream: true,
    store: false,
  }
  // 内置工具声明追加（2026-08-31 用户拍板）：web_search 与本地 function 工具共存
  const builtin = builtinToolsFor(provider.baseURL, provider.builtinTools)
  if (builtin.length) body.tools = [...(tools ?? []), ...builtin]
  const instructions = (messages ?? []).find((m) => m.role === "system")?.content
  if (instructions) body.instructions = typeof instructions === "string" ? instructions : JSON.stringify(instructions)
  if (provider.maxTokens) body.max_output_tokens = provider.maxTokens
  else if (spec.maxOutput) body.max_output_tokens = spec.maxOutput
  if (provider.temperature != null) body.temperature = spec.tempRange
    ? Math.min(spec.tempRange[1], Math.max(spec.tempRange[0], provider.temperature))
    : provider.temperature
  if (provider.reasoningEffort) body.reasoning = { effort: provider.reasoningEffort }
  if (toolChoice !== undefined) body.tool_choice = toolChoice

  // 链模式增量：只发未发送的 function_call_output（工具结果）；assistant 的 function_call
  // item 与服务端链输出重复，不发。
  const outputs = items.filter((i) => i.type === "function_call_output")
  let previousResponseId = null
  let chainMeta = null
  if (chain && chain.id) {
    const newOutputs = outputs.slice(chain.outputSent ?? 0)
    if (newOutputs.length > 0) {
      body.input = newOutputs
      previousResponseId = chain.id
    } else {
      body.input = items // 无新增（重复调用/重试）：退化为全量
      previousResponseId = null
    }
  }
  if (wantStateful && (hostStateful || stateful)) {
    chainMeta = chain?.id
      ? { ...chain, key, outputSent: outputs.length }
      : { id: null, key, outputSent: outputs.length }
  }
  return {
    url: `${provider.baseURL}/responses`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body),
    _chainMeta: chainMeta,
    _warnings: warnings,
    _previousResponseId: previousResponseId,
  }
}

/** Responses usage → 内部 cache 字段形状。 */
function normalizeUsage(usage) {
  if (!usage) return null
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    prompt_cache_hit_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
    prompt_cache_miss_tokens: usage.input_tokens ?? 0,
  }
}

/**
 * parseStream（TRANSPORTS 约定：{ content, reasoning, toolCalls, usage, finishReason }）。
 * 额外返回 responseId（completed 事件）——chat() 据此推进链。
 */
export async function parseStream(response, { onToken, onReasoning, signal } = {}) {
  const result = { content: "", reasoning: "", toolCalls: [], usage: null, finishReason: null }
  result.builtinToolResults = [] // 内置工具（web_search_call）结果 —— agent 层本地化为 tool 消息
  const slots = new Map() // call_id → { id, name, arguments }
  const itemToCall = new Map() // item_id → call_id
  const order = []

  const seal = (finalResponse) => {
    result.toolCalls = order.map((c) => slots.get(c)).filter(Boolean)
    if (finalResponse?.usage) result.usage = normalizeUsage(finalResponse.usage)
    if (finalResponse?.id) result.responseId = finalResponse.id
    return result
  }

  const decoder = new TextDecoder()
  let buffer = ""
  let sealed = false
  const reader = response.body.getReader()
  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n")
      if (!data) continue
      let ev
      try { ev = JSON.parse(data) } catch { continue }
      switch (ev.type) {
        case "response.output_item.added": {
          const item = ev.item ?? {}
          if (item.type === "function_call") {
            const callId = item.call_id ?? item.id ?? ""
            if (!slots.has(callId)) { slots.set(callId, { id: callId, name: item.name ?? "", arguments: "" }); order.push(callId) }
            if (item.id) itemToCall.set(item.id, callId)
          }
          break
        }
        case "response.output_text.delta":
          onToken?.(ev.delta ?? "")
          result.content += ev.delta ?? ""
          break
        case "response.reasoning_text.delta":
          onReasoning?.(ev.delta ?? "")
          result.reasoning += ev.delta ?? ""
          break
        case "response.function_call_arguments.delta": {
          const callId = itemToCall.get(ev.item_id ?? "")
          const slot = callId ? slots.get(callId) : null
          if (slot) slot.arguments += ev.delta ?? ""
          break
        }
        case "response.output_item.done": {
          const item = ev.item ?? {}
          if (item.type === "function_call") {
            const slot = slots.get(item.call_id ?? item.id ?? "")
            if (slot && item.arguments && item.arguments !== slot.arguments) slot.arguments = item.arguments
          } else if (item.type === "web_search_call") {
            result.builtinToolResults.push({
              id: item.id ?? "",
              query: item.action?.query ?? "",
              status: item.status ?? "completed",
              sources: item.action?.sources ?? [],
            })
          }
          break
        }
        case "response.completed":
          seal(ev.response); sealed = true
          break
        case "response.incomplete":
          seal(ev.response); sealed = true
          result.finishReason = "length"
          break
        case "response.failed": {
          const err = ev.response?.error
          const e = new Error(`responses API failed: ${err?.message ?? JSON.stringify(err ?? {}).slice(0, 500)}`)
          e.status = err?.code
          throw e
        }
        default:
          break
      }
    }
  }
  if (!sealed) seal(null)
  return result
}
