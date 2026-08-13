/**
 * transports/anthropic.mjs — Anthropic Messages API transport (Claude)
 * Endpoint: POST https://api.anthropic.com/v1/messages
 * Docs: https://docs.anthropic.com/en/api/messages
 */

import { specForModel } from "../../specs.mjs"

const ANTHROPIC_VERSION = "2023-06-01"

/** Convert OpenAI-format tools to Anthropic format */
export function normalizeTools(tools) {
  return (tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }))
}

/** Build the HTTP request for Anthropic Messages API */
export function buildRequest(provider, messages, tools) {
  // Extract system message(s) — Anthropic uses a top-level `system` field
  const systemMessages = []
  const chatMessages = []
  for (const m of messages) {
    if (m.role === "system") {
      systemMessages.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content))
    } else {
      chatMessages.push(m)
    }
  }

  const body = {
    model: provider.model,
    messages: chatMessages,
    stream: true,
    max_tokens: provider.maxTokens || 8192,
  }
  if (systemMessages.length > 0) body.system = systemMessages.join("\n\n")
  if (provider.temperature != null) {
    const spec = specForModel(provider.model)
    let t = provider.temperature
    if (spec.tempRange) {
      t = Math.min(spec.tempRange[1], Math.max(spec.tempRange[0], t))
      t = Math.round(t * 100) / 100
    }
    body.temperature = t
  }
  if (tools?.length) body.tools = tools

  // Anthropic uses x-api-key header, not Bearer
  return {
    url: `${provider.baseURL}/messages`,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  }
}

/**
 * Parse Anthropic SSE stream (server-sent events).
 * Events: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
 */
export async function parseStream(response, { onToken, onReasoning, signal }) {
  const result = { content: "", reasoning: "", toolCalls: [], usage: null, finishReason: null }
  const decoder = new TextDecoder()
  let buffer = ""

  // Map block index → tool call accumulator
  const toolBlocks = new Map()

  const processEvent = (eventType, data) => {
    if (!data) return
    let json
    try { json = JSON.parse(data) } catch { return }

    switch (eventType) {
      case "message_start":
        if (json.message?.usage) result.usage = json.message.usage
        break
      case "content_block_start": {
        const block = json.content_block
        if (block?.type === "tool_use") {
          toolBlocks.set(json.index, { id: block.id, name: block.name, arguments: "" })
        }
        break
      }
      case "content_block_delta": {
        const delta = json.delta
        if (delta?.type === "text_delta" && delta.text) {
          result.content += delta.text
          onToken?.(delta.text)
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          result.reasoning += delta.thinking
          onReasoning?.(delta.thinking)
        } else if (delta?.type === "input_json_delta" && delta.partial_json) {
          const block = toolBlocks.get(json.index)
          if (block) block.arguments += delta.partial_json
        }
        break
      }
      case "message_delta":
        if (json.usage) result.usage = json.usage
        if (json.delta?.stop_reason) result.finishReason = json.delta.stop_reason === "end_turn" ? "stop" : json.delta.stop_reason
        break
      case "message_stop":
        // Final event — tool calls are complete
        for (const [, block] of toolBlocks) {
          result.toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.arguments,
          })
        }
        break
    }
  }

  if (!response.body) throw new Error("No stream response body")
  let currentEvent = ""
  let currentData = ""

  const abortErr = () => {
    const e = new DOMException("The operation was aborted", "AbortError")
    e.reason = signal?.reason
    return e
  }

  const readLoop = async () => {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw abortErr()
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop()

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          // Flush previous event
          if (currentEvent) processEvent(currentEvent, currentData)
          currentEvent = line.slice(7).trim()
          currentData = ""
        } else if (line.startsWith("data: ")) {
          currentData = line.slice(6).trim()
        } else if (line === "") {
          // Empty line = event separator
          if (currentEvent) processEvent(currentEvent, currentData)
          currentEvent = ""
          currentData = ""
        }
      }
    }
  }

  if (signal) {
    // Race the read loop against the abort — a Stop interrupts even a silent
    // stream (no chunks arriving) that the for-await would otherwise hang on.
    const abortPromise = new Promise((_, reject) => {
      const onAbort = () => reject(abortErr())
      signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([readLoop(), abortPromise])
    } catch (e) {
      // Interrupt (Ctrl+I): return the partial result so the agent loop commits it
      // and injects the user's message, instead of erroring the turn (CLI parity).
      if (e?.name === "AbortError" && signal.reason?.interrupt) {
        result.interrupted = true
        result.interruptMessage = signal.reason.message
        return result
      }
      throw e
    } finally {
      try { await response.body.cancel() } catch { /* normal completion — no-op */ }
    }
  } else {
    await readLoop()
  }

  // Flush remaining
  buffer += decoder.decode()
  for (const line of buffer.split("\n")) {
    if (line.startsWith("event: ")) {
      if (currentEvent) processEvent(currentEvent, currentData)
      currentEvent = line.slice(7).trim()
      currentData = ""
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6).trim()
    }
  }
  if (currentEvent) processEvent(currentEvent, currentData)

  return result
}
